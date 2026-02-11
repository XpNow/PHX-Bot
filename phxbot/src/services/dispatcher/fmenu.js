import { ActionRowBuilder, ButtonStyle, MessageFlags } from "discord.js";
import * as repo from "../../db/repo.js";
import { getSetting } from "../../db/db.js";
import { hasRole, parseUserIds, humanKind } from "../../util/access.js";
import { makeEmbed, btn, rowsFromButtons, select, modal, input } from "../../ui/ui.js";
import { COLORS } from "../../ui/theme.js";

import {
  now,
  PK_MS,
  DAY_MS,
  LEGAL_MIN_DAYS,
  sendEphemeral,
  makeBrandedEmbed,
  audit,
  formatRel,
  roleCheck,
  withUserLock,
  safeRoleAdd,
  safeRoleRemove,
  getOrgRank,
  canManageTargetRank,
  canSetRank,
  showModalSafe,
  fetchMembersWithRetry
} from "./shared.js";

function transferCooldownMs(ctx) {
  const raw = Number(getSetting(ctx.db, "transfer_cooldown_ms"));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : (60 * 60 * 1000);
}

function transferCooldownMsForOrg(ctx, org) {
  const days = Number(org?.transfer_cooldown_days);
  if (Number.isFinite(days) && days > 0) return Math.floor(days * DAY_MS);
  return transferCooldownMs(ctx);
}

function orgSwitchCooldownMs(ctx) {
  const raw = Number(getSetting(ctx.db, "org_switch_cooldown_ms"));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : (3 * 60 * 60 * 1000);
}

function pkCooldownMsForOrg(ctx, org) {
  const days = Number(org?.pk_cooldown_days);
  if (Number.isFinite(days) && days > 0) return Math.floor(days * DAY_MS);
  return PK_MS;
}

function parseOrgRoleIds(org) {
  const extras = String(org?.extra_role_ids || "")
    .split(/[\s,]+/g)
    .map(s => s.trim())
    .filter(s => /^\d{5,25}$/.test(s));
  return Array.from(new Set([
    org?.member_role_id,
    org?.leader_role_id,
    org?.co_leader_role_id,
    ...extras
  ].filter(Boolean).map(String)));
}

function noCooldownExempt(org, membership, type) {
  if (!org || String(org.kind).toUpperCase() !== "LEGAL") return false;
  const threshold = Number(org.no_cooldown_after_days);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  const since = Number(membership?.since_ts || 0);
  if (!since) return false;
  const stayedDays = Math.floor((now() - since) / DAY_MS);
  if (stayedDays < threshold) return false;
  const types = String(org.no_cooldown_types || "")
    .split(/[\s,]+/g)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  if (!types.length) return false;
  return types.includes("BOTH") || types.includes(type);
}

const ROSTER_CACHE_MS = 30 * 1000;
const rosterCache = new Map();

function randomLetters(len = 3) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function generateTransferId(ctx) {
  for (let i = 0; i < 20; i++) {
    const candidate = randomLetters(3);
    if (!repo.getTransferRequest(ctx.db, candidate)) return candidate;
  }
  return randomLetters(3);
}

function effectiveIllegalCap(org) {
  if (!org) return null;
  if (String(org.kind).toUpperCase() !== "ILLEGAL") return null;
  const cap = Number(org.member_cap);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 30;
}

function countOrgMembers(ctx, org) {
  const dbCount = repo.listMembersByOrg(ctx.db, org.id).length;
  const memberRole = org.member_role_id ? ctx.guild.roles.cache.get(org.member_role_id) : null;
  const discordCount = memberRole ? memberRole.members.filter(m => !m.user?.bot).size : 0;
  return Math.max(dbCount, discordCount);
}

function resolveManageableOrgs(ctx) {
  const orgs = repo.listOrgs(ctx.db);
  const manageable = [];
  for (const o of orgs) {
    const hasMemberRole = hasRole(ctx.member, o.member_role_id);
    const isLeader = hasRole(ctx.member, o.leader_role_id);
    const isCo = o.co_leader_role_id ? hasRole(ctx.member, o.co_leader_role_id) : false;
    if (hasMemberRole && (isLeader || isCo)) {
      manageable.push({ org: o, role: isLeader ? "LEADER" : "COLEADER" });
    }
  }
  return manageable;
}

async function resolveOrgForAddSlash(interaction, ctx) {
  const manageable = resolveManageableOrgs(ctx);
  if (manageable.length === 1) return manageable[0].org.id;

  if (manageable.length === 0) {
    const msg = ctx.perms.staff
      ? "Nu ai o organizație setată ca Lider/Co-Lider. Pentru a adăuga membri în orice organizație folosește **/famenu**."
      : "Nu ai permisiuni de Lider/Co-Lider pentru a folosi această comandă.";
    await interaction.editReply({ embeds: [makeBrandedEmbed(ctx, "⛔ Acces refuzat", msg)] });
    return null;
  }

  await interaction.editReply({
    embeds: [makeBrandedEmbed(ctx, "Alege organizația", "Ai acces la mai multe organizații. Comanda /add nu poate ghici unde să adauge. Folosește **/fmenu** și apasă **Add membru** din organizația corectă.")]
  });
  return null;
}

function resolveOrgForRmvSlash(ctx, targetMember) {
  const orgs = repo.listOrgs(ctx.db);
  const mem = repo.getMembership(ctx.db, String(targetMember.id));
  let orgId = mem?.org_id ? Number(mem.org_id) : null;

  if (!orgId) {
    const hits = orgs.filter(o => o?.member_role_id && hasRole(targetMember, o.member_role_id));
    if (hits.length === 1) orgId = hits[0].id;
    else if (hits.length > 1) {
      return {
        orgId: null,
        msg: "Userul pare să fie în mai multe organizații (roluri multiple). Folosește **/fmenu** și scoate-l din organizația corectă."
      };
    }
  }

  if (!orgId) {
    return {
      orgId: null,
      msg: "Userul nu este într-o organizație (nu există membership și nu are rol de organizație)."
    };
  }

  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    return {
      orgId: null,
      msg: "Organizația userului nu există în DB (posibil configurare ștearsă). Folosește **/famenu** pentru verificare."
    };
  }

  if (!ctx.perms.staff) {
    const manageable = resolveManageableOrgs(ctx).some(m => m.org.id === orgId);
    if (!manageable) {
      return {
        orgId: null,
        msg: `Userul nu este în organizația ta. El este în: **${(org && org.name) ? org.name : orgId}**.`
      };
    }
  }

  return { orgId, msg: null };
}

async function fetchTargetMember(ctx, userId) {
  if (!userId) return null;
  return await ctx.guild.members.fetch(String(userId)).catch(() => null);
}

async function fmenuHome(interaction, ctx) {
  const manageable = resolveManageableOrgs(ctx);

  if (manageable.length === 0) {
    const orgs = repo.listOrgs(ctx.db);
    const hasMemberRole = orgs.some(o => hasRole(ctx.member, o.member_role_id));
    if (hasMemberRole) {
      return sendEphemeral(
        interaction,
        "⛔ Nu ai permisiuni",
        "⛔ Nu ai permisiuni de Lider/Co-Lider pentru a folosi /fmenu."
      );
    }
    if (ctx.perms.staff) {
      return sendEphemeral(
        interaction,
        "Nu ai rol de organizație",
        "Nu ești setat într-o organizație încă. Pentru configurare (organizații, roluri, canale) folosește **/famenu**."
      );
    }
    return sendEphemeral(
      interaction,
      "⛔ Nu ai permisiuni",
      "Ai nevoie de rolurile de **Lider** sau **Co-Lider** (și rolul organizației) ca să folosești **/fmenu**."
    );
  }

  if (manageable.length === 1) {
    return orgPanelView(interaction, ctx, manageable[0].org.id);
  }

  const options = manageable.map(m => ({
    label: `${m.org.name} (${humanKind(m.org.kind)})`,
    value: String(m.org.id),
    description: "Deschide meniul organizației"
  }));

  const emb = makeEmbed("Selectează organizația", "Ai acces la mai multe organizații. Alege una pentru a continua.");
  const menu = select("fmenu:pickorg", "Selectează organizația…", options);
  const row = new ActionRowBuilder().addComponents(menu);
  return sendEphemeral(interaction, emb.data.title, emb.data.description, [row]);
}

