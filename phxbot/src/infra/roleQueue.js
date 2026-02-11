import { setTimeout as delay } from "node:timers/promises";
import { openDb, ensureSchema, getSetting } from "../db/db.js";

const inFlight = new Set();
const memberChains = new Map();

function parseConcurrency(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), 10));
}

function getInitialConcurrency() {
  if (process.env.ROLE_OP_CONCURRENCY) {
    return parseConcurrency(process.env.ROLE_OP_CONCURRENCY, 3);
  }
  try {
    const db = openDb();
    ensureSchema(db);
    const raw = getSetting(db, "role_op_concurrency");
    db.close();
    return parseConcurrency(raw, 3);
  } catch (err) {
    console.error("[roleQueue] failed to read role_op_concurrency setting:", err);
    return 3;
  }
}

let concurrency = getInitialConcurrency();
const limiter = makeSemaphore(concurrency);

function keyFor(op) {
  return `${op.action}:${op.guildId}:${op.userId}:${op.roleId}`;
}

function memberKeyFor(op) {
  return `${op.guildId}:${op.userId}`;
}

function makeSemaphore(max) {
  let permits = max;
  let maxPermits = max;
  const waiters = [];
  return {
    async acquire() {
      if (permits > 0) {
        permits--;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
      permits--;
    },
    release() {
      permits = Math.min(permits + 1, maxPermits);
      if (waiters.length && permits > 0) {
        const resolve = waiters.shift();
        resolve();
      }
    },
    setMax(nextMax) {
      const clamped = Math.max(1, Math.min(Math.floor(nextMax), 10));
      maxPermits = clamped;
      if (permits > maxPermits) {
        permits = maxPermits;
      }
      while (waiters.length && permits > 0) {
        permits--;
        const resolve = waiters.shift();
        resolve();
      }
    }
  };
}

export function setRoleOpConcurrency(value) {
  const next = parseConcurrency(value, concurrency);
  concurrency = next;
  limiter.setMax(next);
  return concurrency;
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 150);
}

function toMsMaybeSeconds(x) {
  if (!Number.isFinite(x)) return 0;
  return x > 1000 ? x : Math.round(x * 1000);
}

function getRetryMs(err) {
  const a = err?.retryAfter;
  if (Number.isFinite(a)) return Math.max(0, a);
  const b = err?.retry_after;
  if (Number.isFinite(b)) return Math.max(0, toMsMaybeSeconds(b));
  const c = err?.data?.retry_after;
  if (Number.isFinite(c)) return Math.max(0, toMsMaybeSeconds(c));
  const d = err?.rawError?.retry_after;
  if (Number.isFinite(d)) return Math.max(0, toMsMaybeSeconds(d));
  return 0;
}

async function runOp(op) {
  const k = keyFor(op);
  if (inFlight.has(k)) return { ok: true, deduped: true };
  inFlight.add(k);

  await limiter.acquire();
  try {
    const { member, roleId, action, context } = op;

    if (!member || !roleId) return { ok: false, reason: "INVALID_ARGS" };

    if (action === "add" && member.roles.cache.has(roleId)) return { ok: true, skipped: true };
    if (action === "remove" && !member.roles.cache.has(roleId)) return { ok: true, skipped: true };

    const guild = member.guild;
    const role = guild?.roles?.cache?.get(roleId) || null;
    const botMember = guild?.members?.me || null;

    if (!role) return { ok: false, reason: "ROLE_NOT_FOUND" };
    if (!botMember) return { ok: false, reason: "BOT_MEMBER_MISSING" };
    if (botMember.roles.highest.position <= role.position) return { ok: false, reason: "HIERARCHY_BLOCKED" };

    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (action === "add") await member.roles.add(roleId, context || undefined);
        else await member.roles.remove(roleId, context || undefined);
        return { ok: true };
      } catch (err) {
        const status = err?.status ?? err?.httpStatus ?? err?.rawError?.status;
        const code = err?.code ?? err?.rawError?.code;

        if (code === 50013 || status === 403) return { ok: false, reason: "MISSING_PERMISSIONS", error: err };
        const retryMs = getRetryMs(err);
        if (status === 429 || retryMs > 0) {
          if (attempt === maxAttempts) return { ok: false, reason: "RATE_LIMIT", error: err };
          await delay(jitter(Math.max(750, retryMs)));
          continue;
        }
        const transient = (status >= 500) || status === 0 || status === undefined;
        if (transient && attempt < maxAttempts) {
          await delay(jitter(500 * attempt));
          continue;
        }
        return { ok: false, error: err };
      }
    }

    return { ok: false, reason: "UNKNOWN" };
  } finally {
    limiter.release();
    inFlight.delete(k);
  }
}

export function enqueueRoleOp({ member, roleId, action, context = "" }) {
  const op = {
    member,
    roleId,
    action,
    context,
    guildId: member.guild?.id || "0",
    userId: member.id || "0",
  };

  const mk = memberKeyFor(op);
  const prev = memberChains.get(mk) || Promise.resolve();

  const next = prev
    .then(() => runOp(op))
    .finally(() => {
      if (memberChains.get(mk) === next) memberChains.delete(mk);
    });

  memberChains.set(mk, next);
  return next;
}
