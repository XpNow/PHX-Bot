import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';

export function rowButtons(...buttons){
  return new ActionRowBuilder().addComponents(buttons);
}

export function btn(id, label, style=ButtonStyle.Secondary, emoji=null){
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function select(id, placeholder, options){
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options)
  );
}