async function orgPanelView(interaction, ctx, orgId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    return sendEphemeral(interaction, "Eroare", "Organizația nu a fost găsită (posibil coruptă).");
  }

  const manageable = resolveManageableOrgs(ctx).find(m => m.org.id === orgId);
  if (!manageable && !ctx.perms.staff) {
    return sendEphemeral(interaction, "⛔ Acces refuzat", "Nu ai acces la această organizație.");
  }

  const dbCount = repo.listMembersByOrg(ctx.db, orgId).length;
  const memberRole = org.member_role_id ? ctx.guild.roles.cache.get(org.member_role_id) : null;
  const discordCount = memberRole ? memberRole.members.size : 0;
  const emb = makeEmbed(
    `${org.name}`,
    `Tip: **${humanKind(org.kind)}**\nMembri: **${dbCount}**\n\nAlege o acțiune:`
  );

  const actorRank = getOrgRank(ctx.member, org);
  const canSetRanks = ctx.perms.staff || actorRank === "LEADER";
  const buttons = [
    btn(`org:${orgId}:remove_pk`, "Remove (PK)", ButtonStyle.Danger, "💀"),
    btn(`org:${orgId}:add`, "Add membru", ButtonStyle.Success, "➕"),
    btn(`org:${orgId}:remove`, "Remove membru", ButtonStyle.Secondary, "➖"),
    btn(`org:${orgId}:roster`, "Roster", ButtonStyle.Secondary, "📋"),
    btn(`org:${orgId}:search`, "Search", ButtonStyle.Secondary, "🔎"),
    btn(`org:${orgId}:transfer`, "Transfer", ButtonStyle.Secondary, "🔁"),
    btn(`org:${orgId}:transfers`, "Transfers", ButtonStyle.Secondary, "📨"),
    canSetRanks ? btn(`org:${orgId}:setrank`, "Set rank", ButtonStyle.Secondary, "🪪") : null,
    String(org.kind).toUpperCase() === "LEGAL" ? btn(`org:${orgId}:delegations`, "Permisiuni", ButtonStyle.Secondary, "🛂") : null,
    btn(`fmenu:back`, "Back", ButtonStyle.Secondary, "⬅️"),
  ];

  const rows = rowsFromButtons(buttons.filter(Boolean));
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rows);
}

function addMembersModal(orgId) {
  return modal(`org:${orgId}:add_modal`, "Add membri", [
    input("users", "User ID-uri (multi-line)", 2, true, "Ex:\n123..."),
  ]);
}

function removeMembersModal(orgId, pk) {
  return modal(`org:${orgId}:${pk?'remove_pk':'remove'}_modal`, pk ? "Remove (PK)" : "Remove", [
    input("users", "User ID-uri (multi-line)", 2, true, "Ex:\n123..."),
  ]);
}

function searchModal(orgId) {
  return modal(`org:${orgId}:search_modal`, "Search player", [
    input("user", "User ID", undefined, true, "Ex: 123..."),
  ]);
}

function setRankModal(orgId) {
  return modal(`org:${orgId}:setrank_modal`, "Setează rank", [
    input("user", "User ID", undefined, true, "Ex: 123..."),
    input("rank", "Rank (MEMBER/LEADER/COLEADER)", undefined, true, "Ex: COLEADER")
  ]);
}

function delegateAddModal(orgId) {
  return modal(`org:${orgId}:delegate_add_modal`, "Adaugă delegat", [
    input("user", "User ID/mention", undefined, true, "Ex: @user"),
    input("can_demote", "Poate demota Co-Leader? (DA/NU)", undefined, true, "NU")
  ]);
}

function delegateRemoveModal(orgId) {
  return modal(`org:${orgId}:delegate_remove_modal`, "Șterge delegat", [
    input("user", "User ID/mention", undefined, true, "Ex: @user")
  ]);
}

async function delegationsView(interaction, ctx, orgId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) return sendEphemeral(interaction, "Eroare", "Organizația nu există.");
  const rank = getOrgRank(ctx.member, org);
  if (!ctx.perms.staff && rank !== "LEADER") {
    return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar Leader-ul (sau staff) poate gestiona delegări.");
  }
  const rows = repo.listOrgDelegates(ctx.db, orgId);
  const desc = rows.length
    ? rows.slice(0, 20).map(r => `• <@${r.user_id}> — promote co-leader: **${Number(r.can_promote_coleader) ? "DA" : "NU"}** | demote: **${Number(r.can_demote_coleader) ? "DA" : "NU"}**`).join("\n")
    : "Nu există delegați.";
  const emb = makeEmbed(`Delegări • ${org.name}`, desc);
  const buttons = [
    btn(`org:${orgId}:delegate_add`, "Adaugă", ButtonStyle.Success, "➕"),
    btn(`org:${orgId}:delegate_remove`, "Șterge", ButtonStyle.Danger, "🗑️"),
    btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

function transferRequestModal(orgId) {
  return modal(`org:${orgId}:transfer_modal`, "Request transfer", [
    input("user", "User ID", undefined, true, "Ex: 123..."),
    input("to_org", "Org destinație (rol sau nume)", undefined, true, "Ex: @Ballas / Ballas")
  ]);
}

function transferDecisionModal(orgId, action) {
  const label = action === "approve" ? "Aprobă transfer" : "Respinge transfer";
  return modal(`org:${orgId}:transfer_${action}_modal`, label, [
    input("request_id", "Transfer ID", undefined, true, "Ex: JWY")
  ]);
}

function normalizeDesiredRank(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;

  const cleaned = s
    .replace(/\s+/g, "_")
    .replace(/-/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (cleaned === "MEMBRU" || cleaned === "MEMBER") return "MEMBER";
  if (cleaned === "LIDER" || cleaned === "LEADER") return "LEADER";

  if (
    cleaned === "COLEADER" ||
    cleaned === "CO_LEADER" ||
    cleaned === "COLIDER" ||
    cleaned === "CO_LIDER" ||
    cleaned === "CO_LDR" ||
    cleaned === "CO_LEAD"
  ) return "COLEADER";

  return null;
}

function prettyRank(rank) {
  if (rank === "COLEADER") return "CO-LEADER";
  return String(rank || "—");
}

async function addToOrg(ctx, targetMember, orgId, role) {
  return withUserLock(targetMember.id, async () => {  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[ADD] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }

  const activeTransfer = repo.findActiveTransferByUser(ctx.db, targetMember.id);
  if (activeTransfer) {
    return { ok:false, msg:"Userul are un transfer în curs. Așteaptă finalizarea înainte de a-l adăuga." };
  }

  const orgs = repo.listOrgs(ctx.db);
  const otherOrgRoles = orgs
    .filter(o => o.id !== org.id && o.member_role_id && targetMember.roles.cache.has(o.member_role_id))
    .map(o => o.name);
  if (otherOrgRoles.length && !ctx.perms.staff) {
    return { ok:false, msg:`Userul are deja rol(uri) de organizație: ${otherOrgRoles.join(", ")}.` };
  }

  const existing = repo.getMembership(ctx.db, targetMember.id);
  if (existing) {
    if (existing.org_id === orgId) {
      return { ok:false, msg:"Userul este deja în această organizație." };
    }
    const existingOrg = repo.getOrg(ctx.db, existing.org_id);
    return { ok:false, msg:`Userul este deja într-o altă organizație (${existingOrg?.name ?? existing.org_id}).` };
  }

  const pk = repo.getCooldown(ctx.db, targetMember.id, "PK");
  const ban = repo.getCooldown(ctx.db, targetMember.id, "BAN");
  const orgSwitch = repo.getCooldown(ctx.db, targetMember.id, "ORG_SWITCH");
  if (ban && ban.expires_at > now()) {
    console.error(`[ADD] User ${targetMember.id} blocked by BAN cooldown`);
    return { ok:false, msg:"Userul este banat de la organizații (BAN)."};
  }
  if (pk && pk.expires_at > now()) {
    console.error(`[ADD] User ${targetMember.id} blocked by PK cooldown`);
    return { ok:false, msg:"Userul este în cooldown (PK)."};
  }
  if (orgSwitch && orgSwitch.expires_at > now()) {
    return { ok:false, msg:`Userul este în cooldown de transfer (expiră ${formatRel(orgSwitch.expires_at)}).` };
  }

  const cap = effectiveIllegalCap(org);
  if (cap) {
    const current = countOrgMembers(ctx, org);
    if (current + 1 > cap) {
      return { ok:false, msg:`Organizația **${org.name}** a atins capul de **${cap}** membri.` };
    }
  }

  if (ctx.settings.pkRole) await safeRoleRemove(targetMember, ctx.settings.pkRole, `Cleanup PK for ${targetMember.id}`);
  if (ctx.settings.banRole) await safeRoleRemove(targetMember, ctx.settings.banRole, `Cleanup BAN for ${targetMember.id}`);

  const orgRoleCheck = roleCheck(ctx, org.member_role_id, "membru");
  if (!orgRoleCheck.ok) return { ok:false, msg: orgRoleCheck.msg };
  const added = await safeRoleAdd(targetMember, org.member_role_id, `Add org role for ${targetMember.id}`);
  if (!added) return { ok:false, msg:"Nu pot adăuga rolul organizației (permisiuni lipsă)." };
  repo.upsertMembership(ctx.db, targetMember.id, orgId, role || "MEMBER");
  await audit(ctx, "➕ Membru adăugat", [
    `**Țintă:** <@${targetMember.id}> (\`${targetMember.id}\`)`,
    `**Organizație:** **${org.name}** (\`${orgId}\`)`,
    `**De către:** <@${ctx.uid}>`
  ].join("\n"), COLORS.SUCCESS);
  return { ok:true };
  });
}

async function removeFromOrg(ctx, targetMember, orgId, byUserId, { skipOrgSwitch = false } = {}) {
  return withUserLock(targetMember.id, async () => {  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[REMOVE] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }
// Safeguard: do NOT allow removing a Leader/Co-Leader directly.
// They must be downgraded to MEMBER first via Set rank.
const targetRank = getOrgRank(targetMember, org);
if (!ctx.perms.staff && (targetRank === "LEADER" || targetRank === "COLEADER")) {
  const pretty = targetRank === "LEADER" ? "LEADER" : "CO-LEADER";
  return { ok:false, msg:`Userul are rank **${pretty}**. Retrogradează-l mai întâi la **MEMBER** din **Set rank**, apoi încearcă din nou.` };
}

// If staff removes directly, also cleanup leader/co-leader roles to avoid leftovers.
if (ctx.perms.staff) {
  const leadershipRoleIds = [org.leader_role_id, org.co_leader_role_id].filter(Boolean);
  for (const rid of leadershipRoleIds) {
    if (!targetMember.roles.cache.has(rid)) continue;
    const check = roleCheck(ctx, rid, "organizație");
    if (!check.ok) return { ok:false, msg: check.msg };
    const removedLead = await safeRoleRemove(targetMember, rid, `Remove leadership role ${rid} for ${targetMember.id}`);
    if (!removedLead) return { ok:false, msg:"Nu pot elimina rolurile de Leader/Co-Leader (permisiuni lipsă)." };
  }
}

  const canManage = canManageTargetRank(ctx, org, targetMember);
  if (!canManage.ok) return { ok:false, msg: canManage.msg };
  const orgRoleCheck = roleCheck(ctx, org.member_role_id, "membru");
  if (!orgRoleCheck.ok) return { ok:false, msg: orgRoleCheck.msg };
  if (!targetMember.roles.cache.has(org.member_role_id)) {
    return { ok:false, msg:"Userul nu este membru în această organizație." };
  }
  const removed = await safeRoleRemove(targetMember, org.member_role_id, `Remove org role for ${targetMember.id}`);
  if (!removed) return { ok:false, msg:"Nu pot elimina rolul organizației (permisiuni lipsă)." };
  const associatedRoleIds = parseOrgRoleIds(org).filter(rid => rid !== String(org.member_role_id));
  for (const rid of associatedRoleIds) {
    if (!targetMember.roles.cache.has(rid)) continue;
    const chk = roleCheck(ctx, rid, "rol asociat");
    if (!chk.ok) return { ok:false, msg: chk.msg };
    const rm = await safeRoleRemove(targetMember, rid, `Remove associated org role ${rid} for ${targetMember.id}`);
    if (!rm) return { ok:false, msg:"Nu pot elimina unul din rolurile asociate organizației." };
  }
  const prevMembership = repo.getMembership(ctx.db, targetMember.id);
  repo.removeMembership(ctx.db, targetMember.id);
  if (!skipOrgSwitch && !noCooldownExempt(org, prevMembership, "TRANSFER")) {
    const expiresAt = now() + transferCooldownMsForOrg(ctx, org);
    repo.upsertCooldown(ctx.db, targetMember.id, "ORG_SWITCH", expiresAt, orgId, now());
  }
  repo.upsertLastOrgState(ctx.db, targetMember.id, orgId, now(), byUserId);
  await audit(ctx, "🚪 Membru scos", [
    `**Țintă:** <@${targetMember.id}> (\`${targetMember.id}\`)`,
    `**Organizație:** **${org.name}** (\`${orgId}\`)`,
    `**De către:** <@${byUserId}>`
  ].join("\n"), COLORS.GLOBAL);
  return { ok:true };
  });
}

