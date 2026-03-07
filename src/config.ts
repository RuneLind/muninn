function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n\n` +
      `  Create a .env file from the example:\n` +
      `    cp .env.example .env\n\n` +
      `  Then edit .env with your values.`,
    );
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Environment variable ${name} must be a valid integer, got: "${raw}"`);
  return parsed;
}

export function loadConfig() {
  return {
    dashboardPort: optionalEnvInt("DASHBOARD_PORT", 3010),
    claudeTimeoutMs: optionalEnvInt("CLAUDE_TIMEOUT_MS", 120000),
    claudeModel: optionalEnv("CLAUDE_MODEL", "sonnet"),
    databaseUrl: requireEnv("DATABASE_URL"),
    whisperModelPath: optionalEnv("WHISPER_MODEL_PATH", "./models/ggml-base.en.bin"),
    goalCheckIntervalMs: optionalEnvInt("GOAL_CHECK_INTERVAL_MS", 1800000),
    goalCheckEnabled: optionalEnv("GOAL_CHECK_ENABLED", "true") === "true",
    schedulerIntervalMs: optionalEnvInt(
      "SCHEDULER_INTERVAL_MS",
      optionalEnvInt("GOAL_CHECK_INTERVAL_MS", 60000),
    ),
    schedulerEnabled:
      optionalEnv("SCHEDULER_ENABLED", optionalEnv("GOAL_CHECK_ENABLED", "true")) === "true",
    logDir: optionalEnv("LOG_DIR", "./logs"),
    knowledgeApiUrl: optionalEnv("KNOWLEDGE_API_URL", "http://localhost:8321"),
    knowledgeViewableCollections: optionalEnv("KNOWLEDGE_VIEWABLE_COLLECTIONS", "").split(",").map(s => s.trim()).filter(Boolean),
    tracingEnabled: optionalEnv("TRACING_ENABLED", "true") === "true",
    tracingRetentionDays: optionalEnvInt("TRACING_RETENTION_DAYS", 7),
    promptSnapshotsRetentionDays: optionalEnvInt("PROMPT_SNAPSHOTS_RETENTION_DAYS", 3),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
