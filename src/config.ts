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

/**
 * Boolean env flag accepting `1` / `true` (case-insensitive, trimmed). Distinct
 * from the `=== "true"` idiom used below because the flags that use it are
 * documented as `NAME=1`.
 */
export function optionalEnvFlag(name: string): boolean {
  const raw = (process.env[name] || "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * `MUNINN_WIKI_READONLY=1` — this instance must make NO programmatic wiki page
 * CONTENT writes. Exported as a function (not only a `loadConfig()` field)
 * because the enforcement seams live below the config layer and must not
 * require `DATABASE_URL`, which `loadConfig` demands.
 *
 * Deliberately narrow: it forbids page writes, NOT git. `commitWikiChange` stays
 * unguarded so the repo-sync loop on a readonly instance can still commit/push.
 */
export function wikiReadonlyFromEnv(): boolean {
  return optionalEnvFlag("MUNINN_WIKI_READONLY");
}

/** The scheduler switch, as its own function so the `/models` machine card can
 *  report it without constructing a full `Config`. */
export function schedulerEnabledFromEnv(): boolean {
  return optionalEnv("SCHEDULER_ENABLED", optionalEnv("GOAL_CHECK_ENABLED", "true")) === "true";
}

export function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Environment variable ${name} must be a valid integer, got: "${raw}"`);
  return parsed;
}

export function loadConfig() {
  const whisperModelPath = optionalEnv("WHISPER_MODEL_PATH", "./models/ggml-base.en.bin");
  return {
    dashboardPort: optionalEnvInt("DASHBOARD_PORT", 3010),
    claudeTimeoutMs: optionalEnvInt("CLAUDE_TIMEOUT_MS", 120000),
    claudeModel: optionalEnv("CLAUDE_MODEL", "sonnet"),
    databaseUrl: requireEnv("DATABASE_URL"),
    whisperModelPath,
    // TikTok summarizer transcription model. Falls back to the shared whisper
    // model so English-only bots keep working; set TIKTOK_WHISPER_MODEL_PATH to
    // a multilingual model (e.g. ggml-base.bin) without touching Telegram voice.
    tiktokWhisperModelPath: optionalEnv("TIKTOK_WHISPER_MODEL_PATH", whisperModelPath),
    schedulerIntervalMs: optionalEnvInt(
      "SCHEDULER_INTERVAL_MS",
      optionalEnvInt("GOAL_CHECK_INTERVAL_MS", 60000),
    ),
    schedulerEnabled: schedulerEnabledFromEnv(),
    /** No programmatic wiki PAGE writes from this instance (git still allowed). */
    wikiReadonly: wikiReadonlyFromEnv(),
    logDir: optionalEnv("LOG_DIR", "./logs"),
    knowledgeApiUrl: optionalEnv("KNOWLEDGE_API_URL", "http://localhost:8321"),
    knowledgeViewableCollections: optionalEnv("KNOWLEDGE_VIEWABLE_COLLECTIONS", "").split(",").map(s => s.trim()).filter(Boolean),
    yggdrasilMcpUrl: optionalEnv("YGGDRASIL_MCP_URL", "http://127.0.0.1:9130"),
    tracingEnabled: optionalEnv("TRACING_ENABLED", "true") === "true",
    tracingRetentionDays: optionalEnvInt("TRACING_RETENTION_DAYS", 7),
    tracingCaptureToolOutputs: optionalEnv("TRACING_CAPTURE_TOOL_OUTPUTS", "true") === "true",
    promptSnapshotsRetentionDays: optionalEnvInt("PROMPT_SNAPSHOTS_RETENTION_DAYS", 3),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
