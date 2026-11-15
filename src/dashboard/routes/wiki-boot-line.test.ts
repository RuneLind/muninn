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
    const hangs: GitRun = (cwd, args, opts) => (args[0] === "ls-remote" && args[1] === "--symref" ? new Promise(() => {}) : NETWORK(cwd, args, opts));
    const started = Date.now();
    const { body } = await get(app({ record: async () => record, git: hangs, boundMs: 1_500 }));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(body).toMatchObject({ row: "newer", restart: true, unread: ["origin"] });
    expect(body.text).toEndWith(" · the checkout holds 1 newer PR: #865: restart · origin not read: timed out");
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
