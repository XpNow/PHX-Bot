export const COLORS = {
  MAFIA: 0xF59E0B,
  LSPD: 0x2563EB,
  SMURD: 0xFACC15,
  GLOBAL: 0x7C3AED,
  ERROR: 0xEF4444,
  SUCCESS: 0x22C55E,
  WARN: 0xEF4444,
  COOLDOWN: 0xD97706
};

export function orgColor(org) {
  if (!org) return COLORS.GLOBAL;
  if (org.type === 'MAFIA') return COLORS.MAFIA;
  // Legal: choose by name heuristic
  const n = (org.name || '').toLowerCase();
  if (n.includes('lspd') || n.includes('pol')) return COLORS.LSPD;
  if (n.includes('smurd') || n.includes('med')) return COLORS.SMURD;
  return COLORS.GLOBAL;
}
