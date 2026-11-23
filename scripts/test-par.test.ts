import { describe, expect, test } from "bun:test";
import { resolveTestDatabaseUrl } from "../src/test/test-db-url.ts";
import { ChildRegistry, DEFAULT_JOBS, checkLines, childEnv, parCheck, parOrder, parseJobs, runPool, signalExitCode, slotDbName, staleDatabases, withDatabase } from "./test-par.ts";
import { junitName, type ChainLink, type ShardTable } from "./test-chain.ts";

describe("runPool", () => {
  test("never runs more than `jobs` at once, never two at once on one slot, and runs each item once", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let running = 0;
    let peak = 0;
    const busy = new Set<number>();
    const ran: number[] = [];
    const slots = new Set<number>();
    await runPool(items, 4, async (item, slot) => {
      expect(busy.has(slot)).toBe(false);
      busy.add(slot);
      slots.add(slot);
      peak = Math.max(peak, ++running);
      await Bun.sleep(1 + (item % 3));
      ran.push(item);
      running--;
      busy.delete(slot);
      return item;
    });
    expect(peak).toBe(4);
    expect([...slots].sort()).toEqual([1, 2, 3, 4]);
    expect(ran.sort((a, b) => a - b)).toEqual(items);
  });

  test("returns results in item order, and uses no more slots than items", async () => {
    const slots = new Set<number>();
    const out = await runPool(["a", "b"], 6, async (item, slot) => {
      slots.add(slot);
      await Bun.sleep(item === "a" ? 5 : 1);
      return item.toUpperCase();
    });
    expect(out).toEqual(["A", "B"]);
    expect([...slots].sort()).toEqual([1, 2]);
  });
});

describe("parOrder", () => {
  test("longest first, key breaks ties", () => {
    const cost: Record<string, number> = { a: 1, b: 9, c: 9, d: 3 };
    expect(parOrder(["a", "c", "b", "d"].map((key) => ({ key })), (l) => cost[l.key]!).map((l) => l.key)).toEqual(["b", "c", "d", "a"]);
  });
});

describe("slots", () => {
  test("a slot's database is fixed per slot and passes the `_test` guard", () => {
    expect(slotDbName(1)).toBe("muninn_par_1_test");
    expect(slotDbName(12)).toBe("muninn_par_12_test");
    expect(() => slotDbName(0)).toThrow();
    expect(() => slotDbName(1.5)).toThrow();
    const url = withDatabase("postgresql://muninn:pw@127.0.0.1:5435/muninn_test?x=1", slotDbName(3));
    expect(url).toBe("postgresql://muninn:pw@127.0.0.1:5435/muninn_par_3_test?x=1");
    expect(resolveTestDatabaseUrl({ MUNINN_TEST_DATABASE_URL: url })).toBe(url);
  });

  test("a child sees its slot's URL in both variables, the rest of the env kept", () => {
    const env = childEnv({ DATABASE_URL: "postgresql://x/muninn", HOME: "/h" }, "postgresql://x/muninn_par_2_test");
    expect(env).toEqual({ DATABASE_URL: "postgresql://x/muninn_par_2_test", MUNINN_TEST_DATABASE_URL: "postgresql://x/muninn_par_2_test", HOME: "/h" });
  });
});

describe("parseJobs", () => {
  test("default, both spellings, and refusals", () => {
    expect(parseJobs([])).toBe(DEFAULT_JOBS);
    expect(DEFAULT_JOBS).toBe(6);
    expect(parseJobs(["--jobs", "3"])).toBe(3);
    expect(parseJobs(["--jobs=10"])).toBe(10);
    for (const bad of [["--jobs"], ["--jobs", "0"], ["--jobs", "-2"], ["--jobs=x"], ["--jobs", "1.5"]]) {
      expect(() => parseJobs(bad)).toThrow();
    }
  });
});

describe("staleDatabases", () => {
  test("never muninn, muninn_test, a slot's or a kept one; only `_test` names", () => {
    const names = ["muninn", "muninn_test", "muninn_par_1_test", "muninn_par_6_test", "review662_test", "muninn_verify_x_test", "other", "muninn_test_old", "mine_test", "bad-name_test"];
    expect(staleDatabases(names, ["mine_test"])).toEqual(["muninn_verify_x_test", "review662_test"]);
    expect(staleDatabases(["muninn", "muninn_test"])).toEqual([]);
  });
});

describe("ChildRegistry", () => {
  test("kills each live child by pid once, skipping removed ones and surviving ESRCH", () => {
    const calls: [number, string][] = [];
    const reg = new ChildRegistry((pid, sig) => {
      calls.push([pid, sig]);
      if (pid === 20) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    reg.add(10);
    reg.add(20);
    reg.add(30);
    reg.add(40);
    reg.delete(40);
    expect(reg.killAll("SIGKILL")).toBe(2);
    expect(calls).toEqual([
      [10, "SIGKILL"],
      [20, "SIGKILL"],
      [30, "SIGKILL"],
    ]);
    calls.length = 0;
    expect(reg.killAll("SIGKILL")).toBe(0);
    expect(calls).toEqual([]);
  });
  test("exit codes follow the shell's 128 + signal number", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGHUP")).toBe(129);
  });
});

describe("staleDatabases and high slots", () => {
  test("a slot above the default job count is stale; slots 1..6 never are", () => {
    const names = ["muninn_par_1_test", "muninn_par_6_test", "muninn_par_7_test", "muninn_par_12_test", "muninn_par_0_test"];
    expect(staleDatabases(names)).toEqual(["muninn_par_0_test", "muninn_par_12_test", "muninn_par_7_test"]);
  });
});

describe("parCheck", () => {
  const tree = { allTestFiles: ["a.test.ts"], mockFiles: [] };
  const links: ChainLink[] = [{ key: "a.test.ts", args: ["a.test.ts"], kind: "pinned" }];
  const table: ShardTable = { groups: {}, shards: [[], ["a.test.ts"], []] };
  const junit = new Map([[junitName("a.test.ts"), `<testsuites><testsuite name="a.test.ts"><testcase name="t" time="70"/></testsuite></testsuites>`]]);
  test("checks every shard against the timing table it is given, as the CI fan-in does", () => {
    expect(parCheck({ links, table, tree, junit, timings: { "a.test.ts": 70 } })).toEqual({ problems: [], warnings: [], ran: 1 });
    const untimed = parCheck({ links, table, tree, junit, timings: {} });
    expect(untimed.warnings).toHaveLength(1);
    expect(untimed.warnings[0]).toContain("a.test.ts 70.0 s");
  });
  test("checkLines prints problems and warnings", () => {
    expect(checkLines({ problems: ["never ran: x"], warnings: ["refresh the table"], ran: 0 })).toEqual(["✗ never ran: x", "⚠ refresh the table"]);
  });
});
