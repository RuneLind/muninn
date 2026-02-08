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
    dashboardPort: parseInt(optionalEnv("DASHBOARD_PORT", "3000"), 10),
    claudeTimeoutMs: parseInt(optionalEnv("CLAUDE_TIMEOUT_MS", "120000"), 10),
    claudeModel: optionalEnv("CLAUDE_MODEL", "sonnet"),
    databaseUrl: requireEnv("DATABASE_URL"),
    whisperModelPath: optionalEnv("WHISPER_MODEL_PATH", "./models/ggml-base.en.bin"),
    goalCheckIntervalMs: parseInt(optionalEnv("GOAL_CHECK_INTERVAL_MS", "1800000"), 10),
    goalCheckEnabled: optionalEnv("GOAL_CHECK_ENABLED", "true") === "true",
    schedulerIntervalMs: parseInt(
      optionalEnv("SCHEDULER_INTERVAL_MS", optionalEnv("GOAL_CHECK_INTERVAL_MS", "60000")),
      10,
    ),
    schedulerEnabled:
      optionalEnv("SCHEDULER_ENABLED", optionalEnv("GOAL_CHECK_ENABLED", "true")) === "true",
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
