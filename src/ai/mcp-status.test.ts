import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getMcpStatus,
  getCachedMcpStatus,
  invalidateMcpStatus,
  findCriticalDown,
  preflightMcpForRequest,
  parseCollectionsResult,
  _resetMcpStatusCache,
  type McpServerStatus,
} from "./mcp-status.ts";
import type { BotConfig } from "../bots/config.ts";

function makeBot(dir: string, opts: Partial<BotConfig> = {}): BotConfig {
  return {
    name: opts.name ?? "test-bot",
    dir,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    ...opts,
  };
}

function makeBotDir(mcp: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-status-"));
  if (mcp !== null) {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp));
  }
  return dir;
}

describe("mcp-status", () => {
  beforeEach(() => {
    _resetMcpStatusCache();
  });

  describe("getMcpStatus", () => {
    test("returns empty array when bot has no .mcp.json", async () => {
      const dir = makeBotDir(null);
      try {
        const bot = makeBot(dir, { name: "no-mcp" });
        const result = await getMcpStatus(bot);
        expect(result).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("returns empty array when .mcp.json has no mcpServers", async () => {
      const dir = makeBotDir({ other: "stuff" });
      try {
        const bot = makeBot(dir, { name: "empty-mcp" });
        const result = await getMcpStatus(bot);
        expect(result).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("classifies http entry without url as down (probe fails)", async () => {
      // An http entry pointing at a port that should refuse — fast failure.
      const dir = makeBotDir({
        mcpServers: {
          dead: { type: "http", url: "http://127.0.0.1:1/mcp" },
        },
      });
      try {
        const bot = makeBot(dir, {
          name: "down-bot",
          mcpStatus: { critical: ["dead"] },
        });
        const result = await getMcpStatus(bot);
        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("dead");
        expect(result[0]!.status).toBe("down");
        expect(result[0]!.critical).toBe(true);
        expect(result[0]!.errorMessage).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("uses cache within TTL", async () => {
      const dir = makeBotDir({
        mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      });
      try {
        const bot = makeBot(dir, {
          name: "cache-bot",
          mcpStatus: { cacheTtlMs: 60_000 },
        });
        const first = await getMcpStatus(bot);
        const firstTime = first[0]!.lastCheckedMs;
        // Second call within TTL should not re-probe — same lastCheckedMs.
        const second = await getMcpStatus(bot);
        expect(second[0]!.lastCheckedMs).toBe(firstTime);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("force option re-probes even when cache is fresh", async () => {
      const dir = makeBotDir({
        mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      });
      try {
        const bot = makeBot(dir, { name: "force-bot" });
        const first = await getMcpStatus(bot);
        // Wait one ms so timestamp definitely differs
        await new Promise((r) => setTimeout(r, 5));
        const second = await getMcpStatus(bot, { force: true });
        expect(second[0]!.lastCheckedMs).toBeGreaterThan(first[0]!.lastCheckedMs);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("concurrent calls share a single in-flight probe", async () => {
      const dir = makeBotDir({
        mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      });
      try {
        const bot = makeBot(dir, { name: "concurrent-bot" });
        const [a, b] = await Promise.all([getMcpStatus(bot), getMcpStatus(bot)]);
        // Same probe — same timestamp.
        expect(a[0]!.lastCheckedMs).toBe(b[0]!.lastCheckedMs);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("non-critical server is marked critical=false by default", async () => {
      const dir = makeBotDir({
        mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      });
      try {
        const bot = makeBot(dir, { name: "no-critical-bot" });
        const result = await getMcpStatus(bot);
        expect(result[0]!.critical).toBe(false);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("uses friendly display name when known", async () => {
      const dir = makeBotDir({
        mcpServers: {
          yggdrasil: { type: "http", url: "http://127.0.0.1:1/mcp" },
          unknown_server: { type: "http", url: "http://127.0.0.1:1/mcp" },
        },
      });
      try {
        const bot = makeBot(dir, { name: "names-bot" });
        const result = await getMcpStatus(bot);
        const ygg = result.find((s) => s.name === "yggdrasil");
        const unk = result.find((s) => s.name === "unknown_server");
        expect(ygg?.displayName).toBe("Yggdrasil");
        expect(unk?.displayName).toBe("unknown_server");
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });

  describe("getCachedMcpStatus", () => {
    test("returns null before any probe runs", () => {
      expect(getCachedMcpStatus("never-probed")).toBeNull();
    });

    test("returns cached result after probe", async () => {
      const dir = makeBotDir({
        mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      });
      try {
        const bot = makeBot(dir, { name: "cached-bot" });
        await getMcpStatus(bot);
        const cached = getCachedMcpStatus("cached-bot");
        expect(cached).not.toBeNull();
        expect(cached!).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });

  describe("invalidateMcpStatus", () => {
    test("forces next getMcpStatus to re-probe", async () => {
      const dir = makeBotDir({
        mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      });
      try {
        const bot = makeBot(dir, { name: "invalidate-bot" });
        const first = await getMcpStatus(bot);
        await new Promise((r) => setTimeout(r, 5));
        invalidateMcpStatus("invalidate-bot");
        const second = await getMcpStatus(bot);
        expect(second[0]!.lastCheckedMs).toBeGreaterThan(first[0]!.lastCheckedMs);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });

  describe("parseCollectionsResult", () => {
    test("returns undefined for non-MCP shapes", () => {
      expect(parseCollectionsResult(undefined)).toBeUndefined();
      expect(parseCollectionsResult(null)).toBeUndefined();
      expect(parseCollectionsResult({})).toBeUndefined();
      expect(parseCollectionsResult({ content: [] })).toBeUndefined();
    });

    test("parses huginn-style { name, document_count } array", () => {
      const result = {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { name: "wiki", document_count: 1234 },
              { name: "x-feed", document_count: 9871 },
            ]),
          },
        ],
      };
      expect(parseCollectionsResult(result)).toEqual([
        { name: "wiki", documentCount: 1234 },
        { name: "x-feed", documentCount: 9871 },
      ]);
    });

    test("parses { collections: [...] } wrapper", () => {
      const result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ collections: [{ name: "wiki", count: 5 }] }),
          },
        ],
      };
      expect(parseCollectionsResult(result)).toEqual([
        { name: "wiki", documentCount: 5 },
      ]);
    });

    test("parses bare string array as names without counts", () => {
      const result = {
        content: [{ type: "text", text: JSON.stringify(["a", "b", "c"]) }],
      };
      expect(parseCollectionsResult(result)).toEqual([
        { name: "a" },
        { name: "b" },
        { name: "c" },
      ]);
    });

    test("accepts `collection` key as name fallback", () => {
      const result = {
        content: [
          {
            type: "text",
            text: JSON.stringify([{ collection: "yggdrasil-wiki", size: 42 }]),
          },
        ],
      };
      expect(parseCollectionsResult(result)).toEqual([
        { name: "yggdrasil-wiki", documentCount: 42 },
      ]);
    });

    test("uses structuredContent when present", () => {
      const result = {
        structuredContent: [{ name: "wiki", document_count: 100 }],
        content: [{ type: "text", text: "ignored" }],
      };
      expect(parseCollectionsResult(result)).toEqual([
        { name: "wiki", documentCount: 100 },
      ]);
    });

    test("returns undefined when text is not JSON", () => {
      const result = {
        content: [{ type: "text", text: "not json at all" }],
      };
      expect(parseCollectionsResult(result)).toBeUndefined();
    });

    test("skips items without a usable name", () => {
      const result = {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { foo: "bar" },
              { name: "ok" },
              { collection: "alt" },
            ]),
          },
        ],
      };
      expect(parseCollectionsResult(result)).toEqual([
        { name: "ok" },
        { name: "alt" },
      ]);
    });
  });

  describe("findCriticalDown", () => {
    test("returns only servers that are critical AND down", () => {
      const servers: McpServerStatus[] = [
        { name: "a", displayName: "A", status: "ok", lastCheckedMs: 0, critical: true },
        { name: "b", displayName: "B", status: "down", lastCheckedMs: 0, critical: true },
        { name: "c", displayName: "C", status: "down", lastCheckedMs: 0, critical: false },
        { name: "d", displayName: "D", status: "ok", lastCheckedMs: 0, critical: false },
      ];
      expect(findCriticalDown(servers).map((s) => s.name)).toEqual(["b"]);
    });
  });

  describe("preflightMcpForRequest", () => {
    test("emits intent for each critical-down server", async () => {
      const dir = makeBotDir({
        mcpServers: {
          yggdrasil: { type: "http", url: "http://127.0.0.1:1/mcp" },
          gmail: { type: "http", url: "http://127.0.0.1:1/mcp" },
        },
      });
      try {
        const bot = makeBot(dir, {
          name: "preflight-bot",
          mcpStatus: { critical: ["yggdrasil"] },
        });
        const events: Array<{ type: string; text: string }> = [];
        const result = await preflightMcpForRequest(bot, (e) => events.push(e));
        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("yggdrasil");
        expect(events).toHaveLength(1);
        expect(events[0]!.text).toContain("Yggdrasil");
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("emits nothing when no critical servers are down", async () => {
      const dir = makeBotDir({
        mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      });
      try {
        const bot = makeBot(dir, {
          name: "all-noncritical-bot",
          mcpStatus: { critical: [] },
        });
        const events: Array<{ type: string; text: string }> = [];
        const result = await preflightMcpForRequest(bot, (e) => events.push(e));
        expect(result).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });
});
