import { Client, GatewayIntentBits, Partials } from "discord.js";
import { handleInteraction } from "./services/dispatcher.js";
import { runSchedulers } from "./services/scheduler.js";
import { openDb, ensureSchema, getSetting } from "./db/db.js";
import * as repo from "./db/repo.js";

console.log("[INDEX] starting...");

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[INDEX] DISCORD_TOKEN missing. Check .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

const schedulerDb = openDb();
ensureSchema(schedulerDb);

client.once("ready", () => {
  console.log(`[INDEX] Logged in as ${client.user.tag}`);
  runSchedulers({ client, db: schedulerDb });
});

// Anti-evade: when user rejoins, reapply cooldown roles
client.on("guildMemberAdd", async (member) => {
  const db = openDb();
  try {
    ensureSchema(db);
    const pkRole = getSetting(db, "pk_role_id");
    const banRole = getSetting(db, "ban_role_id");

    const pk = repo.getCooldown(db, member.id, "PK");
    const ban = repo.getCooldown(db, member.id, "BAN");
    const now = Date.now();

    if (pk && pk.expires_at > now && pkRole) {
      // reset to 3 days on rejoin (evade penalty)
      const newExp = now + 3 * 24 * 60 * 60 * 1000;
      repo.upsertCooldown(db, member.id, "PK", newExp, pk.last_org_id, pk.last_left_at || now);
      await member.roles.add(pkRole).catch(()=>{});
    }
    if (ban && ban.expires_at > now && banRole) {
      await member.roles.add(banRole).catch(()=>{});
    }
  } finally {
    db.close();
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    await handleInteraction(interaction, client);
  } catch (err) {
    console.error("[INDEX] interaction error:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "A apărut o eroare internă. Încearcă din nou.", ephemeral: true });
      }
    } catch {}
  }
});

client.login(token).catch((e) => {
  console.error("[INDEX] Login failed:", e);
  process.exit(1);
});