async function applyPk(ctx, targetMember, orgId, byUserId) {
  return withUserLock(targetMember.id, async () => {  const pkRole = ctx.settings.pkRole;
  if (!pkRole) {
    console.error("[PK] pk_role_id missing in settings");
    return { ok:false, msg:"PK role nu este setat." };
  }

  const existingPk = repo.getCooldown(ctx.db, targetMember.id, "PK");
  if (existingPk && existingPk.expires_at > now()) {
    return { ok:false, msg:"Userul este deja în cooldown (PK)." };
  }

  const org = repo.getOrg(ctx.db, orgId);
  if (org) {
    const inOrg = [org.member_role_id, org.leader_role_id, org.co_leader_role_id]
      .filter(Boolean)
      .some(rid => targetMember.roles.cache.has(rid));
    if (!inOrg) {
      await audit(ctx, "⛔ PK refuzat", [
        `**Țintă:** <@${targetMember.id}> (\`${targetMember.id}\`)`,
        `**Organizație:** **${org.name}** (\`${orgId}\`)`,
        `**Motiv:** userul nu are rolul organizației`,
        `**De către:** <@${byUserId}>`
      ].join("\n"), COLORS.ERROR);
      return { ok:false, msg:"Userul nu este în această organizație. Nu pot aplica PK." };
    }
    const canManage = canManageTargetRank(ctx, org, targetMember);
    if (!canManage.ok) return { ok:false, msg: canManage.msg };
// Safeguard: do NOT allow applying PK removal to a Leader/Co-Leader directly.
// They must be downgraded to MEMBER first via Set rank.
const targetRank = getOrgRank(targetMember, org);
if (!ctx.perms.staff && (targetRank === "LEADER" || targetRank === "COLEADER")) {
  const pretty = targetRank === "LEADER" ? "LEADER" : "CO-LEADER";
  await audit(ctx, "⛔ PK refuzat", [
    `**Țintă:** <@${targetMember.id}> (\`${targetMember.id}\`)`,
    `**Organizație:** **${org.name}** (\`${orgId}\`)`,
    `**Motiv:** userul este **${pretty}** (trebuie retrogradat la MEMBER înainte de remove/PK)`,
    `**De către:** <@${byUserId}>`
  ].join("\n"), COLORS.ERROR);
  return { ok:false, msg:`Userul are rank **${pretty}**. Retrogradează-l mai întâi la **MEMBER** din **Set rank**, apoi încearcă din nou.` };
}

    const roleIds = parseOrgRoleIds(org);
    for (const roleId of roleIds) {
      if (!targetMember.roles.cache.has(roleId)) continue;
      const check = roleCheck(ctx, roleId, "organizație");
      if (!check.ok) return { ok:false, msg: check.msg };
      const removed = await safeRoleRemove(targetMember, roleId, `PK remove org role ${roleId} for ${targetMember.id}`);
      if (!removed) return { ok:false, msg:"Nu pot elimina rolurile organizației (permisiuni lipsă)." };
    }
  } else {
    console.error(`[PK] Org not found for orgId ${orgId}`);
  }
  let durationMs = pkCooldownMsForOrg(ctx, org);
  let stayedDays = null;
  if (org?.kind === "LEGAL") {
    const membership = repo.getMembership(ctx.db, targetMember.id);
    if (membership?.org_id === orgId && typeof membership.since_ts === "number") {
      stayedDays = Math.max(0, Math.floor((now() - membership.since_ts) / DAY_MS));
      const remainingDays = LEGAL_MIN_DAYS - stayedDays;
      if (remainingDays > 0) {
        durationMs = remainingDays * DAY_MS;
      }
    }
  }

  const membership = repo.getMembership(ctx.db, targetMember.id);
  const exemptPk = noCooldownExempt(org, membership, "PK");
  const expiresAt = now() + durationMs;
  if (!exemptPk) repo.upsertCooldown(ctx.db, targetMember.id, "PK", expiresAt, orgId, now());
  repo.removeMembership(ctx.db, targetMember.id);
  repo.upsertLastOrgState(ctx.db, targetMember.id, orgId, now(), byUserId);

  if (!exemptPk) {
    const addedPk = await safeRoleAdd(targetMember, pkRole, `Apply PK for ${targetMember.id}`);
    if (!addedPk) return { ok:false, msg:"Nu pot aplica rolul PK (permisiuni lipsă)." };
  }
  await audit(ctx, "⏳ Remove + PK", [
    `**Țintă:** <@${targetMember.id}> (\`${targetMember.id}\`)`,
    `**Organizație:** **${org?.name ?? orgId}** (\`${orgId}\`)`,
    ...(stayedDays !== null ? [
      `**Regulă LEGAL:** durată ajustată la minimul de ${LEGAL_MIN_DAYS} zile`,
      `**Stat în org:** **${stayedDays}** zile`,
      `**Durată PK:** **${Math.ceil(durationMs / DAY_MS)}** zile`
    ] : []),
    `**PK:** ${exemptPk ? "scutit (policy org)" : `expiră ${formatRel(expiresAt)}`}`,
    `**De către:** <@${byUserId}>`
  ].join("\n"), COLORS.COOLDOWN);
  return { ok:true };
  });
}

