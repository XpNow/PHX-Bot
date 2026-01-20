import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { openDb, setSetting } from '../src/db/db.js';

dotenv.config();

const dbPath = process.env.DB_PATH || './data/phxbot.sqlite';
const schemaPath = new URL('../src/db/schema.sql', import.meta.url);

const schemaSql = fs.readFileSync(schemaPath, 'utf8');

const db = openDb(dbPath);
db.exec(schemaSql);

// Default settings
setSetting(db, 'PK_DAYS', '3');
setSetting(db, 'AUDIT_CHANNEL_ID', '');
setSetting(db, 'ERROR_CHANNEL_ID', '');
setSetting(db, 'WARN_CHANNEL_ID', '');
setSetting(db, 'ROLE_ADMIN_ID', '');
setSetting(db, 'ROLE_SUPERVISOR_ID', '');
setSetting(db, 'ROLE_WARN_MANAGER_ID', '');
setSetting(db, 'ROLE_PK_ID', '');
setSetting(db, 'ROLE_BAN_ID', '');
setSetting(db, 'FALERT_COOLDOWN_MIN', '30');
setSetting(db, 'FALERT_NEXT_AT', '');
setSetting(db, 'AUDIT_RETENTION_DAYS', '180');

console.log(`DB initialized at: ${path.resolve(dbPath)}`);
console.log('Defaults written in settings table. Use /fmenu -> Config to set role/channel IDs.');
