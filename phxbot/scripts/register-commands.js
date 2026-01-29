import { REST, Routes, SlashCommandBuilder, PermissionsBitField } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing env. Need DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("fmenu")
    .setDescription("Meniu organizatie (Lider/Co-Lider)."),
  new SlashCommandBuilder()
    .setName("famenu")
    .setDescription("Meniu administrare (Owner/Admin/Supervisor).")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
].map(c=>c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

console.log("Registering slash commands (guild)...");
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
console.log("Done.");
