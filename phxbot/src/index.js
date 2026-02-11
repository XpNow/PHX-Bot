import { Client, Events, GatewayIntentBits, MessageFlags, Partials, AuditLogEvent } from "discord.js";
import { handleInteraction } from "./services/dispatcher.js";
import { runSchedulers } from "./services/scheduler.js";
import { openDb, ensureSchema, getSetting } from "./db/db.js";
import * as repo from "./db/repo.js";
import { syncMemberOrgsDiscordToDb, enforceCooldownsDbToDiscord } from "./sync/memberSync.js";
import { enqueueRoleOp } from "./infra/roleQueue.js";
import { makeEmbed } from "./ui/ui.js";
import { applyBranding } from "./ui/brand.js";
import { startWatchdog } from "./sync/watchdog.js";

console.log("[INDEX] starting...");

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[INDEX] DISCORD_TOKEN missing. Check .env");
  process.exit(1);
}

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return defaultValue;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return defaultValue;
}

function settingBool(db, key, defaultValue, envKey) {
  const raw = getSetting(db, key);
  if (raw !== "") {
    const v = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(v)) return true;
    if (["0", "false", "no", "n", "off"].includes(v)) return false;
  }
  return envKey ? envBool(envKey, defaultValue) : defaultValue;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  presence: { status: "invisible" },
  partials: [Partials.GuildMember]
});

const schedulerDb = openDb();
ensureSchema(schedulerDb);

client.once(Events.ClientReady, () => {
  console.log(`[INDEX] Logged in as ${client.user.tag}`);
  runSchedulers({ client, db: schedulerDb });
  startWatchdog({ client, db: schedulerDb });
});

client.on("guildMemberAdd", async (member) => {
  const db = openDb();
  try {
    ensureSchema(db);
    repo.upsertUserPresence(db, member.id, { lastSeenAt: Date.now(), clearLeft: true });
    const pkRole = getSetting(db, "pk_role_id");
    const banRole = getSetting(db, "ban_role_id");

    const orgReapplyOnJoin = settingBool(db, "org_reapply_on_join", true, "ORG_REAPPLY_ON_JOIN");
    const cooldownReapplyOnJoin = settingBool(db, "cooldown_reapply_on_join", true, "COOLDOWN_REAPPLY_ON_JOIN");

    if (orgReapplyOnJoin) {
      const mem = repo.getMembership(db, member.id);
      if (mem?.org_id) {
        const org = repo.getOrg(db, mem.org_id);
        if (org) {
          const want = [];
          if (org.member_role_id) want.push({ roleId: String(org.member_role_id), ctx: "guildMemberAdd:org:member" });

          const rank = String(mem.role || "").toUpperCase();
          if (rank === "LEADER" && org.leader_role_id) {
            want.push({ roleId: String(org.leader_role_id), ctx: "guildMemberAdd:org:leader" });
          } else if ((rank === "COLEADER" || rank === "CO_LEADER") && org.co_leader_role_id) {
            want.push({ roleId: String(org.co_leader_role_id), ctx: "guildMemberAdd:org:coleader" });
          }

          for (const it of want) {
            if (!it?.roleId) continue;
            if (member.roles.cache.has(it.roleId)) continue;

            if (!member.guild.roles.cache.get(it.roleId)) continue;
            await enqueueRoleOp({ member, roleId: it.roleId, action: "add", context: it.ctx })
              .catch((e) => console.error("[guildMemberAdd] failed add orgRole", it.roleId, e));
          }
        }
      }
    }

    if (cooldownReapplyOnJoin) {
      const pk = repo.getCooldown(db, member.id, "PK");
      const ban = repo.getCooldown(db, member.id, "BAN");
      const transferCooldown = repo.getCooldown(db, member.id, "ORG_SWITCH");
      const now = Date.now();

      if ((pk && pk.expires_at > now) || (transferCooldown && transferCooldown.expires_at > now)) {
        if (pkRole) {
          await enqueueRoleOp({ member, roleId: pkRole, action: "add", context: "guildMemberAdd:cooldown" })
            .catch((e) => console.error("[guildMemberAdd] failed add cooldown role", e));
        }
      }
      if (ban && ban.expires_at > now && banRole) {
        await enqueueRoleOp({ member, roleId: banRole, action: "add", context: "guildMemberAdd:ban" })
          .catch((e) => console.error("[guildMemberAdd] failed add banRole", e));
      }
    }
  } finally {
    db.close();
  }
});

client.on("guildMemberRemove", async (member) => {
  const db = openDb();
  try {
    ensureSchema(db);
    repo.upsertUserPresence(db, member.id, { lastLeftAt: Date.now() });
  } finally {
    db.close();
  }
});