async function setMemberRank(ctx, targetMember, orgId, desiredRank) {
  return withUserLock(targetMember.id, async () => {  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[RANK] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }
  const actorRank = getOrgRank(ctx.member, org);
  const delegate = repo.getOrgDelegate(ctx.db, orgId, ctx.uid);
  const canDelegatedColeg = String(org.kind).toUpperCase() === "LEGAL"
    && !!delegate
    && Number(delegate.can_promote_coleader) === 1
    && (desiredRank === "MEMBER" || desiredRank === "COLEADER" || desiredRank === "CO_LEADER");
  if (!ctx.perms.staff && actorRank !== "LEADER" && !canDelegatedColeg) {
    return { ok:false, msg:"Doar liderul (sau delegații pentru co-leader în org legală) poate schimba rank-urile." };
  }
  const rankCheck = canSetRank(ctx, org, desiredRank, targetMember, {
    delegated: canDelegatedColeg,
    canDemoteCoLeader: Number(delegate?.can_demote_coleader) === 1
  });
  if (!rankCheck.ok) return { ok:false, msg: rankCheck.msg };

  const memberRoleCheck = roleCheck(ctx, org.member_role_id, "membru");
  if (!memberRoleCheck.ok) return { ok:false, msg: memberRoleCheck.msg };
  if (!targetMember.roles.cache.has(org.member_role_id)) {
    const addedMember = await safeRoleAdd(targetMember, org.member_role_id, `Ensure org role for ${targetMember.id}`);
    if (!addedMember) return { ok:false, msg:"Nu pot adăuga rolul organizației (permisiuni lipsă)." };
    repo.upsertMembership(ctx.db, targetMember.id, orgId, "MEMBER");
  }

  const leaderRoleCheck = org.leader_role_id ? roleCheck(ctx, org.leader_role_id, "leader") : null;
  const coLeaderRoleCheck = org.co_leader_role_id ? roleCheck(ctx, org.co_leader_role_id, "co-leader") : null;
  if (org.leader_role_id && !leaderRoleCheck?.ok) return { ok:false, msg: leaderRoleCheck.msg };
  if (org.co_leader_role_id && !coLeaderRoleCheck?.ok) return { ok:false, msg: coLeaderRoleCheck.msg };

  if (desiredRank === "LEADER") {
    if (org.co_leader_role_id) {
      await safeRoleRemove(targetMember, org.co_leader_role_id, `Unset co-leader for ${targetMember.id}`);
    }
    const added = await safeRoleAdd(targetMember, org.leader_role_id, `Set leader for ${targetMember.id}`);
    if (!added) return { ok:false, msg:"Nu pot seta rolul de Leader (permisiuni lipsă)." };
  } else if (desiredRank === "COLEADER") {
    if (!org.co_leader_role_id) return { ok:false, msg:"Rolul de Co-Leader nu este setat." };
    if (!ctx.perms.staff) {
      const fetchRes = await fetchMembersWithRetry(ctx.guild, "RANK_CAP");
      if (!fetchRes.members) {
        const retryMsg = fetchRes.retryMs > 0
          ? `Discord rate limit. Încearcă din nou în ~${Math.ceil(fetchRes.retryMs / 1000)}s.`
          : (fetchRes.error || "Nu pot prelua membrii guild-ului.");
        return { ok:false, msg: retryMsg };
      }

      const alreadyCo = targetMember.roles.cache.has(org.co_leader_role_id);
      let discordCount = 0;
      const coLeaderRole = ctx.guild.roles.cache.get(org.co_leader_role_id);
      if (coLeaderRole) {
        discordCount = coLeaderRole.members.filter(m => !m.user?.bot).size;
      }

      const dbCount = repo
        .listMembersByOrg(ctx.db, orgId)
        .filter(r => {
          const role = String(r.role || "").toUpperCase();
          return role === "COLEADER" || role === "CO_LEADER";
        }).length;

      const current = Math.max(discordCount, dbCount);
      const cap = Number.isFinite(Number(org.co_leader_cap)) && Number(org.co_leader_cap) > 0
        ? Math.floor(Number(org.co_leader_cap))
        : (String(org.kind).toUpperCase() === "ILLEGAL" ? 2 : null);
      if (cap && !alreadyCo && current >= cap) {
        return { ok:false, msg:`Organizația a atins capul de **${cap}** roluri de **Co-Leader**.` };
      }
    }
if (org.leader_role_id) {
      await safeRoleRemove(targetMember, org.leader_role_id, `Unset leader for ${targetMember.id}`);
    }
    const added = await safeRoleAdd(targetMember, org.co_leader_role_id, `Set co-leader for ${targetMember.id}`);
    if (!added) return { ok:false, msg:"Nu pot seta rolul de Co-Leader (permisiuni lipsă)." };
  } else {
    if (org.leader_role_id) {
      await safeRoleRemove(targetMember, org.leader_role_id, `Unset leader for ${targetMember.id}`);
    }
    if (org.co_leader_role_id) {
      await safeRoleRemove(targetMember, org.co_leader_role_id, `Unset co-leader for ${targetMember.id}`);
    }
  }

  repo.upsertMembership(ctx.db, targetMember.id, orgId, desiredRank);

  await audit(ctx, "🎖️ Rank actualizat", [
    `**Țintă:** <@${targetMember.id}> (\`${targetMember.id}\`)`,
    `**Organizație:** **${org.name}** (\`${orgId}\`)`,
    `**Rank nou:** **${prettyRank(desiredRank)}**`,
    `**De către:** <@${ctx.uid}>`
  ].join("\n"), COLORS.GLOBAL);
  return { ok:true };
  });
}

async function requestTransfer(ctx, orgId, targetMemberId, toOrgId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) return { ok:false, msg:"Organizația nu există." };

  const toOrg = repo.getOrg(ctx.db, toOrgId);
  if (!toOrg) return { ok:false, msg:"Organizația destinație nu există." };

  if (!ctx.perms.staff) {
    const manageable = resolveManageableOrgs(ctx).some(m => m.org.id === orgId);
    if (!manageable) return { ok:false, msg:"Nu ai permisiuni pentru această organizație." };
  }

  const member = await ctx.guild.members.fetch(targetMemberId).catch(() => null);
  if (!member) return { ok:false, msg:"Userul nu este în guild." };

  const activeTransfer = repo.findActiveTransferByUser(ctx.db, targetMemberId);
  if (activeTransfer) return { ok:false, msg:"Userul are deja un transfer în curs." };

  const membership = repo.getMembership(ctx.db, targetMemberId);
  if (!membership || String(membership.org_id) !== String(orgId)) {
    return { ok:false, msg:"Userul nu este membru în organizația ta." };
  }
  if (String(toOrgId) === String(orgId)) {
    return { ok:false, msg:"Organizația destinație trebuie să fie diferită." };
  }

  if (String(org.kind).toUpperCase() !== String(toOrg.kind).toUpperCase()) {
    return { ok:false, msg:"Transferurile sunt permise doar între organizații de același tip (LEGAL↔LEGAL, ILLEGAL↔ILLEGAL)." };
  }

  const cap = effectiveIllegalCap(toOrg);
  if (cap) {
    const current = countOrgMembers(ctx, toOrg);
    if (current + 1 > cap) {
      return { ok:false, msg:`Organizația destinație a atins capul de **${cap}** membri.` };
    }
  }

  const requestId = generateTransferId(ctx);
  repo.createTransferRequest(ctx.db, {
    request_id: requestId,
    from_org_id: orgId,
    to_org_id: toOrgId,
    user_id: targetMemberId,
    status: "PENDING",
    requested_by: ctx.uid,
    created_at: now()
  });

  await audit(ctx, "🔁 Transfer solicitat", [
    `**Transfer ID:** \`${requestId}\``,
    `**Țintă:** <@${targetMemberId}> (\`${targetMemberId}\`)`,
    `**Din:** **${org.name}**`,
    `**Către:** **${toOrg.name}**`,
    `**De către:** <@${ctx.uid}>`
  ].join("\n"), COLORS.GLOBAL);

  return { ok:true, requestId, toOrgName: toOrg.name };
}

