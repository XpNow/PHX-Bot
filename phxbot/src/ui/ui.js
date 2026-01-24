import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } from "discord.js";

export function makeEmbed(title, desc) {
  const safeDesc = (desc ?? "").trim();
  return new EmbedBuilder().setTitle(title).setDescription(safeDesc || "—");
}

export function rowsFromButtons(buttons, maxPerRow=5) {
  const rows = [];
  let current = [];
  for (const b of buttons) {
    if (!b) continue;
    current.push(b);
    if (current.length === maxPerRow) {
      rows.push(new ActionRowBuilder().addComponents(current));
      current = [];
    }
  }
  if (current.length) rows.push(new ActionRowBuilder().addComponents(current));
  return rows;
}

export function safeComponents(rows) {
  // remove empty rows
  return (rows || []).filter(r => {
    try {
      const comps = r.components ?? [];
      return comps.length >= 1 && comps.length <= 5;
    } catch { return false; }
  }).slice(0,5);
}

export function btn(id, label, style=ButtonStyle.Secondary, emoji=null) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function select(id, placeholder, options) {
  return new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options);
}

export function modal(id, title, inputs) {
  const m = new ModalBuilder().setCustomId(id).setTitle(title);
  const rows = inputs.map(inp => new ActionRowBuilder().addComponents(inp));
  m.addComponents(rows);
  return m;
}

export function input(id, label, style=TextInputStyle.Short, required=true, placeholder="") {
  const i = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (placeholder) i.setPlaceholder(placeholder);
  return i;
}
