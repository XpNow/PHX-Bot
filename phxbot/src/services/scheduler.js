import {
  listExpiringCooldowns,
  listExpiringWarns,
  setWarnStatus,
  clearCooldown,
  listReadyTransfers,
  listPendingTransfers,
  getTransferRequest,
  getCooldown,
  updateTransferRequestStatus,
  incrementTransferRetryCount,
  getOrg,
  getMembership,
  listMembersByOrg,
  upsertMembership
} from '../db/repo.js';
import { getSetting } from '../db/db.js';
import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../ui/theme.js';
import { enqueueRoleOp } from '../infra/roleQueue.js';
import { applyBranding } from '../ui/brand.js';

export function runSchedulers({ client, db }) {
  setInterval(() => tick({ client, db }).catch((err) => console.error("[SCHEDULER] tick failed:", err)), 60 * 1000);
  tick({ client, db }).catch((err) => console.error("[SCHEDULER] initial tick failed:", err));
}

function setWarnStatusLine(description, statusLine) {
  const lines = description ? description.split("\n") : [];
  const idx = lines.findIndex(line => line.startsWith("Status:"));
  if (idx >= 0) lines[idx] = statusLine;
  else lines.push(statusLine);
  return lines.join("\n");
}

function fmtRel(tsMs) {
  return `<t:${Math.floor(Number(tsMs) / 1000)}:R>`;
}


function fmtOpResult(res) {
  if (!res) return "necunoscut";
  if (res.ok) {
    if (res.skipped) return "OK (skip)";
    if (res.deduped) return "OK (deduped)";
    return "OK";
  }
  return `EȘEC (${res.reason || "UNKNOWN"})`;
}

function effectiveIllegalCap(org) {
  if (!org) return null;
  if (String(org.kind).toUpperCase() !== "ILLEGAL") return null;
  const cap = Number(org.member_cap);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 30;
}