function resolveOrgByInput(ctx, input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, msg: "Org invalid." };

  const roleId = raw.replace(/[<@&#>]/g, "").trim();
  const orgs = repo.listOrgs(ctx.db);

  if (/^\d{5,25}$/.test(roleId)) {
    const byRole = orgs.find(o => String(o.member_role_id) === String(roleId));
    if (byRole) return { ok: true, org: byRole };
    const byId = orgs.find(o => String(o.id) === String(roleId));
    if (byId) return { ok: true, org: byId };
  }

  const needle = raw.toLowerCase();
  const matches = orgs.filter(o => String(o.name || "").toLowerCase().includes(needle));
  if (matches.length === 1) return { ok: true, org: matches[0] };
  if (matches.length > 1) {
    const sample = matches.slice(0, 5).map(o => `**${o.name}**`).join(", ");
    return { ok: false, msg: `Am găsit mai multe organizații: ${sample}. Fii mai specific.` };
  }

  return { ok: false, msg: "Nu pot găsi organizația. Folosește @rol sau numele exact." };
}

async function processTransferDecision(ctx, orgId, requestId, action) {
  const req = repo.getTransferRequest(ctx.db, requestId);
  if (!req) return { ok:false, msg:"Transfer ID invalid." };
  if (req.status !== "PENDING") return { ok:false, msg:"Transferul nu mai este în așteptare." };

  if (String(req.to_org_id) !== String(orgId)) {
    return { ok:false, msg:"Nu ai permisiuni pentru acest transfer." };
  }

  const toOrg = repo.getOrg(ctx.db, req.to_org_id);
  const fromOrg = repo.getOrg(ctx.db, req.from_org_id);
  if (!toOrg || !fromOrg) return { ok:false, msg:"Organizația din transfer nu există." };

  const rank = getOrgRank(ctx.member, toOrg);
  if (rank !== "LEADER" && rank !== "COLEADER") {
    return { ok:false, msg:"Nu ai permisiuni de Leader/Co-Leader pentru această organizație." };
  }

  if (action === "reject") {
    repo.updateTransferRequestStatus(ctx.db, requestId, "REJECTED", { approved_by: ctx.uid, approved_at: now() });
    await audit(ctx, "❌ Transfer respins", [
      `**Transfer ID:** \`${requestId}\``,
      `**Țintă:** <@${req.user_id}> (\`${req.user_id}\`)`,
      `**Din:** **${fromOrg.name}**`,
      `**Către:** **${toOrg.name}**`,
      `**De către:** <@${ctx.uid}>`
    ].join("\n"), COLORS.ERROR);
    return { ok:true };
  }

  const member = await ctx.guild.members.fetch(req.user_id).catch(() => null);
  if (!member) return { ok:false, msg:"Userul nu este în guild." };

  const failApprove = async (step, reason, details = "") => {
    repo.clearCooldown(ctx.db, member.id, "ORG_SWITCH");
    await audit(ctx, "❌ Transfer eșuat (rollback)", [
      `**Transfer ID:** \`${requestId}\``,
      `**Țintă:** <@${req.user_id}> (\`${req.user_id}\`)`,
      `**Pas eșuat:** **${step}**`,
      `**Motiv:** ${reason}`,
      details ? `**Detalii:** ${details}` : null,
      `**De către:** <@${ctx.uid}>`
    ].filter(Boolean).join("\n"), COLORS.ERROR);
    return { ok:false, msg:`Transfer eșuat la pasul \`${step}\`: ${reason}` };
  };

  const cap = effectiveIllegalCap(toOrg);
  if (cap) {
    const current = countOrgMembers(ctx, toOrg);
    if (current + 1 > cap) {
      return { ok:false, msg:`Organizația destinație a atins capul de **${cap}** membri.` };
    }
  }

  const cooldownExpiresAt = now() + transferCooldownMsForOrg(ctx, fromOrg);
  repo.upsertCooldown(ctx.db, member.id, "ORG_SWITCH", cooldownExpiresAt, fromOrg.id, now());

  if (ctx.settings.pkRole) {
    const transferCooldownRoleAdded = await safeRoleAdd(member, ctx.settings.pkRole, `Transfer cooldown role for ${member.id}`);
    if (!transferCooldownRoleAdded) {
      console.error(`[TRANSFER] Failed to apply cooldown role for ${member.id} on request ${requestId}`);
      return failApprove("apply_cooldown_role", "Nu pot aplica rolul de cooldown transfer (permisiuni lipsă).");
    }
  }

  const roleIds = parseOrgRoleIds(fromOrg);
  for (const rid of roleIds) {
    if (member.roles.cache.has(rid)) {
      const check = roleCheck(ctx, rid, "organizație");
      if (!check.ok) return failApprove("remove_source_roles", check.msg || "Role check failed");
      const removed = await safeRoleRemove(member, rid, `Transfer remove role ${rid} for ${member.id}`);
      if (!removed) return failApprove("remove_source_roles", "Nu pot elimina rolurile organizației (permisiuni lipsă).", `Role: <@&${rid}>`);
    }
  }

  repo.removeMembership(ctx.db, member.id);

  repo.upsertLastOrgState(ctx.db, member.id, fromOrg.id, now(), `TRANSFER:${requestId}`);
  repo.updateTransferRequestStatus(ctx.db, requestId, "APPROVED", {
    approved_by: ctx.uid,
    approved_at: now(),
    cooldown_expires_at: cooldownExpiresAt
  });

  await audit(ctx, "✅ Transfer aprobat", [
    `**Transfer ID:** \`${requestId}\``,
    `**Țintă:** <@${req.user_id}> (\`${req.user_id}\`)`,
    `**Din:** **${fromOrg.name}**`,
    `**Către:** **${toOrg.name}**`,
    `**Cooldown:** ${Math.ceil((cooldownExpiresAt - now()) / (60 * 1000))} min (expiră ${formatRel(cooldownExpiresAt)})`,
    `**De către:** <@${ctx.uid}>`
  ].join("\n"), COLORS.SUCCESS);

  return { ok:true };
}

async function rosterView(interaction, ctx, orgId, useEditReply = false, page = 1, useUpdate = false) {
  const PAGE_SIZE = 25;

  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    const emb = makeEmbed("Eroare", "Organizația nu există.");
    return useUpdate
      ? interaction.update({ embeds: [emb], components: [] })
      : (useEditReply
          ? interaction.editReply({ embeds: [emb], components: [] })
          : sendEphemeral(interaction, emb.data.title, emb.data.description));
  }

  if (!org.member_role_id) {
    const emb = makeEmbed("Eroare", "Organizația nu are setat rolul de membru.");
    return useUpdate
      ? interaction.update({ embeds: [emb], components: [] })
      : (useEditReply
          ? interaction.editReply({ embeds: [emb], components: [] })
          : sendEphemeral(interaction, emb.data.title, emb.data.description));
  }

  const memberRole = ctx.guild.roles.cache.get(org.member_role_id);
  if (!memberRole) {
    const emb = makeEmbed("Eroare", "Rolul de membru nu există pe server.");
    return useUpdate
      ? interaction.update({ embeds: [emb], components: [] })
      : (useEditReply
          ? interaction.editReply({ embeds: [emb], components: [] })
          : sendEphemeral(interaction, emb.data.title, emb.data.description));
  }

  const renderFromLines = (title, lines, missingOrgRoleCount) => {
    const total = lines.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);

    const start = (safePage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const shown = lines.slice(start, end);

    const countLine =
      `**Membri:** **${total}**` +
      (missingOrgRoleCount ? ` • ❌ Fără rol Discord: **${missingOrgRoleCount}**` : "");

    const listPart = shown.length ? shown.join("\n") : "Nu există membri în organizație (în DB).";
    const desc = `${countLine}\n\n${listPart}`;

    const emb = makeEmbed(title, desc, COLORS.GLOBAL);
    if (typeof emb.setFooter === "function") {
      emb.setFooter({ text: `Pagina ${safePage}/${totalPages}` });
    }

    const buttons = [];
    const prevDisabled = safePage <= 1;
    const nextDisabled = safePage >= totalPages;

    buttons.push(
      btn(`org:${orgId}:roster:${safePage - 1}`, "Prev", ButtonStyle.Secondary, "◀️", prevDisabled)
    );

    buttons.push(btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️"));

    buttons.push(
      btn(`org:${orgId}:roster:${safePage + 1}`, "Next", ButtonStyle.Secondary, "▶️", nextDisabled)
    );

    if (useUpdate) {
      return interaction.update({ embeds: [emb], components: rowsFromButtons(buttons) });
    }
    return useEditReply
      ? interaction.editReply({ embeds: [emb], components: rowsFromButtons(buttons) })
      : sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
  };

  const cached = rosterCache.get(orgId);
  if (
    cached &&
    Date.now() - cached.ts < ROSTER_CACHE_MS &&
    Array.isArray(cached.lines) &&
    typeof cached.title === "string"
  ) {
    return renderFromLines(cached.title, cached.lines, cached.missingOrgRole || 0);
  }

  try {
    await ctx.guild.members.fetch();
  } catch (e) {
    const msg = String(e?.message || "");
    const m = msg.match(/Retry after\s+([0-9.]+)\s+seconds/i);
    const waitSec = m ? Math.ceil(Number(m[1])) : null;

    const emb = makeBrandedEmbed(
      ctx,
      "⏳ Prea multe cereri (rate limit)",
      waitSec
        ? `Te rog încearcă din nou în **${waitSec} secunde**.`
        : "Te rog încearcă din nou în câteva secunde."
    );

    const buttons = [btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")];

    return useUpdate
      ? interaction.update({ embeds: [emb], components: rowsFromButtons(buttons) })
      : (useEditReply
          ? interaction.editReply({ embeds: [emb], components: rowsFromButtons(buttons) })
          : sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons)));
  }

  const leaderRole = org.leader_role_id ? ctx.guild.roles.cache.get(org.leader_role_id) : null;
  const coLeaderRole = org.co_leader_role_id ? ctx.guild.roles.cache.get(org.co_leader_role_id) : null;

  const dbMembers = repo.listMembersByOrg(ctx.db, orgId);
  const discordMembersWithOrgRole = memberRole.members;

  const entries = [];
  let missingOrgRole = 0;

  for (const row of dbMembers) {
    const uid = String(row.user_id);
    const hasOrg = discordMembersWithOrgRole.has(uid);

    if (!hasOrg) missingOrgRole++;

    let label = "Membru";
    const m = hasOrg ? discordMembersWithOrgRole.get(uid) : (ctx.guild.members.cache.get(uid) || null);

    if (m && leaderRole && m.roles.cache.has(leaderRole.id)) label = leaderRole.name;
    else if (m && coLeaderRole && m.roles.cache.has(coLeaderRole.id)) label = coLeaderRole.name;
    else {
      const r = String(row.role || "").toUpperCase();
      if (r === "LEADER") label = leaderRole?.name || "Leader";
      else if (r === "COLEADER" || r === "CO_LEADER") label = coLeaderRole?.name || "Co-Leader";
    }

    entries.push({
      id: uid,
      label,
      order: label === leaderRole?.name ? 0 : label === coLeaderRole?.name ? 1 : 2,
      missing: !hasOrg
    });
  }

  entries.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  const lines = entries.map(e =>
    e.missing
      ? `• ❌ <@${e.id}> — **${e.label}**`
      : `• <@${e.id}> — **${e.label}**`
  );

  const title = `Roster — ${org.name}`;

  rosterCache.set(orgId, {
    ts: Date.now(),
    title,
    lines,
    missingOrgRole
  });

  return renderFromLines(title, lines, missingOrgRole);
}

