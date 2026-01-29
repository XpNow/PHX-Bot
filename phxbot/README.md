# phxbot (Patch 1 - usable)

## Quick start (Windows)

1. Install Node.js 20+
2. In folder:
```powershell
npm install
npm run initdb
npm run register
npm start
```

3. Create `.env` (copy `.env.example` -> `.env`) and fill:
- DISCORD_TOKEN
- DISCORD_CLIENT_ID
- DISCORD_GUILD_ID

## Commands
- `/famenu` = admin hub (Owner/Admin/Supervisor). Owner can set config.
- `/fmenu` = organization menu (Leader/Co-Leader + org role).

## Important
Bot must have permissions:
- Manage Roles (and be ABOVE org roles + PK/BAN roles)
- Send Messages / Embed Links in configured channels
