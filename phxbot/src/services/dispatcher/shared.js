import { MessageFlags } from "discord.js";
import { openDb, ensureSchema, getSetting, setSetting, getGlobal, setGlobal } from "../../db/db.js";
import { isOwner } from "../../util/access.js";
import { makeEmbed, safeComponents } from "../../ui/ui.js";
import { COLORS } from "../../ui/theme.js";
import { enqueueRoleOp } from "../../infra/roleQueue.js";
import { applyBranding } from "../../ui/brand.js";

export const PK_MS = 3 * 24 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const LEGAL_MIN_DAYS = 14;
export const ORG_SWITCH_MS = 3 * 60 * 60 * 1000;
export const TRANSFER_MS = 60 * 60 * 1000;
const guildFetchCache = new Map();
const FULL_FETCH_CACHE_MS = 15 * 1000;

let sharedDb = null;

let _ownerIdSet = null;

export function now() { return Date.now(); }

export function getDb() {
  if (!sharedDb) {
    sharedDb = openDb();
    ensureSchema(sharedDb);
  }
  return sharedDb;
}

export function parseIdSet(envValue) {
  return new Set(
    String(envValue || "")
      .split(/[\,\s]+/g)
      .map(s => s.trim())
      .filter(Boolean)
  );
}

export function parseIdList(value) {
  return Array.from(parseIdSet(value)).filter(s => /^\d{5,25}$/.test(s));
}

export function memberHasAnyRole(member, idsValue) {
  if (!member || !member.roles || !member.roles.cache) return false;
  const ids = parseIdList(idsValue);
  if (!ids.length) return false;
  for (const rid of ids) {
    if (member.roles.cache.has(rid)) return true;
  }
  return false;
}

export function fmtRoleMentions(idsValue) {
  const ids = parseIdList(idsValue);
  if (!ids.length) return "(unset)";
  return ids.map(id => `<@&${id}>`).join(", ");
}

export function isEnvFamenuAdmin(userId) {
  const set = parseIdSet(process.env.FAMENU_ADMIN_IDS);
  return set.has(String(userId));
}

export function isEnvFamenuConfig(userId) {
  const cfg = parseIdSet(process.env.FAMENU_CONFIG_IDS);
  if (cfg.size === 0) return isEnvFamenuAdmin(userId);
  return cfg.has(String(userId));
}

export function getCtx(interaction) {
  const db = getDb();

  const guild = interaction.guild;
  const member = interaction.member;
  const uid = interaction.user.id;

  const settings = {
    audit: getSetting(db, "audit_channel_id"),
    warn: getSetting(db, "warn_channel_id"),
    botChannel: getSetting(db, "bot_channel_id"),
    adminRole: getSetting(db, "admin_role_id"),
    supervisorRole: getSetting(db, "supervisor_role_id"),
    configRole: getSetting(db, "config_role_id"),
    pkRole: getSetting(db, "pk_role_id"),
    banRole: getSetting(db, "ban_role_id"),
  };

  const envAdmin = isEnvFamenuAdmin(uid);

  const perms = {
    owner: isOwner(guild, uid),
    admin: memberHasAnyRole(member, settings.adminRole) || envAdmin,
    supervisor: memberHasAnyRole(member, settings.supervisorRole),
    configManager: memberHasAnyRole(member, settings.configRole) || isEnvFamenuConfig(uid) || envAdmin
  };
  perms.staff = perms.owner || perms.admin || perms.supervisor;

  return { db, settings, perms, guild, member, uid };
}

const _userLocks = new Map();
export async function withUserLock(userId, fn) {
  const key = String(userId || "");
  const prev = _userLocks.get(key) || Promise.resolve();
  const next = prev.then(() => fn()).finally(() => {
    if (_userLocks.get(key) === next) _userLocks.delete(key);
  });
  _userLocks.set(key, next);
  return next;
}

export async function audit(ctx, title, desc, color = COLORS.GLOBAL) {
  const channelId = ctx.settings.audit;
  if (!channelId) return;
  try {
    const ch = await ctx.guild.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) {
      console.error("[AUDIT] Invalid audit channel:", channelId);
      return;
    }
    const emb = makeEmbed(title, desc, color);
    applyBranding(emb, ctx);
    await ch.send({ embeds: [emb] });
  } catch (err) {
    console.error("[AUDIT] Failed to send audit log:", err);
  }
}

export async function sendEphemeral(interaction, title, desc, components = [], ctx = null, color = COLORS.GLOBAL) {
  const emb = makeEmbed(title, desc, color);
  const effectiveCtx = ctx || (interaction ? getCtx(interaction) : null);
  applyBranding(emb, effectiveCtx);
  const payload = { embeds: [emb], components: safeComponents(components), flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    return interaction.update(payload);
  }
  return interaction.reply(payload);
}