async function transfersView(interaction, ctx, orgId, useEditReply = false, useUpdate = false) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    const emb = makeEmbed("Eroare", "Organizația nu există.");
    return useUpdate
      ? interaction.update({ embeds: [emb], components: [] })
      : (useEditReply
          ? interaction.editReply({ embeds: [emb], components: [] })
          : sendEphemeral(interaction, emb.data.title, emb.data.description));
  }

  const pending = repo.listPendingTransfersForOrg(ctx.db, orgId, 10);
  const lines = pending.length
    ? pending.map(t => {
        const fromOrg = repo.getOrg(ctx.db, t.from_org_id);
        return `• \`${t.request_id}\` — <@${t.user_id}> (din **${fromOrg?.name || t.from_org_id}**)`;
      })
    : ["Nu există transferuri în așteptare."];

  const emb = makeEmbed(`Transfers — ${org.name}`, lines.join("\n"));
  const buttons = [
    btn(`org:${orgId}:transfer_approve`, "Aprobă", ButtonStyle.Success, "✅"),
    btn(`org:${orgId}:transfer_reject`, "Respinge", ButtonStyle.Danger, "🛑"),
    btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")
  ];

  if (useUpdate) {
    return interaction.update({ embeds: [emb], components: rowsFromButtons(buttons) });
  }
  if (useEditReply) {
    return interaction.editReply({ embeds: [emb], components: rowsFromButtons(buttons) });
  }
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}



