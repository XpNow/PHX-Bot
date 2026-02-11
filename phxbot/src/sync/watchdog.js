import { getGlobal, getSetting } from "../db/db.js";
import * as repo from "../db/repo.js";
import { enqueueRoleOp } from "../infra/roleQueue.js";
import { COLORS } from "../ui/theme.js";
import { applyBranding } from "../ui/brand.js";
import { makeEmbed } from "../ui/ui.js";
import { syncMemberOrgsDiscordToDb, diffMemberOrgsFromDiscord } from "./memberSync.js";
import { AuditLogEvent } from "discord.js";

function fmtRel(tsMs) {
  return `<t:${Math.floor(Number(tsMs) / 1000)}:R>`;
}

function envBool(key, def = false) {
  const v = String(process.env[key] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

function envInt(key, def) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : def;
}

function settingBool(db, key, def, envKey) {
  const raw = getSetting(db, key);
  if (raw !== "") {
    const v = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(v)) return true;
    if (["0", "false", "no", "n", "off"].includes(v)) return false;
  }
  return envKey ? envBool(envKey, def) : def;
}

function settingInt(db, key, def, envKey) {
  const raw = getSetting(db, key);
  if (raw !== "") {
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return envKey ? envInt(envKey, def) : def;
}

function roReason(reason) {
  if (reason === "startup") return "pornire (recuperare după downtime)";
  if (reason === "interval") return "verificare periodică";
  return String(reason || "—");
}

function yesNoIcon(b) {
  return b ? "✅" : "❌";
}

function fmtRoleState(hasRole) {
  return `${yesNoIcon(hasRole)} ${hasRole ? "rol prezent" : "rol lipsește"}`;
}

function fmtDbCooldown(row, now) {
  if (!row) return "❌ lipsă";
  if (Number(row.expires_at) <= now) return `⚠️ expirat (${fmtRel(row.expires_at)})`;
  return `✅ activ (expiră ${fmtRel(row.expires_at)})`;
}

function fmtOpResult(res) {
  if (!res) return "necunoscut";
  if (res.ok) {
    if (res.skipped) return "OK (skip, deja corect)";
    if (res.deduped) return "OK (deduped)";
    return "OK";
  }
  return `EȘEC (${res.reason || "UNKNOWN"})`;
}

async function sendAudit({ guild, db, title, desc, color = COLORS.GLOBAL }) {
  const auditChannelId = getSetting(db, "audit_channel_id");
  if (!auditChannelId) return;
  const ch = await guild.channels.fetch(auditChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const brandText = getSetting(db, "brand_text") || "Phoenix Faction Manager";
  const brandIconUrl = getSetting(db, "brand_icon_url") || "";
  const ctx = { guild, settings: { brandText, brandIconUrl } };

  const emb = makeEmbed(title, desc, color);
  applyBranding(emb, ctx);
  await ch.send({ embeds: [emb] }).catch(() => {});
}

function clipLines(lines, maxLines = 12) {
  if (!Array.isArray(lines) || lines.length === 0) return "";
  const head = lines.slice(0, maxLines);
  const extra = lines.length > maxLines ? `\n… și încă ${lines.length - maxLines}` : "";
  return head.join("\n") + extra;
}

async function indexRecentMemberRoleAudits(guild, windowMs = 120_000, limit = 50) {
  const out = new Map();
  let logs = null;
  try {
    logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const entry of logs.entries.values()) {
    if (!entry) continue;
    const ts = Number(entry.createdTimestamp || 0);
    if (!ts || now - ts > windowMs) continue;

    const targetId = entry.target?.id ? String(entry.target.id) : null;
    const executorId = entry.executor?.id ? String(entry.executor.id) : null;
    if (!targetId || !executorId) continue;

    const added = new Set();
    const removed = new Set();
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const ch of changes) {
      const key = ch?.key;
      const nv = ch?.new;
      const ov = ch?.old;

      if ((key === "$add" || key === "$remove") && Array.isArray(nv)) {
        for (const r of nv) {
          const rid = r?.id ? String(r.id) : null;
          if (!rid) continue;
          if (key === "$add") added.add(rid);
          else removed.add(rid);
        }
        continue;
      }

      if (key === "roles" && Array.isArray(nv) && Array.isArray(ov)) {
        const newIds = new Set(nv.map(x => x?.id).filter(Boolean).map(String));
        const oldIds = new Set(ov.map(x => x?.id).filter(Boolean).map(String));
        for (const rid of newIds) if (!oldIds.has(rid)) added.add(rid);
        for (const rid of oldIds) if (!newIds.has(rid)) removed.add(rid);
      }
    }

    for (const rid of added) out.set(`${targetId}:add:${rid}`, executorId);
    for (const rid of removed) out.set(`${targetId}:remove:${rid}`, executorId);
  }
  return out;
}
async function recoverCooldownsFromDiscord({ db, members, acceptRoleRemoval, reason }) {
  const now = Date.now();
  const pkDefaultMs = settingInt(db, "pk_backfill_default_ms", 3 * 24 * 60 * 60 * 1000);
  const banDefaultMs = settingInt(db, "ban_backfill_default_ms", 30 * 24 * 60 * 60 * 1000);
  const pkRole = getSetting(db, "pk_role_id");
  const banRole = getSetting(db, "ban_role_id");

  const pkRows = repo.listCooldowns(db, "PK");
  const banRows = repo.listCooldowns(db, "BAN");
  const transferRows = repo.listCooldowns(db, "ORG_SWITCH");
  const pkMap = new Map(pkRows.map(r => [String(r.user_id), r]));
  const banMap = new Map(banRows.map(r => [String(r.user_id), r]));
  const transferMap = new Map(transferRows.map(r => [String(r.user_id), r]));

  let pkBackfilled = 0;
  let banBackfilled = 0;
  let pkCleared = 0;
  let banCleared = 0;
  let pkExpiredRemoved = 0;
  let banExpiredRemoved = 0;
  let pkEnforced = 0;
  let banEnforced = 0;
  let transferCleared = 0;
  let transferEnforced = 0;
  let transferExpiredRemoved = 0;

  const driftLines = [];

  for (const m of members.values()) {
    if (pkRole) {
      const hasRole = m.roles.cache.has(pkRole);
      const row = pkMap.get(m.id) || null;
      const transferRow = transferMap.get(m.id) || null;
      const hasTransferCooldown = !!(transferRow && Number(transferRow.expires_at) > now);
      const activeTransfer = repo.findActiveTransferByUser(db, m.id);
      const hasOpenTransfer = !!activeTransfer;

      if (hasRole) {
        if (!row && !hasTransferCooldown && !hasOpenTransfer) {
          const expiresAt = now + pkDefaultMs;
          repo.upsertCooldown(db, m.id, "PK", expiresAt, null, null);
          pkMap.set(m.id, { user_id: m.id, expires_at: expiresAt });
          pkBackfilled++;
          driftLines.push(
            `• <@${m.id}> — **PK** | Discord: ${fmtRoleState(true)} | DB: ${fmtDbCooldown(null, now)} → ✅ am creat cooldown în DB (3 zile, expiră ${fmtRel(expiresAt)})`
          );
        } else if (row && Number(row.expires_at) <= now) {
          const res = await enqueueRoleOp({ member: m, roleId: pkRole, action: "remove", context: `watchdog:pk:expired:${reason}` });
          pkExpiredRemoved += res?.ok ? 1 : 0;
          repo.clearCooldown(db, m.id, "PK");
          pkMap.delete(m.id);
          driftLines.push(
            `• <@${m.id}> — **PK** | Discord: ${fmtRoleState(true)} | DB: ${fmtDbCooldown(row, now)} → 🧹 am curățat (rol scos + DB șters) • ${fmtOpResult(res)}`
          );
        }
      } else if (row && Number(row.expires_at) > now) {
        if (acceptRoleRemoval) {
          repo.clearCooldown(db, m.id, "PK");
          pkMap.delete(m.id);
          pkCleared++;
          driftLines.push(
            `• <@${m.id}> — **PK** | Discord: ${fmtRoleState(false)} | DB: ${fmtDbCooldown(row, now)} → ✅ am șters cooldown-ul din DB (accept schimbare făcută offline)`
          );
        } else {
          const res = await enqueueRoleOp({ member: m, roleId: pkRole, action: "add", context: `watchdog:pk:enforce:${reason}` });
          pkEnforced += res?.ok ? 1 : 0;
          driftLines.push(
            `• <@${m.id}> — **PK** | Discord: ${fmtRoleState(false)} | DB: ${fmtDbCooldown(row, now)} → 🔁 am încercat să readaug rolul PK • ${fmtOpResult(res)}`
          );
        }
      }
    }

    if (pkRole) {
      const hasSharedRole = m.roles.cache.has(pkRole);
      const transferRow = transferMap.get(m.id) || null;

      if (transferRow && Number(transferRow.expires_at) <= now) {
        const activePk = pkMap.get(m.id) || null;
        const pkActive = !!(activePk && Number(activePk.expires_at) > now);
        if (hasSharedRole && !pkActive) {
          const res = await enqueueRoleOp({ member: m, roleId: pkRole, action: "remove", context: `watchdog:transfer:expired:${reason}` });
          transferExpiredRemoved += res?.ok ? 1 : 0;
          driftLines.push(
            `• <@${m.id}> — **TRANSFER** | Discord: ${fmtRoleState(true)} | DB: ${fmtDbCooldown(transferRow, now)} → 🧹 am curățat rol transfer expirat • ${fmtOpResult(res)}`
          );
        }
        repo.clearCooldown(db, m.id, "ORG_SWITCH");
        transferMap.delete(m.id);
      } else if (transferRow && Number(transferRow.expires_at) > now) {
        if (!hasSharedRole) {
          if (acceptRoleRemoval) {
            repo.clearCooldown(db, m.id, "ORG_SWITCH");
            transferMap.delete(m.id);
            transferCleared++;
            driftLines.push(
              `• <@${m.id}> — **TRANSFER** | Discord: ${fmtRoleState(false)} | DB: ${fmtDbCooldown(transferRow, now)} → ✅ am șters cooldown transfer din DB (accept schimbare făcută offline)`
            );
          } else {
            const res = await enqueueRoleOp({ member: m, roleId: pkRole, action: "add", context: `watchdog:transfer:enforce:${reason}` });
            transferEnforced += res?.ok ? 1 : 0;
            driftLines.push(
              `• <@${m.id}> — **TRANSFER** | Discord: ${fmtRoleState(false)} | DB: ${fmtDbCooldown(transferRow, now)} → 🔁 am încercat să readaug rolul transfer • ${fmtOpResult(res)}`
            );
          }
        }
      }
    }

    if (banRole) {
      const hasRole = m.roles.cache.has(banRole);
      const row = banMap.get(m.id) || null;

      if (hasRole) {
        if (!row) {
          const expiresAt = now + banDefaultMs;
          repo.upsertCooldown(db, m.id, "BAN", expiresAt, null, null);
          banMap.set(m.id, { user_id: m.id, expires_at: expiresAt });
          banBackfilled++;
          driftLines.push(
            `• <@${m.id}> — **BAN** | Discord: ${fmtRoleState(true)} | DB: ${fmtDbCooldown(null, now)} → ✅ am creat cooldown în DB (30 zile, expiră ${fmtRel(expiresAt)})`
          );
        } else if (Number(row.expires_at) <= now) {
          const res = await enqueueRoleOp({ member: m, roleId: banRole, action: "remove", context: `watchdog:ban:expired:${reason}` });
          banExpiredRemoved += res?.ok ? 1 : 0;
          repo.clearCooldown(db, m.id, "BAN");
          banMap.delete(m.id);
          driftLines.push(
            `• <@${m.id}> — **BAN** | Discord: ${fmtRoleState(true)} | DB: ${fmtDbCooldown(row, now)} → 🧹 am curățat (rol scos + DB șters) • ${fmtOpResult(res)}`
          );
        }
      } else if (row && Number(row.expires_at) > now) {
        if (acceptRoleRemoval) {
          repo.clearCooldown(db, m.id, "BAN");
          banMap.delete(m.id);
          banCleared++;
          driftLines.push(
            `• <@${m.id}> — **BAN** | Discord: ${fmtRoleState(false)} | DB: ${fmtDbCooldown(row, now)} → ✅ am șters cooldown-ul din DB (accept schimbare făcută offline)`
          );
        } else {
          const res = await enqueueRoleOp({ member: m, roleId: banRole, action: "add", context: `watchdog:ban:enforce:${reason}` });
          banEnforced += res?.ok ? 1 : 0;
          driftLines.push(
            `• <@${m.id}> — **BAN** | Discord: ${fmtRoleState(false)} | DB: ${fmtDbCooldown(row, now)} → 🔁 am încercat să readaug rolul BAN • ${fmtOpResult(res)}`
          );
        }
      }
    }
  }

  return {
    ok: true,
    pkBackfilled,
    banBackfilled,
    pkCleared,
    banCleared,
    pkExpiredRemoved,
    banExpiredRemoved,
    pkEnforced,
    banEnforced,
    transferCleared,
    transferEnforced,
    transferExpiredRemoved,
    driftLines
  };
}

async function recoverMembershipsFromDiscord({ db, members, reason }) {
  let upserts = 0;
  let removals = 0;
  let conflicts = 0;
  const driftLines = [];

  const orgs = repo.listOrgs(db);
  const orgNameById = new Map(orgs.map(o => [String(o.id), o.name]));
  const orgById = new Map(orgs.map(o => [String(o.id), o]));
  const auditWindowMs = Math.max(30_000, settingInt(db, "audit_index_window_ms", 120_000));
  const auditLimit = Math.max(10, settingInt(db, "audit_index_limit", 50));
  const auditIndex = members?.size
    ? await indexRecentMemberRoleAudits(members.first().guild, auditWindowMs, auditLimit).catch(() => new Map())
    : new Map();
  const audit = async () => {};

  for (const m of members.values()) {
    const res = await syncMemberOrgsDiscordToDb({ db, guild: m.guild, member: m, audit });

    if (!res?.ok) {
      if (res?.conflict) {
        conflicts++;
        const hits = diffMemberOrgsFromDiscord(m, orgs);
        const names = hits.map(o => o.name).join(", ");
        driftLines.push(`• <@${m.id}> — ⚠️ roluri org multiple pe Discord (${names || "—"}) → nu am modificat baza de date (conflict)`);
      }
      continue;
    }

    if (res.action === "UPSERT") {
      upserts++;
      const orgName = orgNameById.get(String(res.orgId)) || String(res.orgId);
      const prevName = res.prevOrgId ? (orgNameById.get(String(res.prevOrgId)) || String(res.prevOrgId)) : null;

      if (!res.prevOrgId) {
        const org = orgById.get(String(res.orgId));
        const mainRoleId = org?.member_role_id ? String(org.member_role_id) : null;
        const execId = mainRoleId ? auditIndex.get(`${m.id}:add:${mainRoleId}`) : null;
        const execTxt = execId ? ` • de <@${execId}>` : "";
        driftLines.push(`• <@${m.id}> — rol org **adăugat**: **${orgName}**${execTxt} → DB sincronizat (rank: ${res.role})`);
      } else if (String(res.prevOrgId) !== String(res.orgId)) {
        const org = orgById.get(String(res.orgId));
        const mainRoleId = org?.member_role_id ? String(org.member_role_id) : null;
        const prevOrg = res.prevOrgId ? orgById.get(String(res.prevOrgId)) : null;
        const prevMainRoleId = prevOrg?.member_role_id ? String(prevOrg.member_role_id) : null;
        const execId = (mainRoleId && auditIndex.get(`${m.id}:add:${mainRoleId}`))
          || (prevMainRoleId && auditIndex.get(`${m.id}:remove:${prevMainRoleId}`))
          || null;
        const execTxt = execId ? ` • de <@${execId}>` : "";
        driftLines.push(`• <@${m.id}> — rol org **schimbat**: ${prevName || "—"} → **${orgName}**${execTxt} → DB sincronizat (rank: ${res.role})`);
      }
    }

    if (res.action === "DB_REMOVE") {
      removals++;
      const prevName = res.prevOrgId ? (orgNameById.get(String(res.prevOrgId)) || String(res.prevOrgId)) : null;
      if (res.prevOrgId) {
        repo.upsertLastOrgState(db, m.id, res.prevOrgId, Date.now(), `WATCHDOG:${reason}`);
      }
      const prevOrg = res.prevOrgId ? orgById.get(String(res.prevOrgId)) : null;
      const prevMainRoleId = prevOrg?.member_role_id ? String(prevOrg.member_role_id) : null;
      const execId = prevMainRoleId ? auditIndex.get(`${m.id}:remove:${prevMainRoleId}`) : null;
      const execTxt = execId ? ` • de <@${execId}>` : "";
      driftLines.push(`• <@${m.id}> — rol org **scos**: ${prevName || "org"}${execTxt} → DB curățat (last_org_state salvat)`);
    }
  }

  return { ok: true, upserts, removals, conflicts, driftLines };
}

async function cleanupStaleMemberships({ db, members, reason }) {
  const now = Date.now();
  const staleDays = Math.max(1, settingInt(db, "stale_membership_days", 14));
  const cutoff = now - staleDays * 24 * 60 * 60 * 1000;
  const memberIds = new Set(members.map(m => m.id));
  const memberships = repo.listMemberships(db);

  let cleaned = 0;
  const lines = [];

  for (const row of memberships) {
    if (memberIds.has(String(row.user_id))) continue;
    const presence = repo.getUserPresence(db, row.user_id);
    const lastLeftAt = Number(presence?.last_left_at || 0);
    if (!lastLeftAt || lastLeftAt > cutoff) continue;

    repo.removeMembership(db, row.user_id);
    repo.upsertLastOrgState(db, row.user_id, row.org_id, now, `STALE:${reason}`);
    cleaned++;
    lines.push(`• <@${row.user_id}> — org ${row.org_id} (last_left_at ${fmtRel(lastLeftAt)})`);
  }

  return { ok: true, cleaned, lines, staleDays };
}

async function tick({ client, db, reason, acceptRoleRemoval }) {
  const schemaVersion = Number(getGlobal(db, "schema_version") || 0);
  if (schemaVersion < 2) {
    console.warn(`[WATCHDOG] schema_version=${schemaVersion} too old, skipping watchdog tick`);
    return;
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const members = await guild.members.fetch().catch(() => null);
  if (!members) return;

  const doLogs = settingBool(db, "watchdog_drift_logs", true, "WATCHDOG_DRIFT_LOGS");
  const maxSample = Math.max(1, settingInt(db, "watchdog_drift_sample", 12, "WATCHDOG_DRIFT_SAMPLE"));

  const memRes = await recoverMembershipsFromDiscord({ db, members, reason });
  const cdRes = await recoverCooldownsFromDiscord({ db, members, acceptRoleRemoval, reason });
  const staleRes = await cleanupStaleMemberships({ db, members, reason });

  if (!doLogs) return;

  const drift = [
    ...(memRes.driftLines || []),
    ...(cdRes.driftLines || []),
    ...(staleRes.lines || [])
  ];
  const sample = clipLines(drift, maxSample);

  const counters = {
    memUpserts: memRes.upserts || 0,
    memRemovals: memRes.removals || 0,
    memConflicts: memRes.conflicts || 0,
    memStaleCleaned: staleRes.cleaned || 0,
    pkBackfilled: cdRes.pkBackfilled || 0,
    pkCleared: cdRes.pkCleared || 0,
    pkEnforced: cdRes.pkEnforced || 0,
    pkExpiredRemoved: cdRes.pkExpiredRemoved || 0,
    banBackfilled: cdRes.banBackfilled || 0,
    banCleared: cdRes.banCleared || 0,
    banEnforced: cdRes.banEnforced || 0,
    banExpiredRemoved: cdRes.banExpiredRemoved || 0,
    transferCleared: cdRes.transferCleared || 0,
    transferEnforced: cdRes.transferEnforced || 0,
    transferExpiredRemoved: cdRes.transferExpiredRemoved || 0,
  };

  const hasNumericChanges = Object.values(counters).some(v => v > 0);
  const hasDriftDetails = drift.length > 0;

  if (!hasNumericChanges && !hasDriftDetails) return;

function pushIf(lines, label, value) {
  if (value > 0) lines.push(`• ${label}: **${value}**`);
}

function section(lines, title, items) {
  const filtered = items.filter(it => (it.value || 0) > 0);
  if (!filtered.length) return;

  lines.push(`**${title}:**`);
  for (const it of filtered) pushIf(lines, it.label, it.value || 0);
  lines.push("—");
}

const modeName = acceptRoleRemoval
  ? "Recuperare după downtime"
  : "Verificare automată (watchdog)";

const policy = acceptRoleRemoval
  ? "Discord = adevăr (acceptă schimbările făcute cât botul a fost offline)"
  : "DB = adevăr (botul repară drift-ul apărut cât este online)";

  const summaryParts = [];
  if (counters.memUpserts) summaryParts.push(`Org upsert: ${counters.memUpserts}`);
  if (counters.memRemovals) summaryParts.push(`Org removed: ${counters.memRemovals}`);
  if (counters.memConflicts) summaryParts.push(`Conflicts: ${counters.memConflicts}`);
  if (counters.memStaleCleaned) summaryParts.push(`Stale cleaned: ${counters.memStaleCleaned}`);

  if (counters.pkBackfilled) summaryParts.push(`PK backfill: ${counters.pkBackfilled}`);
  if (counters.pkCleared) summaryParts.push(`PK cleared: ${counters.pkCleared}`);
  if (counters.pkEnforced) summaryParts.push(`PK enforced: ${counters.pkEnforced}`);
  if (counters.pkExpiredRemoved) summaryParts.push(`PK expired: ${counters.pkExpiredRemoved}`);

  if (counters.banBackfilled) summaryParts.push(`BAN backfill: ${counters.banBackfilled}`);
  if (counters.banCleared) summaryParts.push(`BAN cleared: ${counters.banCleared}`);
  if (counters.banEnforced) summaryParts.push(`BAN enforced: ${counters.banEnforced}`);
  if (counters.banExpiredRemoved) summaryParts.push(`BAN expired: ${counters.banExpiredRemoved}`);
  if (counters.transferCleared) summaryParts.push(`TRANSFER cleared: ${counters.transferCleared}`);
  if (counters.transferEnforced) summaryParts.push(`TRANSFER enforced: ${counters.transferEnforced}`);
  if (counters.transferExpiredRemoved) summaryParts.push(`TRANSFER expired: ${counters.transferExpiredRemoved}`);

  if (hasDriftDetails) summaryParts.push(`Drift lines: ${drift.length}`);

  const lines = [];
  lines.push(`**Mod:** ${modeName}`);
  lines.push(`**Când:** ${roReason(reason)}`);
  lines.push(`**Politică:** ${policy}`);
  lines.push(`**Membri scanați:** **${members.size}**`);
  if (summaryParts.length) lines.push(`**Schimbări:** ${summaryParts.join(" • ")}`);
  lines.push("—");

  const staleLabelDays = Math.max(1, Number(staleRes.staleDays || 14));
  section(lines, "Organizații (Discord → DB)", [
    { label: "Adăugate/actualizate în DB", value: counters.memUpserts },
    { label: "Șterse din DB (rol lipsă)", value: counters.memRemovals },
    { label: "Conflicte (roluri multiple)", value: counters.memConflicts },
    { label: `Curățate (stale > ${staleLabelDays} zile)`, value: counters.memStaleCleaned },
  ]);

  section(lines, "Cooldown-uri (Discord ↔ DB)", [
    { label: "PK: DB create (rol prezent)", value: counters.pkBackfilled },
    { label: "PK: DB șterse (rol lipsă)", value: counters.pkCleared },
    { label: "PK: rol readăugat (enforce)", value: counters.pkEnforced },
    { label: "PK: curățate (expirate)", value: counters.pkExpiredRemoved },
    { label: "BAN: DB create (rol prezent)", value: counters.banBackfilled },
    { label: "BAN: DB șterse (rol lipsă)", value: counters.banCleared },
    { label: "BAN: rol readăugat (enforce)", value: counters.banEnforced },
    { label: "BAN: curățate (expirate)", value: counters.banExpiredRemoved },

    { label: "TRANSFER: DB șterse (rol lipsă)", value: counters.transferCleared },
    { label: "TRANSFER: rol readăugat (enforce)", value: counters.transferEnforced },
    { label: "TRANSFER: curățate (expirate)", value: counters.transferExpiredRemoved },
  ]);

  if (sample) {
    lines.push(`**Detalii:**`);
    lines.push(sample);
  }

  const title = acceptRoleRemoval ? "🛡️ Recuperare după downtime" : "🛡️ Watchdog • sincronizare";
  const color = COLORS.GLOBAL;

  await sendAudit({ guild, db, title, desc: lines.join("\n"), color });
}

export function startWatchdog({ client, db }) {
  if (!settingBool(db, "watchdog_enabled", true, "WATCHDOG_ENABLED")) return;

  const startupDelay = Math.max(0, settingInt(db, "watchdog_startup_delay_ms", 5000, "WATCHDOG_STARTUP_DELAY_MS"));
  const acceptOfflineRoleRemoval = settingBool(db, "watchdog_accept_offline_role_removal", true, "WATCHDOG_ACCEPT_OFFLINE_ROLE_REMOVAL");

  setTimeout(() => {
    tick({ client, db, reason: "startup", acceptRoleRemoval: acceptOfflineRoleRemoval })
      .catch(err => console.error("[WATCHDOG] startup tick failed:", err));
  }, startupDelay);

  const scheduleNext = () => {
    const intervalMin = Math.max(5, settingInt(db, "watchdog_interval_min", 30, "WATCHDOG_INTERVAL_MIN"));
    setTimeout(() => {
      if (settingBool(db, "watchdog_enabled", true, "WATCHDOG_ENABLED")) {
        tick({ client, db, reason: "interval", acceptRoleRemoval: false })
          .catch(err => console.error("[WATCHDOG] interval tick failed:", err));
      }
      scheduleNext();
    }, intervalMin * 60 * 1000);
  };
  scheduleNext();
}
