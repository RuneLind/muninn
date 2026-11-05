/** The real loop half, in its own process: the registry memo and the answer
 *  config read the environment once, so each case boots a fresh one. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";

const LOOP_DEPS = path.join(import.meta.dir, "loop-deps.ts");
const LOGTAPE = Bun.resolveSync("@logtape/logtape", import.meta.dir);

/** Runs `steps` (a function body over `deps`, `step`, `root`), returning what each `step(...)` saw and the log lines. */
async function drive(steps: string, env: Record<string, string>, tmp: string) {
  const driver = path.join(tmp, "driver.ts");
  writeFileSync(driver, `
import { configure } from ${JSON.stringify(LOGTAPE)};
import { realTriageLoopDeps } from ${JSON.stringify(LOOP_DEPS)};
import { renameSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
const lines: string[] = [];
await configure({ sinks: { mem: (r) => void lines.push(r.level + " " + r.message.join("")) }, loggers: [{ category: "muninn", lowestLevel: "info", sinks: ["mem"] }, { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] }] });
const config = { decisionTriageRepoRoots: "/r", workMapModel: "m" };
const deps = realTriageLoopDeps(config as never, ${JSON.stringify(path.join(tmp, "logs"))})!;
const seen: unknown[] = [];
${steps}
console.log(JSON.stringify({ seen, lines }));
process.exit(0);
`);
  const proc = Bun.spawn([process.execPath, "--no-env-file", driver], {
    cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: tmp, MUNINN_BOTS_DIR: path.join(tmp, "no-bots"), DATABASE_URL: "postgresql://x@127.0.0.1:1/x_test", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!out.trim()) throw new Error(`driver printed nothing: ${err}`);
  return JSON.parse(out.trim().split("\n").pop()!) as { seen: string[][]; lines: string[] };
}

function wikis() {
  const tmp = testTempDirSync(path.join(tmpdir(), "triage-loop-deps-"));
  mkdirSync(path.join(tmp, "no-bots"));
  const a = path.join(tmp, "a");
  const b = path.join(tmp, "b");
  mkdirSync(a);
  mkdirSync(b);
  return { tmp, a, b, env: { WIKI_EXTRA: `a=${a},b=${b}`, WIKI_ANSWER_WIKIS: "a,b" } };
}

describe("the scope is read at each check", () => {
  test("a reader file broken at boot takes the wiki out only until it is whole again", async () => {
    const { tmp, a, env } = wikis();
    writeFileSync(path.join(a, ".wiki-reader.json"), "{ half a rebase");
    const { seen } = await drive(`
seen.push(await deps.wikis(["a", "b"]));
writeFileSync(${JSON.stringify(path.join(a, ".wiki-reader.json"))}, "{}");
seen.push(await deps.wikis(["a", "b"]));
`, env, tmp);
    expect(seen).toEqual([["b"], ["a", "b"]]);
  });

  test("a wiki turning unreadable at a later check drops out then, and a later call's names count", async () => {
    const { tmp, a, env } = wikis();
    const { seen } = await drive(`
seen.push(await deps.wikis(["a"]));
mkdirSync(${JSON.stringify(path.join(a, ".wiki-reader.json"))});
seen.push(await deps.wikis(["a", "b"]));
`, env, tmp);
    expect(seen).toEqual([["a"], ["b"]]);
  });

  test("an unreadable reader file is no `work` wiki: dropped with its reason, one line over two checks", async () => {
    const { tmp, a, env } = wikis();
    mkdirSync(path.join(a, ".wiki-reader.json"));
    const { seen, lines } = await drive(`
seen.push(await deps.wikis(["a", "b"]));
seen.push(await deps.wikis(["a", "b"]));
`, env, tmp);
    expect(seen).toEqual([["b"], ["b"]]);
    const dropped = lines.filter((l) => l.includes("Decision triage skips"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toStartWith("warning ");
    expect(dropped[0]).toContain(".wiki-reader.json exists but could not be read");
    expect(dropped[0]).toContain("skips a:");
  });

  test("a wiki that came back and drops again gets its line again", async () => {
    const { tmp, a, env } = wikis();
    const reader = JSON.stringify(path.join(a, ".wiki-reader.json"));
    writeFileSync(path.join(a, ".wiki-reader.json"), "{ nope");
    const { lines } = await drive(`
await deps.wikis(["a"]);
writeFileSync(${reader}, "{}");
await deps.wikis(["a"]);
writeFileSync(${reader}, "{ nope");
await deps.wikis(["a"]);
`, env, tmp);
    expect(lines.filter((l) => l.includes("Decision triage skips a:"))).toHaveLength(2);
  });

  test("one line naming what it covers, once per start, not per check", async () => {
    const { tmp, env } = wikis();
    const { lines } = await drive(`
await deps.wikis(["a", "b"]);
await deps.wikis(["a", "b"]);
await deps.wikis(["a", "b"]);
`, env, tmp);
    const covers = lines.filter((l) => l.includes("Decision triage covers"));
    expect(covers).toHaveLength(1);
    expect(covers[0]).toEndWith("covers a, b");
  });

  test("the variable set and nothing covered warns, with each wiki's reason", async () => {
    const { tmp, env } = wikis();
    const { seen, lines } = await drive(`seen.push(await deps.wikis(["c"]));`, { ...env, WIKI_ANSWER_WIKIS: "a" }, tmp);
    expect(seen).toEqual([[]]);
    expect(lines.some((l) => l.startsWith("warning ") && l.includes("covers nothing"))).toBe(true);
    expect(lines.some((l) => l.includes("Decision triage skips c:"))).toBe(true);
  });

  test("a wiki dropped for a fault still gets the two-nights warning", async () => {
    const { tmp, a, env } = wikis();
    mkdirSync(path.join(a, ".wiki-reader.json"));
    const logDir = path.join(tmp, "logs");
    mkdirSync(logDir);
    const line = { type: "run", runId: "r", at: Date.now() - 4 * 86_400_000, wiki: "a", model: "m", promptVersion: "p", usage: { calls: 0 }, repoRoots: null, repos: [], cards: 0, floor: null, outcome: "ok" };
    writeFileSync(path.join(logDir, "a.jsonl"), `${JSON.stringify(line)}\n`);
    const { lines } = await drive(`await deps.wikis(["a", "b"]);`, env, tmp);
    expect(lines.some((l) => l.includes("a has") && l.includes("nights with no run line"))).toBe(true);
    rmSync(logDir, { recursive: true });
  });

  test("a failed record: the state counts it and the night has its run line", async () => {
    const { tmp, env } = wikis();
    const { seen } = await drive(`
await deps.recordFailed("a", "the pass timed out");
seen.push(await deps.readState("a"));
`, env, tmp);
    expect((seen[0] as unknown as { attempts: { outcome: string; error: string }[] }).attempts[0]).toMatchObject({ outcome: "failed", error: "the pass timed out" });
    const run = JSON.parse(readFileSync(path.join(tmp, "logs", "a.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(run).toMatchObject({ type: "run", wiki: "a", outcome: "failed", reason: "the pass timed out", cards: 0 });
  });
});
