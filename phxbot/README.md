# phxbot (Phoenix Faction + Legal Panel)

Bot Discord cu **dashboard interactiv in Discord (embeds + buttons + modals)** pentru:
- **MAFIA** (Leader/CoLeader scoped) + **Admin/Supervisor** global
- **LEGAL** (LSPD/SMURD managers scoped)
- PK cooldown (3 zile) + anti-evade (leave/rejoin => reset)
- Ban from orgs (1-6 luni, fara reset)
- Audit logging, diagnostics, reconcile, lockdown, rate limits

## 1) Cerinte
- Node.js 20+ (recomand)
- Un bot Discord creat in Developer Portal (Application + Bot)
- Bot invitat pe server cu permisiuni:
  - Manage Roles
  - Read Message History
  - Send Messages
  - View Audit Log (optional)

## 2) Setup (PC)
1. Deschide folderul proiectului.
2. Copiaza `.env.example` in `.env` si completeaza valorile:
   - DISCORD_TOKEN
   - DISCORD_CLIENT_ID
   - DISCORD_GUILD_ID (serverul tau de test)
3. Instaleaza dependintele:
   ```bash
   npm install
   ```
4. Initializeaza baza de date + setari default:
   ```bash
   npm run initdb
   ```
5. Inregistreaza slash commands in guild (test):
   ```bash
   npm run register
   ```
6. Porneste botul:
   ```bash
   npm start
   ```

## 3) Comenzi
- `/fmenu` - dashboard interactiv (ephemeral)
- `/falert` - alerta razie (global cooldown)

## 4) Config (din dashboard)
Configurarea se face din **/fmenu → Global → Config**.

Bootstrap: **owner-ul serverului (guild owner)** are access la Config chiar daca nu ai setat inca rolurile.

Setari cheie:
- Channels: audit / alert / warn / error
- Access roles: admin / supervisor / warn-manage / PK / ban
- Organizations: create/delete + rank mapping (LEADER/COLEADER/MEMBER, CHIEF/HR/DIRECTOR/DEPUTY etc.)

## 5) Fisiere importante
- `src/index.js` - entrypoint
- `src/db/*` - DB schema + access layer
- `src/commands/*` - slash commands
- `src/ui/*` - render embeds, buttons, modals

## 6) Disclaimer
Acesta este un starter functional (v0.1) cu structura corecta. Extinde in timp:
- roster complet + paginare
- warns management complet
- full reconcile per org/global
