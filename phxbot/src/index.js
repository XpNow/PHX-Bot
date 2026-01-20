import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { openDb } from './db/db.js';
import { runSchedulers } from './services/scheduler.js';
import { handleSlashCommand, handleComponentInteraction, handleModalSubmit } from './services/dispatcher.js';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const dbPath = process.env.DB_PATH || './data/phxbot.sqlite';

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

export const db = openDb(dbPath);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  runSchedulers({ client, db });
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand({ client, db, interaction });
      return;
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await handleComponentInteraction({ client, db, interaction });
      return;
    }
    if (interaction.isModalSubmit()) {
      await handleModalSubmit({ client, db, interaction });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const content = 'A aparut o eroare interna. Incearca din nou.';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => {});
      }
    }
  }
});

// Anti-evade hooks (leave/rejoin)
import { onMemberRemove, onMemberAdd } from './services/antiEvade.js';
client.on('guildMemberRemove', (member) => onMemberRemove({ client, db, member }));
client.on('guildMemberAdd', (member) => onMemberAdd({ client, db, member }));

client.login(token);
