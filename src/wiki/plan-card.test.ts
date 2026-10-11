import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentLensFor,
  isPlanCardId,
  isPlanCardSince,
  parsePlanCardJson,
  planCardArgs,
  planCardChildEnv,
  planCardConfigFromEnv,
  planCardRootFor,
  planCardRoots,
} from "./plan-card.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "plan-card-cfg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const mimir = path.join(tmp, "source/private/mimir");
mkdirSync(mimir, { recursive: true });
const wikiA = path.join(tmp, "a");
mkdirSync(wikiA);

describe("plan-card's roots, mirrored", () => {
  test("unset: its two defaults under ~/source, a missing one dropped", () => {
    expect(planCardRoots({}, tmp)).toEqual([mimir]);
  });
  test("WIKI_STAMP_ROOTS: `:`-split, `~` expanded, missing dropped", () => {
    expect(planCardRoots({ WIKI_STAMP_ROOTS: `${wikiA}:~/source/private/mimir:/no/such` }, tmp)).toEqual([wikiA, mimir]);
  });
  test("a root matches by equality, never as a parent", () => {
    expect(planCardRootFor(wikiA, [wikiA])).toBe(wikiA);
    expect(planCardRootFor(path.join(wikiA, "sub"), [wikiA])).toBeNull();
    expect(planCardRootFor(wikiA + "/", [wikiA])).toBe(wikiA);
  });
});

describe("D7: the Agent lens's scope", () => {
  const config = { bin: "/x/plan-card.ts", roots: [wikiA] };
  const base = { config, wikiDir: wikiA, hasPlanStatus: true, admin: true };
  test("offered only with the variable, plan_status, a plan-card root and an admin", () => {
    expect(agentLensFor(base)).toBe(true);
    expect(agentLensFor({ ...base, config: { ...config, bin: null } })).toBe(false);
    expect(agentLensFor({ ...base, hasPlanStatus: false })).toBe(false);
    expect(agentLensFor({ ...base, admin: false })).toBe(false);
    expect(agentLensFor({ ...base, wikiDir: mimir })).toBe(false);
    expect(agentLensFor({ ...base, wikiDir: undefined })).toBe(false);
  });
  test("the variable must be absolute and the profile default", () => {
    expect(planCardConfigFromEnv({ PLAN_CARD_BIN: "/x/p.ts" }).bin).toBe("/x/p.ts");
    expect(planCardConfigFromEnv({ PLAN_CARD_BIN: "rel/p.ts" }).bin).toBeNull();
    expect(planCardConfigFromEnv({ PLAN_CARD_BIN: " " }).bin).toBeNull();
    expect(planCardConfigFromEnv({ PLAN_CARD_BIN: "/x/p.ts", MUNINN_PROFILE: "nais" }).bin).toBeNull();
  });
});

describe("argv and environment", () => {
  test("since and id are checked before argv", () => {
    expect(isPlanCardSince("2026-10-07")).toBe(true);
    for (const v of ["2026-02-30", "26-10-07", "2026-10-07x", "--full"]) expect(isPlanCardSince(v)).toBe(false);
    for (const v of ["D7", "S12", "Q-14", "MEL-545776"]) expect(isPlanCardId(v)).toBe(true);
    for (const v of ["-rf", "--full", "D1 x", "D1;x", "Q-", "x".repeat(41), ""]) expect(isPlanCardId(v)).toBe(false);
    expect(planCardArgs("/b.ts", "/w/p.mdx", { since: "2026-10-07", id: "D1" })).toEqual(["/b.ts", "/w/p.mdx", "--since", "2026-10-07", "--id", "D1", "--json"]);
    expect(planCardArgs("/b.ts", "/w/p.mdx", {})).toEqual(["/b.ts", "/w/p.mdx", "--json"]);
  });
  test("the child gets the allowlist and PLAN_CARD_MUNINN_URL, nothing else", () => {
    const env = planCardChildEnv(3010, { PATH: "/bin", HOME: "/h", TMPDIR: "/t", WIKI_STAMP_ROOTS: "/w", CLAUDE_USAGE_URL: "http://cu", DATABASE_URL: "x", PLAN_CARD_CLAUDE_USAGE_HOSTS: "y" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", TMPDIR: "/t", WIKI_STAMP_ROOTS: "/w", CLAUDE_USAGE_URL: "http://cu", PLAN_CARD_MUNINN_URL: "http://127.0.0.1:3010" });
    expect(planCardChildEnv(1, {})).toEqual({ PLAN_CARD_MUNINN_URL: "http://127.0.0.1:1" });
  });
  test("parsePlanCardJson accepts the --json shape only", () => {
    expect(parsePlanCardJson('{"text":"t","chars":1,"cuts":[{"section":"log","pointer":"p"},{"bad":1}]}\n')).toEqual({ text: "t", chars: 1, cuts: [{ section: "log", pointer: "p" }] });
    expect(parsePlanCardJson("# card as text")).toBeNull();
    expect(parsePlanCardJson('{"error":"x"}')).toBeNull();
  });
});
