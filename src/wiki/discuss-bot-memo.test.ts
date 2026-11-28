import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAllBots } from "../bots/config.ts";
import { resolveDiscussBot, resolveDiscussBotHere } from "./discuss-engine.ts";
import type { WikiRegistryEntry } from "./registry.ts";
import { testTempDirSync } from "../test/temp-dir.ts";

/**
 * `resolveDiscussBotHere`'s memo (fix round 2 batch 2): it must answer what a
 * fresh discovery answers — what a turn uses — after every change
 * `wikiSynthesisInputsKey()` exists to see. Each test changes one input
 * between two calls and compares the memo with `resolveDiscussBot` over a
 * fresh `discoverAllBots()`.
 */

const ENV = ["MUNINN_BOTS_DIR", "RESEARCH_BOT", "SUMMARIZER_BOT"] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

function bot(name: string, config: Record<string, unknown>): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "CLAUDE.md"), `# ${name}\n`);
  writeFileSync(join(root, name, "config.json"), JSON.stringify(config));
}

const pinned = (pin: string): WikiRegistryEntry => ({ name: "notes", root: "/nowhere", source: "extra", synthesisBot: pin }) as WikiRegistryEntry;
const plain: WikiRegistryEntry = { name: "notes", root: "/nowhere", source: "extra" } as WikiRegistryEntry;
const fresh = (entry: WikiRegistryEntry) => {
  const hit = resolveDiscussBot(entry, discoverAllBots());
  return hit ? { bot: { name: hit.bot.name, connector: hit.bot.connector, model: hit.bot.model }, origin: hit.origin } : null;
};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.RESEARCH_BOT;
  delete process.env.SUMMARIZER_BOT;
  root = testTempDirSync(join(tmpdir(), "muninn-discuss-memo-"));
  process.env.MUNINN_BOTS_DIR = root;
});

afterEach(() => {
  try {
    chmodSync(join(root, "alpha", "config.json"), 0o644);
  } catch {
    /* not every test has it */
  }
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

test("a chmod of a bot's config.json (ctime moves, mtime does not) drops the memo", () => {
  bot("alpha", { connector: "copilot-sdk", model: "model-one" });
  const file = join(root, "alpha", "config.json");
  const before = statSync(file);
  expect(resolveDiscussBotHere(pinned("alpha"))?.bot.model).toBe("model-one");
  chmodSync(file, 0o000);
  expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
  const want = fresh(pinned("alpha"));
  expect(want?.bot.model).toBeUndefined();
  expect(resolveDiscussBotHere(pinned("alpha"))).toEqual(want);
});

test("a same-size rewrite of config.json with its old mtime restored drops the memo", () => {
  bot("alpha", { connector: "copilot-sdk", model: "model-one" });
  const file = join(root, "alpha", "config.json");
  const before = statSync(file);
  expect(resolveDiscussBotHere(pinned("alpha"))?.bot.model).toBe("model-one");
  writeFileSync(file, JSON.stringify({ connector: "copilot-sdk", model: "model-two" }));
  utimesSync(file, before.atime, before.mtime);
  const after = statSync(file);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  const want = fresh(pinned("alpha"));
  expect(want?.bot.model).toBe("model-two");
  expect(resolveDiscussBotHere(pinned("alpha"))).toEqual(want);
});

test("a CLAUDE.md removed from a bot folder (the folder's stamp) drops the memo: that bot is no longer discovered", () => {
  bot("alpha", { connector: "copilot-sdk", model: "model-one" });
  expect(resolveDiscussBotHere(pinned("alpha"))?.bot.name).toBe("alpha");
  rmSync(join(root, "alpha", "CLAUDE.md"));
  const want = fresh(pinned("alpha"));
  expect(want).toBeNull();
  expect(resolveDiscussBotHere(pinned("alpha"))).toEqual(want);
  // And added back: discovered again.
  writeFileSync(join(root, "alpha", "CLAUDE.md"), "# alpha\n");
  expect(fresh(pinned("alpha"))?.bot.name).toBe("alpha");
  expect(resolveDiscussBotHere(pinned("alpha"))).toEqual(fresh(pinned("alpha")));
});

test("SUMMARIZER_BOT moves the fallback (no fast bot) without any file change", () => {
  bot("alpha", { connector: "copilot-sdk", model: "claude-opus-5" });
  bot("beta", { connector: "copilot-sdk", model: "claude-opus-5-b" });
  process.env.SUMMARIZER_BOT = "alpha";
  expect(resolveDiscussBotHere(plain)?.bot.name).toBe("alpha");
  process.env.SUMMARIZER_BOT = "beta";
  const want = fresh(plain);
  expect(want?.bot.name).toBe("beta");
  expect(resolveDiscussBotHere(plain)).toEqual(want);
});
