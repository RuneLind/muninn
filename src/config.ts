function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export function loadConfig() {
  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: requireEnv("TELEGRAM_ALLOWED_USER_IDS")
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id)),
    dashboardPort: parseInt(optionalEnv("DASHBOARD_PORT", "3000"), 10),
    claudeTimeoutMs: parseInt(optionalEnv("CLAUDE_TIMEOUT_MS", "120000"), 10),
    claudeModel: optionalEnv("CLAUDE_MODEL", "sonnet"),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
