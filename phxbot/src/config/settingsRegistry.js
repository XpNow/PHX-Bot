export const SETTINGS_REGISTRY = [
  { key: "accept_manual_org_role_changes", label: "Manual org role changes", description: "Acceptă schimbările manuale de roluri org în runtime.", type: "bool", defaultValue: "false", category: "sync" },
  { key: "accept_manual_cooldown_role_changes", label: "Manual cooldown role changes", description: "Acceptă schimbările manuale de roluri cooldown în runtime.", type: "bool", defaultValue: "false", category: "sync" },
  { key: "policy_org_roles_downtime", label: "Downtime policy org roles", description: "Politica la startup pentru drift la roluri org (ACCEPT/REVERT).", type: "text", defaultValue: "REVERT", category: "sync" },
  { key: "policy_cooldowns_downtime", label: "Downtime policy cooldowns", description: "Politica la startup pentru drift la cooldown roles (ACCEPT/REVERT).", type: "text", defaultValue: "REVERT", category: "sync" },
  { key: "watchdog_enabled", label: "Watchdog enabled", description: "Pornește watchdog periodic.", type: "bool", defaultValue: "true", category: "watchdog" },
  { key: "watchdog_interval_min", label: "Watchdog interval", description: "Interval rulare watchdog (minute).", type: "number", defaultValue: "30", min: 5, max: 1440, category: "watchdog" },
  { key: "watchdog_startup_delay_ms", label: "Watchdog startup delay", description: "Delay startup watchdog (ms).", type: "duration", defaultValue: "5000", min: 0, category: "watchdog" },
  { key: "transfer_cooldown_ms", label: "Transfer cooldown", description: "Cooldown transfer global.", type: "duration", defaultValue: String(60 * 60 * 1000), min: 1000, category: "cooldowns" },
  { key: "org_switch_cooldown_ms", label: "Remove fără PK cooldown", description: "Cooldown remove fără PK global.", type: "duration", defaultValue: String(3 * 60 * 60 * 1000), min: 1000, category: "cooldowns" },
  { key: "pk_role_id", label: "PK role", description: "Rol cooldown PK/transfer.", type: "role", defaultValue: "", category: "roles" },
  { key: "ban_role_id", label: "BAN role", description: "Rol cooldown BAN.", type: "role", defaultValue: "", category: "roles" },
  { key: "audit_channel_id", label: "Audit channel", description: "Canal audit logs.", type: "channel", defaultValue: "", category: "channels" },
  { key: "warn_channel_id", label: "Warn channel", description: "Canal warn-uri.", type: "channel", defaultValue: "", category: "channels" },
];

export function getSettingMeta(key) {
  return SETTINGS_REGISTRY.find(s => s.key === key) || null;
}

export function formatSettingValue(meta, rawValue) {
  const v = String(rawValue ?? "").trim();
  if (!meta) return v || "(unset)";
  if (!v) return "(unset)";
  if (meta.type === "bool") return ["1", "true", "yes", "y", "on"].includes(v.toLowerCase()) ? "ON" : "OFF";
  if (meta.type === "duration") {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return v;
    const s = Math.round(n / 1000);
    if (s % 86400 === 0) return `${s / 86400} zile`;
    if (s % 3600 === 0) return `${s / 3600} ore`;
    if (s % 60 === 0) return `${s / 60} minute`;
    return `${s} sec`;
  }
  return v;
}