export function makeBrandedEmbed(ctx, title, desc, color) {
  const e = makeEmbed(title, desc, color);
  applyBranding(e, ctx);
  return e;
}

export function formatRel(tsMs) {
  return `<t:${Math.floor(Number(tsMs)/1000)}:R>`;
}

export function parseYesNo(value) {
  const v = (value || "").trim().toUpperCase();
  if (["DA", "YES", "Y", "TRUE"].includes(v)) return true;
  if (["NU", "NO", "N", "FALSE"].includes(v)) return false;
  return null;
}

export function parseDurationMs(input) {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  const m = raw.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60 * 1000, min: 60 * 1000, mins: 60 * 1000, minute: 60 * 1000, minutes: 60 * 1000,
    h: 60 * 60 * 1000, hr: 60 * 60 * 1000, hrs: 60 * 60 * 1000, hour: 60 * 60 * 1000, hours: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, days: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000, months: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000, year: 365 * 24 * 60 * 60 * 1000, years: 365 * 24 * 60 * 60 * 1000
  }[unit];
  return mult ? n * mult : null;
}

function formatFetchMembersError(err) {
  if (!err) return "Eroare necunoscută";

  const name = err?.name || "Error";
  const msg = String(err?.message || err).replace(/\s+/g, " ").trim();

  // discord.js rate limit errors often include this shape
  const retryAfter = Number(
    err?.data?.retry_after ?? err?.retry_after ?? err?.retryAfter ?? 0
  );
  const opcode = err?.data?.opcode;
  const guildId = err?.data?.meta?.guild_id || err?.payload?.guild_id;

  const parts = [];
  parts.push(`${name}: ${msg}`);
  if (Number.isFinite(retryAfter) && retryAfter > 0) parts.push(`retry_after: ${retryAfter}s`);
  if (opcode !== undefined) parts.push(`opcode: ${opcode}`);
  if (guildId) parts.push(`guild_id: ${guildId}`);

  // Keep it short for Discord embeds
  return parts.join(" | ").slice(0, 900);
}

export async function fetchMembersWithRetry(guild, label) {
  const cached = guildFetchCache.get(guild.id);
  if (cached && (Date.now() - cached.ts) < FULL_FETCH_CACHE_MS) {
    return { members: cached.members, retryMs: 0, cached: true, error: null };
  }
  try {
    const members = await guild.members.fetch();
    guildFetchCache.set(guild.id, { ts: Date.now(), members });
    return { members, retryMs: 0, cached: false, error: null };
  } catch (err) {
    const retryMs = Number(err?.retry_after || err?.retryAfter || 0) * 1000;
    if (retryMs > 0) {
      console.warn(`[${label}] rate limited, retrying after ${retryMs}ms`);
      await new Promise(resolve => setTimeout(resolve, retryMs));
      try {
        const members = await guild.members.fetch();
        guildFetchCache.set(guild.id, { ts: Date.now(), members });
        return { members, retryMs, cached: false, error: null };
      } catch (retryErr) {
        console.error(`[${label}] fetch members failed after retry:`, retryErr);
        return { members: null, retryMs, cached: false, error: formatFetchMembersError(retryErr) };
      }
    }
    console.error(`[${label}] fetch members failed:`, err);
    return { members: null, retryMs: 0, cached: false, error: formatFetchMembersError(err) };
  }
}

export function getOrgRank(member, org) {
  if (!member || !org) return "NONE";
  if (org.leader_role_id && member.roles.cache.has(org.leader_role_id)) return "LEADER";
  if (org.co_leader_role_id && member.roles.cache.has(org.co_leader_role_id)) return "COLEADER";
  if (org.member_role_id && member.roles.cache.has(org.member_role_id)) return "MEMBER";
  return "NONE";
}

export function roleCheck(ctx, roleId, label) {
  if (!roleId) return { ok: false, msg: `Rolul ${label} nu este setat.` };
  const role = ctx.guild.roles.cache.get(roleId);
  if (!role) return { ok: false, msg: `Rolul ${label} nu a fost găsit în guild.` };
  const botMember = ctx.guild.members.me;
  if (!botMember) return { ok: false, msg: "Nu pot valida ierarhia rolurilor botului." };
  if (botMember.roles.highest.position <= role.position) {
    return { ok: false, msg: `Botul nu are ierarhie pentru rolul ${label} (trebuie să fie deasupra).` };
  }
  return { ok: true, role };
}

