import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } from "discord.js";
import { COLORS } from "./theme.js";

export function makeEmbed(title, desc, color = COLORS.GLOBAL) {
  const safeDesc = (desc ?? "").trim();
  const e = new EmbedBuilder()
    .setTitle(title)
    .setDescription(safeDesc || "—")
    .setColor(color);

  const brandText = (process.env.BRAND_TEXT || "Phoenix Faction Manager").trim();
  const brandIconUrl = (process.env.BRAND_ICON_URL || "").trim();
  if (brandText) {
    e.setFooter({
      text: brandText,
      ...(brandIconUrl ? { iconURL: brandIconUrl } : {})
    });
  }

  return e;
}

export function rowsFromButtons(buttons, maxPerRow=5) {
  const rows = [];
  let current = [];
  const seenCustomIds = new Set();

  for (const b of buttons) {
    if (!b) continue;

    const customId = b?.data?.custom_id || b?.toJSON?.()?.custom_id || null;
    if (customId) {
      if (seenCustomIds.has(customId)) continue;
      seenCustomIds.add(customId);
    }

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
  return (rows || []).filter(r => {
    try {
      const comps = r.components ?? [];
      return comps.length >= 1 && comps.length <= 5;
    } catch { return false; }
  }).slice(0,5);
}

export function btn(id, label, style=ButtonStyle.Secondary, emoji=null, disabled=false) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(!!disabled);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function select(id, placeholder, options) {
  return new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options);
}

export function modal(id, title, inputs) {
  const safeId = String(id || "modal").slice(0, 100);
  const safeTitle = String(title || "Form").slice(0, 45);
  const m = new ModalBuilder().setCustomId(safeId).setTitle(safeTitle);
  const rows = (Array.isArray(inputs) ? inputs : [])
    .slice(0, 5)
    .map(inp => new ActionRowBuilder().addComponents(inp));
  m.addComponents(rows);
  return m;
}

export function input(id, label, style=TextInputStyle.Short, required=true, placeholder="") {
  const safeId = String(id || "field").slice(0, 100);
  const safeLabel = String(label || "Field").slice(0, 45);
  const i = new TextInputBuilder().setCustomId(safeId).setLabel(safeLabel).setStyle(style).setRequired(required);
  if (placeholder) i.setPlaceholder(String(placeholder).slice(0, 100));
  return i;
}