const _pendingSync = new Map();
const _lastConflictWarn = new Map();
const _lastManualOrgRoleAudit = new Map();
const _lastManualCooldownRoleAudit = new Map();

function _canLogManualOrgRole(userId, roleId, action, windowMs = 2_000) {
  const key = `${userId}:${roleId}:${action}`;
  const last = _lastManualOrgRoleAudit.get(key) || 0;
  const now = Date.now();
  if (now - last < windowMs) return false;
  _lastManualOrgRoleAudit.set(key, now);
  return true;
}

function _canLogManualCooldownRole(userId, roleId, action, windowMs = 2_000) {
  const key = `${userId}:${roleId}:${action}`;
  const last = _lastManualCooldownRoleAudit.get(key) || 0;
  const now = Date.now();
  if (now - last < windowMs) return false;
  _lastManualCooldownRoleAudit.set(key, now);
  return true;
}

async function findRoleUpdateExecutor({ guild, targetUserId, roleId, action, maxAgeMs = 5 * 60_000 }) {

  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 25 }).catch(() => null);
  if (!logs) return null;

  const now = Date.now();
  const wantKey = action === "add" ? "$add" : "$remove";

  for (const entry of logs.entries.values()) {
    if (!entry) continue;
    if (!entry.target || String(entry.target.id) !== String(targetUserId)) continue;
    if (now - (entry.createdTimestamp || 0) > maxAgeMs) continue;

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    const hit = changes.some(ch => {
      if (!ch || ch.key !== wantKey) return false;
      const arr = Array.isArray(ch.new) ? ch.new : Array.isArray(ch.old) ? ch.old : [];
      return arr.some(r => String(r?.id) === String(roleId));
    });
    if (!hit) continue;

    return entry.executor?.id || null;
  }

  return null;
}