export function canManageTargetRank(ctx, org, targetMember) {
  if (ctx.perms.staff) return { ok: true };
  const actorRank = getOrgRank(ctx.member, org);
  const targetRank = getOrgRank(targetMember, org);

  if (actorRank === "LEADER") {
    if (targetRank === "LEADER") return { ok: false, msg: "Nu poți modifica liderul organizației." };
    return { ok: true };
  }
  if (actorRank === "COLEADER") {
    if (targetRank !== "MEMBER") return { ok: false, msg: "Nu poți modifica liderul sau co-liderul." };
    return { ok: true };
  }
  return { ok: false, msg: "Nu ai permisiuni în această organizație." };
}

export function canSetRank(ctx, org, desiredRank, targetMember) {
  if (!["LEADER", "COLEADER", "MEMBER"].includes(desiredRank)) {
    return { ok: false, msg: "Rank invalid (LEADER/COLEADER/MEMBER)." };
  }
  if (desiredRank === "LEADER" && !ctx.perms.staff) {
    if (targetMember?.id === ctx.uid) {
      return { ok: false, msg: "Nu îți poți seta singur rolul de Leader." };
    }
    const actorRank = getOrgRank(ctx.member, org);
    if (actorRank !== "LEADER") {
      return { ok: false, msg: "Doar liderul poate alege succesorul." };
    }
  }
  if (desiredRank === "COLEADER") {
    if (!org.co_leader_role_id) return { ok: false, msg: "Rolul de Co-Leader nu este setat pentru această organizație." };
    const actorRank = getOrgRank(ctx.member, org);
    if (!ctx.perms.staff && actorRank !== "LEADER") {
      return { ok: false, msg: "Doar liderul poate seta Co-Leader." };
    }
  }
  if (desiredRank === "MEMBER") {
    const targetRank = getOrgRank(targetMember, org);
    if (targetRank === "LEADER" && !ctx.perms.staff) {
      return { ok: false, msg: "Nu poți retrograda liderul organizației." };
    }
    if (targetRank === "COLEADER") {
      const actorRank = getOrgRank(ctx.member, org);
      if (!ctx.perms.staff && actorRank !== "LEADER") {
        return { ok: false, msg: "Doar liderul poate retrograda Co-Leader." };
      }
    }
  }
  return { ok: true };
}

export async function safeRoleAdd(member, roleId, reason) {
  try {
    if (!roleId) return false;
    if (member.roles.cache.has(roleId)) return true;
    const res = await enqueueRoleOp({ member, roleId, action: "add", context: reason || "" });
    if (!res?.ok) {
      console.error("[ROLE] add failed", { user: member.id, roleId, reason, err: res?.error ?? res });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[ROLE] add failed", { user: member.id, roleId, reason, err });
    return false;
  }
}

export async function safeRoleRemove(member, roleId, reason) {
  try {
    if (!roleId) return false;
    if (!member.roles.cache.has(roleId)) return true;
    const res = await enqueueRoleOp({ member, roleId, action: "remove", context: reason || "" });
    if (!res?.ok) {
      console.error("[ROLE] remove failed", { user: member.id, roleId, reason, err: res?.error ?? res });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[ROLE] remove failed", { user: member.id, roleId, reason, err });
    return false;
  }
}

export function requireStaff(ctx) {
  if (ctx?.perms?.staff) return true;
  return isEnvFamenuAdmin(ctx?.uid);
}

export function requireOwner(ctx) {
  return ctx.perms.owner || isEnvBotOwner(ctx.uid);
}

export function parseOwnerIdSet() {
  const raw = [process.env.BOT_OWNER_ID, process.env.BOT_OWNER_IDS].filter(Boolean).join(",");
  const set = new Set();
  for (const token of String(raw).split(/[\s,]+/).map(t => t.trim()).filter(Boolean)) {
    if (/^\d{15,25}$/.test(token)) set.add(token);
  }
  return set;
}

export function isEnvBotOwner(userId) {
  if (!_ownerIdSet) _ownerIdSet = parseOwnerIdSet();
  return _ownerIdSet.has(String(userId));
}

export function requireConfigManager(ctx) {
  if (ctx?.perms?.owner || ctx?.perms?.configManager) return true;
  return isEnvFamenuConfig(ctx?.uid) || isEnvFamenuAdmin(ctx?.uid);
}

export function requireSupervisorOrOwner(ctx) {
  return ctx.perms.owner || ctx.perms.supervisor;
}

export function requireCreateOrg(ctx) {
  return ctx.perms.owner || ctx.perms.admin || ctx.perms.supervisor;
}

export async function showModalSafe(interaction, m) {
  try {
    return await interaction.showModal(m);
  } catch (e) {
    console.error("showModal failed:", e);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "A apărut o eroare. Încearcă din nou.", flags: MessageFlags.Ephemeral });
      } catch {}
    }
  }
}
