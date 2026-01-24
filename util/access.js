export function isOwner(guild, userId) {
  return guild?.ownerId === userId;
}

export function hasRole(member, roleId) {
  if (!roleId) return false;
  return member.roles.cache.has(roleId);
}

export function parseUserIds(input) {
  if (!input) return [];
  const ids = new Set();
  for (const token of input.split(/[\s,]+/).map(t=>t.trim()).filter(Boolean)) {
    const m = token.match(/^<@!?(\d+)>$/);
    if (m) ids.add(m[1]);
    else if (/^\d{15,25}$/.test(token)) ids.add(token);
  }
  return [...ids];
}

export function humanKind(kind) {
  return kind === "LEGAL" ? "Legală" : "Ilegală";
}