client.on("guildMemberUpdate", (oldMember, newMember) => {
  const key = newMember.id;
  const prev = _pendingSync.get(key);
  if (prev) clearTimeout(prev);
  _pendingSync.set(key, setTimeout(async () => {
    _pendingSync.delete(key);

    const db = openDb();
    try {
      ensureSchema(db);
      repo.upsertUserPresence(db, newMember.id, { lastSeenAt: Date.now(), clearLeft: true });

      const auditChannelId = getSetting(db, "audit_channel_id");
      const brandText = getSetting(db, "brand_text") || "Phoenix Faction Manager";
      const brandIconUrl = getSetting(db, "brand_icon_url") || "";
      const brandCtx = { guild: newMember.guild, settings: { brandText, brandIconUrl } };
      const audit = async (title, desc) => {
        if (String(title).toLowerCase().includes("roluri multiple")) {
          const last = _lastConflictWarn.get(key) || 0;
          if (Date.now() - last < 10 * 60 * 1000) return;
          _lastConflictWarn.set(key, Date.now());
        }
        if (!auditChannelId) return;
        const guild = newMember.guild;
        const ch = await guild.channels.fetch(auditChannelId).catch(() => null);
        if (!ch || !ch.isTextBased()) return;
        const emb = makeEmbed(title, desc);
        applyBranding(emb, brandCtx);
        await ch.send({ embeds: [emb] }).catch(() => {});
      };

      const orgs = repo.listOrgs(db);
      const byMemberRoleId = new Map();
      for (const o of orgs) {
        if (o?.member_role_id) byMemberRoleId.set(String(o.member_role_id), o);
      }

      const addedOrgRoles = [];
      const removedOrgRoles = [];
      for (const [rid, org] of byMemberRoleId.entries()) {
        const had = oldMember?.roles?.cache?.has(rid) || false;
        const has = newMember?.roles?.cache?.has(rid) || false;
        if (!had && has) addedOrgRoles.push(org);
        if (had && !has) removedOrgRoles.push(org);
      }

      const memRes = await syncMemberOrgsDiscordToDb({ db, guild: newMember.guild, member: newMember, audit });
      await enforceCooldownsDbToDiscord({ db, guild: newMember.guild, member: newMember, audit });
      if (memRes?.action === "DB_REMOVE" && memRes?.prevOrgId) {
        repo.upsertLastOrgState(db, newMember.id, memRes.prevOrgId, Date.now(), "DISCORD_ROLE");
      }

      const botId = newMember.guild?.client?.user?.id;
      if (addedOrgRoles.length === 1 && removedOrgRoles.length === 0) {
        const org = addedOrgRoles[0];
        const roleId = String(org.member_role_id);
        if (_canLogManualOrgRole(newMember.id, roleId, "add")) {
          const execId = await findRoleUpdateExecutor({ guild: newMember.guild, targetUserId: newMember.id, roleId, action: "add" });
          if (execId && execId !== botId) {
            const dbNote = memRes?.action === "UPSERT" ? "DB actualizat" : "DB neschimbat";
            await audit(
              "🛠️ Rol organizație adăugat manual",
              [
                `**Țintă:** <@${newMember.id}> (\`${newMember.id}\`)`,
                `**Rol:** <@&${roleId}>`,
                `**Org:** **${org.name}** (\`${org.id}\`)`,
                `**DB:** ${dbNote}`,
                `**De către:** <@${execId}>`
              ].join("\n")
            );
          }
        }
      } else if (removedOrgRoles.length === 1 && addedOrgRoles.length === 0) {
        const org = removedOrgRoles[0];
        const roleId = String(org.member_role_id);
        if (_canLogManualOrgRole(newMember.id, roleId, "remove")) {
          const execId = await findRoleUpdateExecutor({ guild: newMember.guild, targetUserId: newMember.id, roleId, action: "remove" });
          if (execId && execId !== botId) {
            const dbNote = memRes?.action === "DB_REMOVE" ? "membership șters" : "DB neschimbat";
            await audit(
              "🛠️ Rol organizație scos manual",
              [
                `**Țintă:** <@${newMember.id}> (\`${newMember.id}\`)`,
                `**Rol:** <@&${roleId}>`,
                `**Org:** **${org.name}** (\`${org.id}\`)`,
                `**DB:** ${dbNote}`,
                `**De către:** <@${execId}>`
              ].join("\n")
            );
          }
        }
      } else if (addedOrgRoles.length === 1 && removedOrgRoles.length === 1) {
        const fromOrg = removedOrgRoles[0];
        const toOrg = addedOrgRoles[0];
        const toRoleId = String(toOrg.member_role_id);
        if (_canLogManualOrgRole(newMember.id, toRoleId, "switch")) {
          const execId = await findRoleUpdateExecutor({ guild: newMember.guild, targetUserId: newMember.id, roleId: toRoleId, action: "add" });
          if (execId && execId !== botId) {
            await audit(
              "🛠️ Rol organizație schimbat manual",
              [
                `**Țintă:** <@${newMember.id}> (\`${newMember.id}\`)`,
                `**Din:** **${fromOrg.name}** → **${toOrg.name}**`,
                `**Rol nou:** <@&${toRoleId}>`,
                `**DB:** sincronizat`,
                `**De către:** <@${execId}>`
              ].join("\n")
            );
          }
        }
      }

      const pkRoleId = getSetting(db, "pk_role_id");
      if (pkRoleId) {
        const hadPkRole = oldMember?.roles?.cache?.has(pkRoleId) || false;
        const hasPkRole = newMember?.roles?.cache?.has(pkRoleId) || false;
        if (hadPkRole !== hasPkRole && _canLogManualCooldownRole(newMember.id, pkRoleId, hasPkRole ? "add" : "remove")) {
          const execId = await findRoleUpdateExecutor({
            guild: newMember.guild,
            targetUserId: newMember.id,
            roleId: pkRoleId,
            action: hasPkRole ? "add" : "remove"
          });
          if (execId && execId !== botId) {
            const pk = repo.getCooldown(db, newMember.id, "PK");
            const tr = repo.getCooldown(db, newMember.id, "ORG_SWITCH");
            const nowTs = Date.now();
            const reason = pk && pk.expires_at > nowTs
              ? "PK activ"
              : (tr && tr.expires_at > nowTs ? "TRANSFER activ" : "niciun cooldown activ");
            await audit(
              `🛠️ Rol cooldown ${hasPkRole ? "adăugat" : "scos"} manual`,
              [
                `**Țintă:** <@${newMember.id}> (\`${newMember.id}\`)`,
                `**Rol:** <@&${pkRoleId}>`,
                `**Context cooldown:** ${reason}`,
                `**De către:** <@${execId}>`
              ].join("\n")
            );
          }
        }
      }

      await enforceCooldownsDbToDiscord({ db, guild: newMember.guild, member: newMember, audit });

    } finally {
      db.close();
    }
  }, 1500));
});
client.on("interactionCreate", async (interaction) => {
  try {
    await handleInteraction(interaction, client);
  } catch (err) {
    console.error("[INDEX] interaction error:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "A apărut o eroare internă. Încearcă din nou.", flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

client.login(token).catch((e) => {
  console.error("[INDEX] Login failed:", e);
  process.exit(1);
});
