import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env") });

import { REST, Routes, SlashCommandBuilder } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing env. Need DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID");
  process.exit(1);
}

function addMultiUserOptions(cmd, max = 8, { afterUser1 } = {}) {
  cmd.addUserOption(o =>
    o.setName("user")
      .setDescription("User (obligatoriu)")
      .setRequired(true)
  );

  if (typeof afterUser1 === "function") afterUser1(cmd);

  for (let i = 2; i <= max; i++) {
    cmd.addUserOption(o =>
      o.setName(`user${i}`)
        .setDescription(`User ${i} (opțional)`)
        .setRequired(false)
    );
  }

  return cmd;
}

const cmdFmenu = new SlashCommandBuilder()
  .setName("fmenu")
  .setDescription("Meniu organizatie (Lider/Co-Lider).")
  .setDMPermission(false);

const cmdFamenu = new SlashCommandBuilder()
  .setName("famenu")
  .setDescription("Meniu administrare.")
  .setDMPermission(false);

const cmdAdd = addMultiUserOptions(
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Adaugă unul sau mai mulți membri în organizația ta (bulk).")
    .setDMPermission(false),
  8
);

const cmdRmv = addMultiUserOptions(
  new SlashCommandBuilder()
    .setName("rmv")
    .setDescription("Scoate unul sau mai mulți membri din organizație (bulk).")
    .setDMPermission(false),
  8,
  {
    afterUser1: (cmd) => cmd.addBooleanOption(o =>
      o.setName("pk")
        .setDescription("Aplică PK? (DA/NU)")
        .setRequired(true)
    )
  }
).addStringOption(o =>
  o.setName("users")
    .setDescription("Extra users (mențiuni/ID-uri). Max total 30.")
    .setRequired(false)
);

const cmdPermissions = new SlashCommandBuilder()
  .setName("permissions")
  .setDescription("Arată ce permisiuni ai în bot.")
  .setDMPermission(false);

const commands = [cmdFmenu, cmdFamenu, cmdAdd, cmdRmv, cmdPermissions].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

console.log("Registering slash commands (guild)...");
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
console.log("Done.");
