import { getCtx, sendEphemeral } from "./dispatcher/shared.js";

import {
  handleFmenuCommand,
  handleAddCommand,
  handleRmvCommand,
  handleFmenuComponent,
  handleFmenuModal
} from "./dispatcher/fmenu.js";

import {
  handleFamenuCommand,
  handleFamenuComponent,
  handleFamenuModal
} from "./dispatcher/famenu.js";
import { handlePermissionsCommand } from "./dispatcher/permissions.js";

export async function handleInteraction(interaction, client) {
  const ctx = getCtx(interaction);

  if (ctx.settings.botChannel && interaction.channelId && interaction.channelId !== ctx.settings.botChannel) {
    return sendEphemeral(interaction, "Canal restricționat", `Folosește botul doar în <#${ctx.settings.botChannel}>.`);
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "fmenu") return handleFmenuCommand(interaction, ctx);
    if (interaction.commandName === "famenu") return handleFamenuCommand(interaction, ctx);
    if (interaction.commandName === "add") return handleAddCommand(interaction, ctx);
    if (interaction.commandName === "rmv") return handleRmvCommand(interaction, ctx);
    if (interaction.commandName === "permissions") return handlePermissionsCommand(interaction, ctx);
    return sendEphemeral(interaction, "Eroare", "Command necunoscut.");
  }

  if (interaction.isModalSubmit()) {
    const id = interaction.customId || "";
    if (id.startsWith("famenu:")) return handleFamenuModal(interaction, ctx);
    return handleFmenuModal(interaction, ctx);
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const id = interaction.customId || "";
    if (id.startsWith("famenu:")) return handleFamenuComponent(interaction, ctx);
    return handleFmenuComponent(interaction, ctx);
  }
}
