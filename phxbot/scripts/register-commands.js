import dotenv from 'dotenv';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error('Missing DISCORD_TOKEN / DISCORD_CLIENT_ID / DISCORD_GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('fmenu')
    .setDescription('Deschide Faction/Legal dashboard (ephemeral).'),
  new SlashCommandBuilder()
    .setName('falert')
    .setDescription('Trimite alerta razie catre toate factiunile (cooldown global).')
    .addStringOption(o => o.setName('locatie').setDescription('Unde este razia').setRequired(true))
    .addStringOption(o => o.setName('detalii').setDescription('Detalii (optional)').setRequired(false))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands (guild)...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Done.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