async function searchResult(interaction, ctx, orgId, userId) {
  const target = await ctx.guild.members.fetch(userId).catch(()=>null);
  const pk = repo.getCooldown(ctx.db, userId, "PK");
  const ban = repo.getCooldown(ctx.db, userId, "BAN");
  const orgSwitch = repo.getCooldown(ctx.db, userId, "ORG_SWITCH");
  const transfers = repo.listTransfersByUser(ctx.db, userId, 3);
  const activeTransfer = transfers.find(t => t.status === "PENDING" || t.status === "APPROVED") || null;
  const member = repo.getMembership(ctx.db, userId);
  const last = repo.getLastOrgState(ctx.db, userId);

  const lines = [];
  lines.push(`User: ${target ? `<@${userId}>` : `\`${userId}\``}`);
  if (ban && ban.expires_at > now()) lines.push(`Status: **BAN** (expiră <t:${Math.floor(ban.expires_at/1000)}:R>)`);
  else if (pk && pk.expires_at > now()) lines.push(`Status: **PK cooldown** (expiră <t:${Math.floor(pk.expires_at/1000)}:R>)`);
  else if (orgSwitch && orgSwitch.expires_at > now()) lines.push(`Status: **Transfer cooldown** (expiră <t:${Math.floor(orgSwitch.expires_at/1000)}:R>)`);
  else lines.push("Status: **Free**");
  if (activeTransfer) lines.push(`Transfer activ: **${activeTransfer.status}** (ID: \`${activeTransfer.request_id}\`)`);
  if (member) {
    lines.push(`În organizație: **Da**`);
  } else {
    lines.push("În organizație: **Nu**");
  }
  if (last?.last_left_at) {
    lines.push(`Ultima plecare din org: <t:${Math.floor(last.last_left_at/1000)}:R>`);
  } else {
    lines.push("Ultima plecare din org: —");
  }

  if (ctx.perms.staff) {
    if (member) {
      const org = repo.getOrg(ctx.db, member.org_id);
      lines.push(`Org curentă: **${org?.name ?? member.org_id}**`);
    }
    if (last?.last_org_id) {
      const lastOrg = repo.getOrg(ctx.db, last.last_org_id);
      lines.push(`Ultima org: **${lastOrg?.name ?? last.last_org_id}**`);
    }
    if (last?.last_removed_by) {
      lines.push(`Scos de: <@${last.last_removed_by}>`);
    }
    if (transfers.length) {
      lines.push("Istoric transfer (ultimele 3):");
      for (const t of transfers) {
        const from = repo.getOrg(ctx.db, t.from_org_id)?.name ?? t.from_org_id;
        const to = repo.getOrg(ctx.db, t.to_org_id)?.name ?? t.to_org_id;
        lines.push(`• \`${t.request_id}\` — ${from} → ${to} | **${t.status}**`);
      }
    }
  }

  const emb = makeEmbed("Search", lines.join("\n"));
  const buttons = [btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

function collectUsersFromOptions(interaction, max = 8) {
  const keys = ["user", ...Array.from({ length: max - 1 }, (_, i) => `user${i + 2}`)];
  const users = keys.map(k => interaction.options.getUser(k)).filter(Boolean);

  const seen = new Set();
  return users.filter(u => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}

function compactResultLines(lines, maxLines = 10) {
  if (!Array.isArray(lines) || lines.length === 0) return "—";
  if (lines.length <= maxLines) return lines.join("\n");
  const head = lines.slice(0, maxLines);
  return `${head.join("\n")}\n… și încă **${lines.length - maxLines}**`;
}
function parseExtraUserIdsFromText(text) {
  const s = String(text || "");
  const ids = [];

  for (const m of s.matchAll(/<@!?(\d{15,25})>/g)) ids.push(m[1]);
  for (const m of s.matchAll(/\b(\d{15,25})\b/g)) ids.push(m[1]);

  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const k = String(id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function uniqIds(arr) {
  const seen = new Set();
  const out = [];
  for (const v of (arr || [])) {
    const k = String(v);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}


async function slashAddCommand(interaction, ctx) {
  const users = collectUsersFromOptions(interaction, 8);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const orgId = await resolveOrgForAddSlash(interaction, ctx);
  if (!orgId) return;

  const org = repo.getOrg(ctx.db, orgId);
  const orgName = org?.name ?? String(orgId);

  let ok = 0, fail = 0;
  const lines = [];

  for (const user of users) {
    const targetMember = await fetchTargetMember(ctx, user.id);
    if (!targetMember) {
      fail++;
      lines.push(`❌ <@${user.id}> — nu este în guild`);
      continue;
    }

    const res = await addToOrg(ctx, targetMember, orgId, "MEMBER");
    if (!res.ok) {
      fail++;
      lines.push(`❌ <@${user.id}> — ${res.msg || "adăugarea a eșuat"}`);
      continue;
    }

    ok++;
    lines.push(`✅ <@${user.id}> — adăugat`);
  }

  const title = ok > 1 ? "Membri adăugați" : "Membru adăugat";
  const desc = [
    `🏢 Organizație: **${orgName}**`,
    `✅ Reușit: **${ok}** • ❌ Eșuat: **${fail}**`,
    "",
    compactResultLines(lines, 10),
  ].join("\n");

  return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, title, desc)] });
}

async function slashRmvCommand(interaction, ctx) {
  const picked = collectUsersFromOptions(interaction, 8);
  const pk = interaction.options.getBoolean("pk", true);
  const extraText = interaction.options.getString("users") || "";

  if (!picked.length) {
    return sendEphemeral(interaction, "Eroare", "Trebuie să selectezi cel puțin un user.");
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const extraIds = parseExtraUserIdsFromText(extraText);
  const allIds = uniqIds([
    ...picked.map(u => u.id),
    ...extraIds
  ]).slice(0, 30);

  let ok = 0, fail = 0;
  const lines = [];

  for (const uid of allIds) {
    const targetMember = await fetchTargetMember(ctx, uid);

    if (!targetMember) {
      const mrow = repo.getMembership(ctx.db, uid);
      if (mrow && Number(mrow.org_id) > 0) {
        try {
          repo.removeMembership(ctx.db, uid);
          repo.upsertLastOrgState(ctx.db, uid, mrow.org_id, now(), ctx.uid);
          lines.push(`✅ <@${uid}> - scos din DB (nu mai este pe Discord)`);
          ok++;
          continue;
        } catch (e) {
          lines.push(`❌ <@${uid}> - nu pot curata DB: ${e?.message || "eroare"}`);
          fail++;
          continue;
        }
      }

      lines.push(`❌ <@${uid}> - Unknown Member (nu e in guild) si nu apare ca membru in DB`);
      fail++;
      continue;
    }

  

    const orgRes = resolveOrgForRmvSlash(ctx, targetMember);
    if (!orgRes.orgId) {
      fail++;
      lines.push(`❌ <@${uid}> — ${orgRes.msg || "nu pot determina organizația"}`);
      continue;
    }

    const res = pk
      ? await applyPk(ctx, targetMember, orgRes.orgId, ctx.uid)
      : await removeFromOrg(ctx, targetMember, orgRes.orgId, ctx.uid);

    if (!res.ok) {
      fail++;
      lines.push(`❌ <@${uid}> — ${res.msg || "acțiunea a eșuat"}`);
      continue;
    }

    ok++;
    lines.push(`✅ <@${uid}> — scos${pk ? " + PK" : ""}`);
  }

  const title = pk ? "Remove (BULK + PK)" : "Remove (BULK)";
  const desc = [
    `✅ Reușit: **${ok}** • ❌ Eșuat: **${fail}**`,
    "",
    compactResultLines(lines, 10),
    allIds.length >= 30 ? "⚠️ Limită: au fost procesate maxim **30** persoane." : ""
  ].join("\n");

  return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, title, desc)] });
}


export async function handleFmenuCommand(interaction, ctx) {
  return fmenuHome(interaction, ctx);
}

export async function handleAddCommand(interaction, ctx) {
  return slashAddCommand(interaction, ctx);
}

export async function handleRmvCommand(interaction, ctx) {
  return slashRmvCommand(interaction, ctx);
}

export async function handleFmenuComponent(interaction, ctx) {
  const id = interaction.customId;

  if (interaction.isStringSelectMenu()) {
    if (id === "fmenu:pickorg") {
      const orgId = Number(interaction.values[0]);
      return orgPanelView(interaction, ctx, orgId);
    }
    return;
  }

  if (!interaction.isButton()) return;

  if (id.startsWith("fmenu:open:")) {
    const orgId = Number(id.split(":")[2]);
    return orgPanelView(interaction, ctx, orgId);
  }

  if (id === "fmenu:back") return fmenuHome(interaction, ctx);

  if (id.startsWith("org:")) {
    const parts = id.split(":");
    const orgId = Number(parts[1]);
    const action = parts[2];

    if (action === "back") return orgPanelView(interaction, ctx, orgId);
    if (action === "add") return showModalSafe(interaction, addMembersModal(orgId));
    if (action === "remove") return showModalSafe(interaction, removeMembersModal(orgId, false));
    if (action === "remove_pk") return showModalSafe(interaction, removeMembersModal(orgId, true));

    if (action === "roster") {
      const page = parts[3] ? Number(parts[3]) : 1;

      if (parts[3]) {
        return rosterView(interaction, ctx, orgId, false, page, true);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return rosterView(interaction, ctx, orgId, true, 1, false);
    }

    if (action === "search") return showModalSafe(interaction, searchModal(orgId));
    if (action === "transfer") return showModalSafe(interaction, transferRequestModal(orgId));
    if (action === "transfers") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return transfersView(interaction, ctx, orgId, true, false);
    }
    if (action === "transfer_approve") return showModalSafe(interaction, transferDecisionModal(orgId, "approve"));
    if (action === "transfer_reject") return showModalSafe(interaction, transferDecisionModal(orgId, "reject"));
    if (action === "setrank") return showModalSafe(interaction, setRankModal(orgId));
    if (action === "delegations") return delegationsView(interaction, ctx, orgId);
    if (action === "delegate_add") return showModalSafe(interaction, delegateAddModal(orgId));
    if (action === "delegate_remove") return showModalSafe(interaction, delegateRemoveModal(orgId));
  }

  return sendEphemeral(interaction, "Eroare", "Acțiune necunoscută.");
}

