import { configure, getLogger, type LogRecord, type Sink } from "@logtape/logtape";
import { getTimeRotatingFileSink } from "@logtape/file";

/**
 * Create a logger for a subsystem.
 *
 *   const log = getLog("ai", "executor");  // category: ["muninn", "ai", "executor"]
 *
 * Unconfigured loggers (e.g. in tests) are silent no-ops — no setupLogging() needed.
 */
export function getLog(...path: string[]) {
  return getLogger(["muninn", ...path]);
}

// ── ANSI colors ──────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const LEVEL_STYLES: Record<string, { label: string; color: string }> = {
  debug: { label: "DEBUG", color: "\x1b[36m" },    // cyan
  info:  { label: "INFO ", color: "\x1b[32m" },    // green
  warning: { label: "WARN ", color: "\x1b[33m" },  // yellow
  error: { label: "ERROR", color: "\x1b[31m" },    // red
  fatal: { label: "FATAL", color: "\x1b[35m" },    // magenta
};

// ── Console sink ─────────────────────────────────────────────────────────────

function formatMessage(record: LogRecord): string {
  const parts: string[] = [];
  for (const piece of record.message) {
    parts.push(String(piece));
  }
  return parts.join("");
}

function consoleSink(record: LogRecord): void {
  const style = LEVEL_STYLES[record.level] ?? { label: record.level.toUpperCase().padEnd(5), color: "" };

  // Category path: skip "muninn" prefix, join rest with "/"
  const cat = record.category.slice(1); // drop "muninn"
  const catStr = cat.length > 0 ? cat.join("/") : "root";

  // If botName is in properties, prepend as [jarvis]
  const botName = record.properties.botName as string | undefined;
  const botPrefix = botName ? `${DIM}[${botName}]${RESET} ` : "";

  const msg = formatMessage(record);

  const line = `${style.color}${style.label}${RESET} ${botPrefix}${BOLD}[${catStr}]${RESET} ${msg}`;

  if (record.level === "error" || record.level === "fatal") {
    console.error(line);
  } else if (record.level === "warning") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ── JSONL file sink ──────────────────────────────────────────────────────────

function jsonlFormatter(record: LogRecord): string {
  const obj: Record<string, unknown> = {
    ts: new Date(record.timestamp).toISOString(),
    level: record.level,
    category: record.category.slice(1).join("/"),
    message: formatMessage(record),
  };

  // Spread all structured properties (botName, userId, etc.)
  for (const [key, value] of Object.entries(record.properties)) {
    if (value !== undefined) {
      obj[key] = value;
    }
  }

  return JSON.stringify(obj) + "\n";
}

// ── Setup ────────────────────────────────────────────────────────────────────

let configured = false;

export async function setupLogging(logDir: string = "./logs"): Promise<void> {
  if (configured) return;
  configured = true;

  const sinks: Record<string, Sink> = {
    console: consoleSink,
  };

  // File sink — skip in test environments or when LOG_DIR is explicitly "none"
  if (logDir !== "none") {
    sinks.file = getTimeRotatingFileSink({
      directory: logDir,
      interval: "daily",
      maxAgeMs: 7 * 24 * 3600_000, // 7-day retention
      formatter: jsonlFormatter,
    });
  }

  await configure({
    sinks,
    loggers: [
      {
        category: ["muninn"],
        sinks: Object.keys(sinks),
        lowestLevel: "info",
      },
      {
        category: ["logtape"],
        sinks: ["console"],
        lowestLevel: "warning",
      },
    ],
  });
}
