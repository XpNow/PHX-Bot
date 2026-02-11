import * as repo from "../../db/repo.js";
import { makeEmbed } from "../../ui/ui.js";
import { fmtRoleMentions, getOrgRank } from "./shared.js";

function formatBool(b) {
  return b ? "✅" : "❌";
}

export async function handlePermissionsCommand(interaction, ctx) {
  const orgs = repo.listOrgs(ctx.db);
  const orgLines = [];
  for (const org of orgs) {
    const rank = getOrgRank(ctx.member, org);
    if (rank === "NONE") continue;
    orgLines.push(`• **${org.name}** (\`${org.id}\`) — ${rank}`);
  }

  const canFamenu = ctx.perms.staff || ctx.perms.configManager;
  const canFmenu = orgLines.length > 0 || ctx.perms.staff;
  const whyFamenu = canFamenu ? "OK" : "Necesită owner/admin/supervisor/config role";
  const whyFmenu = canFmenu ? "OK" : "Necesită rol Leader/Co-Leader într-o org sau staff";

  const descLines = [
    `**Admin roles:** ${fmtRoleMentions(ctx.settings.adminRole)}`,
    `**Supervisor roles:** ${fmtRoleMentions(ctx.settings.supervisorRole)}`,
    `**Config roles:** ${fmtRoleMentions(ctx.settings.configRole)}`,
    `**PK role:** ${fmtRoleMentions(ctx.settings.pkRole)}`,
    `**BAN role:** ${fmtRoleMentions(ctx.settings.banRole)}`,
    "—",
    `**Owner:** ${formatBool(ctx.perms.owner)}`,
    `**Admin:** ${formatBool(ctx.perms.admin)}`,
    `**Supervisor:** ${formatBool(ctx.perms.supervisor)}`,
    `**Config manager:** ${formatBool(ctx.perms.configManager)}`,
    "—",
    `**/famenu:** ${formatBool(canFamenu)}`,
    `• motiv: ${whyFamenu}`,
    `**/fmenu /add /rmv:** ${formatBool(canFmenu)}`,
    `• motiv: ${whyFmenu}`,
    "—",
    orgLines.length ? `**Org roles:**\n${orgLines.join("\n")}` : "**Org roles:** —"
  ];

  const emb = makeEmbed("Permisiuni bot", descLines.join("\n"));
  return interaction.reply({ embeds: [emb], ephemeral: true });
}
