/**
 * `GET /api/wiki/boot-line` over real git on throwaway repos
 * (`src/test/boot-git-fixture.ts`): local reads on every request, origin's
 * answer cached 30 s under the route's own key, every git call in a slot with
 * `CHECKOUT_GIT_ENV`, the time bound, the 500 path, no path in the payload,
 * and the zone (admin-only).
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SIDE_EFFECTING_GETS } from "../../auth/origin.ts";
import { decideZone } from "../../auth/zones.ts";
import { bootFixture, pull, push } from "../../test/boot-git-fixture.ts";
import { networkOrigin } from "../../test/hermetic-git.ts";
import type { GitRun } from "../../wiki/decision-triage/git.ts";
import { ProbeCache, ProbeSlots } from "../../wiki/step-checks/answer.ts";
import type { BootLine } from "../../wiki/step-checks/boot-line.ts";
import { takeBootRecord, type BootRecord } from "../../wiki/step-checks/boot-record.ts";
import { CHECKOUT_GIT_ENV, readOriginHead, type OriginHeadRead } from "../../wiki/step-checks/probes.ts";
import { BOOT_LINE_PATH, registerWikiBootLineRoute, type BootLineRouteDeps } from "./wiki-boot-line.ts";

const NETWORK = networkOrigin("https://example.invalid/muninn.git");

class CountingSlots extends ProbeSlots {
  runs = 0;
  override run<T>(fn: () => Promise<T>): Promise<T> {
    this.runs++;
    return super.run(fn);
  }
}

function app(over: Partial<BootLineRouteDeps> & { record: () => Promise<BootRecord> }) {
  const deps: BootLineRouteDeps = { git: NETWORK, slots: new ProbeSlots(4), cache: new ProbeCache(), ...over };
  const a = new Hono();
  registerWikiBootLineRoute(a, () => deps);
  return a;
}

const get = async (a: Hono) => {
  const res = await a.request(BOOT_LINE_PATH);
  return { status: res.status, raw: await res.clone().text(), body: (await res.json()) as BootLine };
};

describe("GET /api/wiki/boot-line", () => {
  test("is on SIDE_EFFECTING_GETS, and admin-only under auth", () => {
    expect(SIDE_EFFECTING_GETS).toContain(BOOT_LINE_PATH);
    expect(decideZone({ method: "GET", path: BOOT_LINE_PATH, role: "user" }).allowed).toBe(false);
    expect(decideZone({ method: "GET", path: BOOT_LINE_PATH, role: "user", wikiReadSlice: true }).allowed).toBe(false);
    expect(decideZone({ method: "GET", path: BOOT_LINE_PATH, role: "admin" }).allowed).toBe(true);
  });

  test("local reads run on every request (a pull shows on the next read); ls-remote at most once per 30 s", async () => {
    const { clone, work } = bootFixture();
    const record = await takeBootRecord(clone, NETWORK);
    let clock = 1_000_000;
    let origins = 0;
    const originHead: OriginHeadRead = (dir, git) => (origins++, readOriginHead(dir, git));
    const a = app({ record: async () => record, cache: new ProbeCache(() => clock), originHead });
    expect((await get(a)).body.row).toBe("same");
    push(work, "Merged after start (#865)");
    // Origin's answer is still the cached one: the checkout holds that old tip.
    expect((await get(a)).body.text).not.toContain("origin has commits");
    clock += 30_000;
    expect((await get(a)).body.text).toEndWith(" · origin has commits this checkout lacks: pull");
    expect(origins).toBe(2);
    pull(clone);
    const after = (await get(a)).body;
    expect(after.row).toBe("newer");
    expect(after.text).toContain(" · the checkout holds 1 newer PR: #865: restart");
    expect(after.text).not.toContain("origin has commits");
    expect(origins).toBe(2);
  });

  test("every git call takes a slot and carries CHECKOUT_GIT_ENV", async () => {
    const { clone, work } = bootFixture();
    const record = await takeBootRecord(clone, NETWORK);
    push(work, "Keep focus (#865)");
    pull(clone);
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    const spy: GitRun = (cwd, args, opts) => {
      envs.push(opts?.env);
      return NETWORK(cwd, args, opts);
    };
    const slots = new CountingSlots(4);
    const { body } = await get(app({ record: async () => record, git: spy, slots }));
    expect(body.row).toBe("newer");
    expect(envs.length).toBeGreaterThan(8);
    expect(slots.runs).toBe(envs.length);
    for (const env of envs) expect(env).toMatchObject(CHECKOUT_GIT_ENV);
  });

  test("past the bound it answers with what it has, and names what it did not read", async () => {
    const { clone, work } = bootFixture();
    const record = await takeBootRecord(clone, NETWORK);
    push(work, "Keep focus (#865)");
    pull(clone);
    // The bound expires once the row (its last call, `log`) and the status are read and origin
    // hangs in `ls-remote`: no machine speed decides what was read in time.
    let expire!: () => void;
    const expiry = new Promise<void>((resolve) => (expire = resolve));
    const waiting = new Set(["log", "status", "ls-remote"]);
    const done = (what: string) => {
      waiting.delete(what);
      // A macrotask later: the reads' remaining steps after their last call are microtasks.
      if (waiting.size === 0) setTimeout(expire, 0);
    };
    const hangs: GitRun = async (cwd, args, opts) => {
      if (args[0] === "ls-remote" && args[1] === "--symref") return done("ls-remote"), new Promise(() => {});
      const res = await NETWORK(cwd, args, opts);
      for (const what of ["log", "status"]) if (args.includes(what)) done(what);
      return res;
    };
    const { body } = await get(app({ record: async () => record, git: hangs, expiry: () => expiry }));
    expect(body).toMatchObject({ row: "newer", restart: true, unread: ["origin"] });
    expect(body.text).toEndWith(" · the checkout holds 1 newer PR: #865: restart · origin not read: timed out");
  });

  test("past the bound, the request's git calls that have not started never start", async () => {
    const slots = new ProbeSlots(1);
    let release!: () => void;
    const held = slots.run(() => new Promise<void>((resolve) => (release = resolve)));
    let calls = 0;
    const counting: GitRun = async () => (calls++, { ok: false, stdout: "", stderr: "fatal: no", exitCode: 128 });
    const record: BootRecord = { known: true, dir: "/nowhere", commit: "a".repeat(40), ref: "refs/heads/main", pr: null, tracked: { state: "clean" }, at: 0 };
    const { body } = await get(app({ record: async () => record, git: counting, slots, boundMs: 50 }));
    expect(body).toMatchObject({ row: "unread", unread: ["the checkout", "tracked files", "origin"] });
    release();
    await held;
    // Slots hand over first in, first out: this runs after every call queued before it.
    await slots.run(async () => {});
    expect(calls).toBe(0);
  });

  describe("a request whose bound expired never hands its origin read to another request", () => {
    /** Lets the expired request's remaining steps (microtasks and cancelled calls) run out. */
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const never = () => new Promise<void>(() => {});
    /** One route, per-request deps over one shared origin cache; counts the real `ls-remote --symref` runs. */
    function twoRequests(record: BootRecord) {
      const cache = new ProbeCache();
      const symref = { runs: 0 };
      const counted = (base: GitRun): GitRun => (cwd, args, opts) => {
        if (args[0] === "ls-remote" && args[1] === "--symref") symref.runs++;
        return base(cwd, args, opts);
      };
      const perRequest: BootLineRouteDeps[] = [];
      const a = new Hono();
      registerWikiBootLineRoute(a, () => perRequest.shift()!);
      const ask = (over: Partial<BootLineRouteDeps>) => {
        const raw = over.git ?? NETWORK;
        perRequest.push({ record: async () => record, slots: new ProbeSlots(4), cache, ...over, git: counted(raw) });
        return get(a);
      };
      return { ask, symref };
    }

    test("B after A's bound expired before A reached ls-remote: B reads origin for real", async () => {
      const { clone } = bootFixture();
      const record = await takeBootRecord(clone, NETWORK);
      const { ask, symref } = twoRequests(record);
      // A's bound expires while its `ls-remote --get-url` (the call before origin's read) is running.
      let expireA!: () => void;
      const expiryA = new Promise<void>((resolve) => (expireA = resolve));
      let getUrlDone!: Promise<void>;
      const slowGetUrl: GitRun = async (cwd, args, opts) => {
        if (args[0] === "ls-remote" && args[1] === "--get-url") {
          expireA();
          getUrlDone = settle();
          await getUrlDone;
        }
        return NETWORK(cwd, args, opts);
      };
      const a = await ask({ git: slowGetUrl, expiry: () => expiryA });
      expect(a.body.unread).toContain("origin");
      await getUrlDone;
      await settle();
      // A's own origin read, due after its bound, never began.
      expect(symref.runs).toBe(0);
      const b = await ask({ expiry: never });
      expect(b.body.text).not.toContain("origin not read");
      expect(b.body.unread).toEqual([]);
      expect(symref.runs).toBe(1);
    });

    test("B shares A's in-flight read whose ls-remote had not started when A's bound expired: B gets origin's answer", async () => {
      const { clone } = bootFixture();
      const record = await takeBootRecord(clone, NETWORK);
      const { ask, symref } = twoRequests(record);
      // A's one slot is held while its `ls-remote --symref` waits for it; A's bound expires then.
      const slotsA = new ProbeSlots(1);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let blocker: Promise<void> | null = null;
      const blocking: GitRun = (cwd, args, opts) => {
        if (args[0] === "ls-remote" && args[1] === "--get-url" && !blocker) blocker = slotsA.run(() => held);
        return NETWORK(cwd, args, opts);
      };
      let originStarted!: () => void;
      const started = new Promise<void>((resolve) => (originStarted = resolve));
      const originHead: OriginHeadRead = (dir, git) => (originStarted(), readOriginHead(dir, git));
      let expireA!: () => void;
      const expiryA = new Promise<void>((resolve) => (expireA = resolve));
      const a = ask({ git: blocking, slots: slotsA, originHead, expiry: () => expiryA });
      await started;
      await settle();
      expireA();
      expect((await a).body.unread).toContain("origin");
      expect(symref.runs).toBe(0);
      // B's local reads run on its own slots; its origin read is A's cache entry, still waiting.
      const b = ask({ expiry: never });
      await settle();
      release();
      const body = (await b).body;
      expect(body.text).not.toContain("origin not read");
      expect(body.unread).toEqual([]);
      expect(symref.runs).toBe(1);
    });
  });

  test("a start record still being read past the bound: says so", async () => {
    const { body } = await get(app({ record: () => new Promise(() => {}), boundMs: 50 }));
    expect(body).toMatchObject({ row: "start-unknown", unread: ["the start record"] });
  });

  test("500 when the line cannot be built", async () => {
    const { status, body } = await get(app({ record: () => Promise.reject(new Error("boom")) }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "the boot line could not be read" } as unknown as BootLine);
  });

  test("the payload never carries the checkout's path", async () => {
    const { clone, base } = bootFixture();
    const record = await takeBootRecord(clone, NETWORK);
    const { raw, body } = await get(app({ record: async () => record }));
    expect(body.start.known).toBe(true);
    expect(raw).not.toContain(base);
    expect(raw).not.toContain('"dir"');
  });
});