export async function handleFmenuModal(interaction, ctx) {
  const id = interaction.customId;

  if (id.endsWith(":add_modal")) {
    const orgId = Number(id.split(":")[1]);
    const users = parseUserIds(interaction.fields.getTextInputValue("users"));
    if (!users.length) return sendEphemeral(interaction, "Eroare", "Nu am găsit User ID-uri valide.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let ok = 0, bad = 0;
    const errors = [];
    for (const uid of users) {
      const m = await ctx.guild.members.fetch(uid).catch((err) => {
        console.error(`[ADD] fetch member failed for ${uid}:`, err);
        return null;
      });
      if (!m) { bad++; errors.push("Nu pot găsi userul în guild."); continue; }
      const res = await addToOrg(ctx, m, orgId, "MEMBER");
      if (res.ok) ok++;
      else {
        bad++;
        if (res.msg) errors.push(res.msg);
      }
    }
    const note = bad > 0 && errors.length ? `\nMotiv principal: ${errors[0]}` : "";
    return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, "Rezultat", `Adăugați: **${ok}** | Eșuați: **${bad}**${note}`)] });
  }

  if (id.endsWith(":remove_modal") || id.endsWith(":remove_pk_modal")) {
    const parts = id.split(":");
    const orgId = Number(parts[1]);
    const pk = id.includes(":remove_pk_modal");
    const users = parseUserIds(interaction.fields.getTextInputValue("users"));
    if (!users.length) return sendEphemeral(interaction, "Eroare", "Nu am găsit User ID-uri valide.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let ok = 0, bad = 0;
    const errors = [];
      for (const uid of users) {
        let fetchErr = null;
        const m = await ctx.guild.members.fetch(uid).catch((err) => {
          fetchErr = err;

          if (err?.code === 10007) {
            console.warn(`[RMV] user not in guild (cleanup DB): ${uid}`);
          } else {
            console.error(`[RMV] fetch member failed for ${uid}:`, err);
          }
          return null;
        });

        if (!m) {
          if (fetchErr?.code === 10007) {
            try {
              const mem = repo.getMembership(ctx.db, String(uid));

              if (mem && Number(mem.org_id) === Number(orgId)) {
                repo.removeMembership(ctx.db, String(uid));
                repo.upsertLastOrgState(ctx.db, String(uid), mem.org_id, now(), ctx.uid);
                ok++;
                continue;
              }

              bad++;
              errors.push("User nu e in serverul de Discord și nu apare ca membru în această org.");
              continue;
            } catch (e) {
              bad++;
              errors.push("User nu e in serverul de Discord, dar nu am reușit să curăț DB.");
              continue;
            }
          }

          bad++;
          errors.push("Nu pot prelua userul.");
          continue;
        }

        const res = pk
          ? await applyPk(ctx, m, orgId, ctx.uid)
          : await removeFromOrg(ctx, m, orgId, ctx.uid);

        if (res.ok) ok++;
        else {
          bad++;
          if (res.msg) errors.push(res.msg);
        }
      }

    const note = bad > 0 && errors.length ? `\nMotiv principal: ${errors[0]}` : "";
    const title = pk ? "Rezultat (Remove + PK)" : "Rezultat (Remove)";
    return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, title, `Scoși: **${ok}** | Eșuați: **${bad}**${note}`)] });
  }

  if (id.endsWith(":search_modal")) {
    const orgId = Number(id.split(":")[1]);
    const q = interaction.fields.getTextInputValue("user")?.trim();
    if (!q) return sendEphemeral(interaction, "Eroare", "Query lipsă.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return searchResult(interaction, ctx, orgId, q);
  }

  if (id.endsWith(":transfer_modal")) {
    const orgId = Number(id.split(":")[1]);
    const user = interaction.fields.getTextInputValue("user")?.trim();
    const toOrgRaw = interaction.fields.getTextInputValue("to_org")?.trim();
    const uid = user?.replace(/[<@!>]/g, "").trim();
    if (!uid || !/^\d{15,25}$/.test(uid)) return sendEphemeral(interaction, "Eroare", "User invalid.");
    const resolved = resolveOrgByInput(ctx, toOrgRaw);
    if (!resolved.ok) return sendEphemeral(interaction, "Eroare", resolved.msg || "Org invalid.");

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await requestTransfer(ctx, orgId, uid, resolved.org.id);
    if (!res.ok) return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, "Eroare", res.msg || "Transferul a eșuat.")] });
    return interaction.editReply({
      embeds: [makeBrandedEmbed(ctx, "Transfer solicitat", `Transfer ID: \`${res.requestId}\` | Destinație: **${res.toOrgName}**`)]
    });
  }

  if (id.endsWith(":transfer_approve_modal") || id.endsWith(":transfer_reject_modal")) {
    const orgId = Number(id.split(":")[1]);
    const action = id.includes("approve") ? "approve" : "reject";
    const requestId = interaction.fields.getTextInputValue("request_id")?.trim().toUpperCase();
    if (!requestId) return sendEphemeral(interaction, "Eroare", "Transfer ID invalid.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await processTransferDecision(ctx, orgId, requestId, action);
    if (!res.ok) return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, "Eroare", res.msg || "Acțiunea a eșuat.")] });
    const title = action === "approve" ? "Transfer aprobat" : "Transfer respins";
    return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, title, `Transfer ID: \`${requestId}\``)] });
  }

  if (id.endsWith(":setrank_modal")) {
    const orgId = Number(id.split(":")[1]);
    const user = interaction.fields.getTextInputValue("user")?.trim();
    const rankRaw = interaction.fields.getTextInputValue("rank")?.trim();
    const rank = normalizeDesiredRank(rankRaw);
    const uid = user?.replace(/[<@!>]/g, "").trim();
    if (!uid || !/^\d{15,25}$/.test(uid)) return sendEphemeral(interaction, "Eroare", "User invalid.");
    if (!rank) return sendEphemeral(interaction, "Eroare", "Rank invalid. Folosește MEMBER/LEADER/COLEADER.");

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await ctx.guild.members.fetch(uid).catch(()=>null);
    if (!member) return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, "Eroare", "Nu pot găsi userul în guild.")] });

    const res = await setMemberRank(ctx, member, orgId, rank, ctx.uid);
    if (!res.ok) return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, "Eroare", res.msg || "Acțiunea a eșuat.")] });

    const org = repo.getOrg(ctx.db, orgId);
    return interaction.editReply({ embeds: [makeBrandedEmbed(ctx, "Rank setat", `User: <@${uid}> | Org: **${org?.name ?? orgId}** | Rank: **${prettyRank(rank)}**`)] });
  }

  if (id.endsWith(":delegate_add_modal")) {
    const orgId = Number(id.split(":")[1]);
    const userRaw = interaction.fields.getTextInputValue("user")?.trim();
    const canDemoteRaw = interaction.fields.getTextInputValue("can_demote")?.trim();
    const uid = userRaw?.replace(/[<@!>]/g, "").trim();
    if (!uid || !/^\d{15,25}$/.test(uid)) return sendEphemeral(interaction, "Eroare", "User invalid.");
    const org = repo.getOrg(ctx.db, orgId);
    if (!org) return sendEphemeral(interaction, "Eroare", "Organizația nu există.");
    const rank = getOrgRank(ctx.member, org);
    if (!ctx.perms.staff && rank !== "LEADER") return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar Leader sau staff.");
    if (String(org.kind).toUpperCase() !== "LEGAL") return sendEphemeral(interaction, "Eroare", "Delegările sunt disponibile doar pentru org LEGAL.");
    const canDemote = ["da", "yes", "y", "1", "true"].includes(String(canDemoteRaw || "").toLowerCase());
    repo.upsertOrgDelegate(ctx.db, orgId, uid, { can_promote_coleader: true, can_demote_coleader: canDemote }, ctx.uid);
    await audit(ctx, "🛂 Delegare adăugată", `**Org:** **${org.name}**\n**Delegat:** <@${uid}>\n**Permisiuni:** promote co-leader=DA, demote co-leader=${canDemote ? "DA" : "NU"}\n**De către:** <@${ctx.uid}>`, COLORS.GLOBAL);
    return sendEphemeral(interaction, "Delegare salvată", `Delegat: <@${uid}>`);
  }

  if (id.endsWith(":delegate_remove_modal")) {
    const orgId = Number(id.split(":")[1]);
    const userRaw = interaction.fields.getTextInputValue("user")?.trim();
    const uid = userRaw?.replace(/[<@!>]/g, "").trim();
    if (!uid || !/^\d{15,25}$/.test(uid)) return sendEphemeral(interaction, "Eroare", "User invalid.");
    const org = repo.getOrg(ctx.db, orgId);
    if (!org) return sendEphemeral(interaction, "Eroare", "Organizația nu există.");
    const rank = getOrgRank(ctx.member, org);
    if (!ctx.perms.staff && rank !== "LEADER") return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar Leader sau staff.");
    repo.removeOrgDelegate(ctx.db, orgId, uid);
    await audit(ctx, "🛂 Delegare revocată", `**Org:** **${org.name}**\n**Delegat:** <@${uid}>\n**De către:** <@${ctx.uid}>`, COLORS.GLOBAL);
    return sendEphemeral(interaction, "Delegare ștearsă", `Delegat: <@${uid}>`);
  }

  return sendEphemeral(interaction, "Eroare", "Modal necunoscut.");
}