function settingNumber(db, key, fallback) {
  const raw = Number(getSetting(db, key));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function transferFailAudit(auditCh, brandCtx, req, reason, fromOrg, toOrg) {
  if (!auditCh || !auditCh.isTextBased()) return;
  const descLines = [
    `**Transfer ID:** \`${req.request_id}\``,
    `**Țintă:** <@${req.user_id}> (\`${req.user_id}\`)`,
    `**Din:** **${fromOrg?.name ?? "—"}**`,
    `**Către:** **${toOrg?.name ?? "—"}**`,
    `**Status:** ❌ eșuat`,
    `**Motiv:** ${reason}`
  ];
  const eb = new EmbedBuilder()
    .setTitle("⚠️ Transfer eșuat")
    .setColor(COLORS.ERROR)
    .setDescription(descLines.join("\n"))
    .setFooter({ text: `AUTO • ${new Date().toISOString()}` });
  applyBranding(eb, brandCtx);
  auditCh.send({ embeds: [eb] }).catch(() => {});
}

const _transferAuditDedup = new Map();
function shouldSendTransferFailAudit(reqId, reason, windowMs = 2 * 60 * 1000) {
  const key = `${reqId}:${reason}`;
  const ts = _transferAuditDedup.get(key) || 0;
  const now = Date.now();
  if (now - ts < windowMs) return false;
  _transferAuditDedup.set(key, now);
  return true;
}

async function tick({ client, db }) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const now = Date.now();
  const transferExpiryMs = settingNumber(db, "transfer_request_expiry_ms", 24 * 60 * 60 * 1000);
  const transferRetryCount = settingNumber(db, "transfer_complete_retry_count", 2);
  const transferRetryBackoffMs = settingNumber(db, "transfer_complete_retry_backoff_ms", 60 * 1000);
  const transferFailAuditDedupMs = settingNumber(db, "transfer_fail_audit_dedupe_ms", 2 * 60 * 1000);
  const expCooldowns = listExpiringCooldowns(db, now);

  const pkRole = getSetting(db, 'pk_role_id');
  const brandText = getSetting(db, 'brand_text') || 'Phoenix Faction Manager';
  const brandIconUrl = getSetting(db, 'brand_icon_url') || '';
  const brandCtx = { guild, settings: { brandText, brandIconUrl } };
  const banRole = getSetting(db, 'ban_role_id');
  const auditChannelId = getSetting(db, 'audit_channel_id');
  const auditCh = auditChannelId ? await guild.channels.fetch(auditChannelId).catch(() => null) : null;

  for (const cd of expCooldowns) {
    const member = await guild.members.fetch(cd.user_id).catch(() => null);

    let roleAction = "—";
    let roleResult = "—";

    if (!member) {
      roleAction = "User nu este în guild (doar DB curățat)";
      roleResult = "—";
    } else if (cd.kind === 'PK') {
      const activeTransfer = getCooldown(db, cd.user_id, 'ORG_SWITCH');
      const transferActive = !!(activeTransfer && Number(activeTransfer.expires_at) > now);
      if (pkRole && member.roles.cache.has(pkRole)) {
        if (transferActive) {
          roleAction = "ℹ️ Rol PK păstrat (există cooldown transfer activ)";
          roleResult = "OK (skip)";
        } else {
          const res = await enqueueRoleOp({ member, roleId: pkRole, action: "remove", context: "scheduler:pk:expire" });
          if (!res?.ok) {
            console.error(`[SCHEDULER] PK remove failed for ${cd.user_id}:`, res?.error ?? res);
            continue;
          }
          roleAction = "✅ Rol PK eliminat";
          roleResult = fmtOpResult(res);
        }
      } else {
        roleAction = "ℹ️ Rol PK deja lipsă";
        roleResult = "OK (skip)";
      }
    } else if (cd.kind === 'BAN') {
      if (banRole && member.roles.cache.has(banRole)) {
        const res = await enqueueRoleOp({ member, roleId: banRole, action: "remove", context: "scheduler:ban:expire" });
        if (!res?.ok) {
          console.error(`[SCHEDULER] BAN remove failed for ${cd.user_id}:`, res?.error ?? res);
          continue;
        }
        roleAction = "✅ Rol BAN eliminat";
        roleResult = fmtOpResult(res);
      } else {
        roleAction = "ℹ️ Rol BAN deja lipsă";
        roleResult = "OK (skip)";
      }
    } else if (cd.kind === 'ORG_SWITCH') {
      const activePk = getCooldown(db, cd.user_id, 'PK');
      const pkActive = !!(activePk && Number(activePk.expires_at) > now);
      if (pkRole && member.roles.cache.has(pkRole)) {
        if (pkActive) {
          roleAction = "ℹ️ Rol cooldown transfer păstrat (există PK activ)";
          roleResult = "OK (skip)";
        } else {
          const res = await enqueueRoleOp({ member, roleId: pkRole, action: "remove", context: "scheduler:transfer:expire" });
          if (!res?.ok) {
            console.error(`[SCHEDULER] TRANSFER remove failed for ${cd.user_id}:`, res?.error ?? res);
            continue;
          }
          roleAction = "✅ Rol cooldown transfer eliminat";
          roleResult = fmtOpResult(res);
        }
      } else {
        roleAction = "ℹ️ Rol cooldown transfer deja lipsă";
        roleResult = "OK (skip)";
      }
    }

    if (auditCh && auditCh.isTextBased()) {
      const descLines = [
        `**Țintă:** <@${cd.user_id}> (\`${cd.user_id}\`)`,
        `**Tip:** **${cd.kind}**`,
        `**Expira:** ${fmtRel(cd.expires_at)}`,
        `**Acțiune:** ${roleAction}`,
        `**Rezultat rol:** ${roleResult}`,
        `**DB:** ✅ intrare cooldown ștearsă (expirat)`
      ];

      const eb = new EmbedBuilder()
        .setTitle("✅ Cooldown expirat (auto)")
        .setColor(COLORS.SUCCESS)
        .setDescription(descLines.join("\n"))
        .setFooter({ text: `AUTO • ${new Date().toISOString()}` });

      applyBranding(eb, brandCtx);
      await auditCh.send({ embeds: [eb] }).catch(() => {});
    }

    clearCooldown(db, cd.user_id, cd.kind);
  }


  const warnChannelId = getSetting(db, 'warn_channel_id');
  if (warnChannelId) {
    const channel = await guild.channels.fetch(warnChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const expWarns = listExpiringWarns(db, now);
      for (const w of expWarns) {
        try {
          const msg = await channel.messages.fetch(w.message_id).catch(() => null);
          if (msg) {
            const embed = msg.embeds?.[0];
            const eb = new EmbedBuilder(embed?.data ?? {});
            const nextDesc = setWarnStatusLine(eb.data.description || "", "Status: 🟥 EXPIRATĂ");
            eb.setDescription(nextDesc)
              .setColor(COLORS.ERROR)
              .setFooter({ text: `EXPIRATĂ • ${new Date().toISOString()}` });
            applyBranding(eb, brandCtx);
            await msg.edit({ embeds: [eb] }).catch(() => {});
          }
          setWarnStatus(db, w.warn_id, 'EXPIRED');
        } catch {}
      }
    }
  }

  const pendingTransfers = listPendingTransfers(db, 200);
  for (const req of pendingTransfers) {
    if (!req || req.status !== "PENDING") continue;
    if (Number(req.created_at) > (now - transferExpiryMs)) continue;
    updateTransferRequestStatus(db, req.request_id, "EXPIRED");
    transferFailAudit(auditCh, brandCtx, req, "Expirat (24h)", null, null);
  }

  const readyTransfers = listReadyTransfers(db, now, 25);
  for (const tr of readyTransfers) {
    const req = getTransferRequest(db, tr.request_id);
    if (!req || req.status !== "APPROVED") continue;

    const toOrg = getOrg(db, req.to_org_id);
    const fromOrg = getOrg(db, req.from_org_id);
    if (!toOrg || !fromOrg) {
      updateTransferRequestStatus(db, req.request_id, "FAILED");
      transferFailAudit(auditCh, brandCtx, req, "Org inexistent", fromOrg, toOrg);
      continue;
    }

    const member = await guild.members.fetch(req.user_id).catch(() => null);
    if (!member) {
      updateTransferRequestStatus(db, req.request_id, "FAILED");
      transferFailAudit(auditCh, brandCtx, req, "User nu este în guild", fromOrg, toOrg);
      continue;
    }

    const existing = getMembership(db, req.user_id);
    if (existing && String(existing.org_id) !== String(toOrg.id)) {
      updateTransferRequestStatus(db, req.request_id, "FAILED");
      transferFailAudit(auditCh, brandCtx, req, "User deja în altă organizație", fromOrg, toOrg);
      continue;
    }

    if (String(fromOrg.kind).toUpperCase() !== String(toOrg.kind).toUpperCase()) {
      updateTransferRequestStatus(db, req.request_id, "FAILED");
      transferFailAudit(auditCh, brandCtx, req, "Tip organizație incompatibil", fromOrg, toOrg);
      continue;
    }

    const cap = effectiveIllegalCap(toOrg);
    if (cap) {
      const dbCount = listMembersByOrg(db, toOrg.id).length;
      const memberRole = toOrg.member_role_id ? guild.roles.cache.get(toOrg.member_role_id) : null;
      const discordCount = memberRole ? memberRole.members.filter(m => !m.user?.bot).size : 0;
      const current = Math.max(dbCount, discordCount);
      if (current + 1 > cap) {
        updateTransferRequestStatus(db, req.request_id, "FAILED");
        transferFailAudit(auditCh, brandCtx, req, `Cap atins (${cap})`, fromOrg, toOrg);
        continue;
      }
    }

    const roleId = toOrg.member_role_id ? String(toOrg.member_role_id) : null;
    if (!roleId || !guild.roles.cache.get(roleId)) {
      updateTransferRequestStatus(db, req.request_id, "FAILED");
      transferFailAudit(auditCh, brandCtx, req, "Rol organizație invalid", fromOrg, toOrg);
      continue;
    }

    const res = await enqueueRoleOp({ member, roleId, action: "add", context: "transfer:complete" });
    if (!res?.ok) {
      const retries = Number(req.retry_count || 0);
      if (retries < transferRetryCount) {
        incrementTransferRetryCount(db, req.request_id);
        updateTransferRequestStatus(db, req.request_id, "APPROVED", {
          cooldown_expires_at: now + transferRetryBackoffMs
        });
        const retryReason = `Retry ${retries + 1}/${transferRetryCount} în ${Math.round(transferRetryBackoffMs / 1000)}s`;
        if (shouldSendTransferFailAudit(req.request_id, retryReason, transferFailAuditDedupMs)) {
          transferFailAudit(auditCh, brandCtx, req, retryReason, fromOrg, toOrg);
        }
      } else {
        updateTransferRequestStatus(db, req.request_id, "FAILED");
        transferFailAudit(auditCh, brandCtx, req, "Nu pot aplica rolul organizației (retry epuizat)", fromOrg, toOrg);
      }
      continue;
    }

    upsertMembership(db, req.user_id, toOrg.id, "MEMBER");
    updateTransferRequestStatus(db, req.request_id, "COMPLETED");

    if (auditCh && auditCh.isTextBased()) {
      const descLines = [
        `**Transfer ID:** \`${req.request_id}\``,
        `**Țintă:** <@${req.user_id}> (\`${req.user_id}\`)`,
        `**Din:** **${fromOrg.name}**`,
        `**Către:** **${toOrg.name}**`,
        `**Status:** ✅ finalizat`
      ];
      const eb = new EmbedBuilder()
        .setTitle("🔁 Transfer finalizat")
        .setColor(COLORS.SUCCESS)
        .setDescription(descLines.join("\n"))
        .setFooter({ text: `AUTO • ${new Date().toISOString()}` });
      applyBranding(eb, brandCtx);
      await auditCh.send({ embeds: [eb] }).catch(() => {});
    }
  }
}
