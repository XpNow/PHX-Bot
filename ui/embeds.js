import { EmbedBuilder } from 'discord.js';

export const COLORS = {
  MAFIA: 0xF59E0B,
  LEGAL: 0x2563EB,
  GLOBAL: 0x7C3AED,
  WARN: 0xEF4444,
  OK: 0x22C55E,
  COOLDOWN: 0xD97706,
  ERROR: 0xEF4444,
};

export function baseEmbed(title, color=COLORS.GLOBAL, desc=null){
  const e = new EmbedBuilder().setTitle(title).setColor(color);
  if (desc) e.setDescription(desc);
  return e;
}
