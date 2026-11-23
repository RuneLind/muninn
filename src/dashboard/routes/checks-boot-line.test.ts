/**
 * `GET /api/checks/boot-line` (the boot line's peer route) over real git on a
 * throwaway repo: the closed shape, no path, no relay, the version gate, the
 * in-flight cap, and the same zone/origin treatment as `/api/checks/answer`.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SIDE_EFFECTING_GETS } from "../../auth/origin.ts";
import { decideZone } from "../../auth/zones.ts";
import { bootFixture, pull, push } from "../../test/boot-git-fixture.ts";
import { networkOrigin } from "../../test/hermetic-git.ts";
import { ProbeCache, ProbeSlots } from "../../wiki/step-checks/answer.ts";
import { BOOT_LINE_PEER_PATH, readPeerBootLine } from "../../wiki/step-checks/boot-line-peer.ts";
import { takeBootRecord, type BootRecord } from "../../wiki/step-checks/boot-record.ts";
import { BOOT_LINE_PEER_MAX_IN_FLIGHT, registerChecksBootLineRoute } from "./checks-boot-line.ts";
import type { BootLineRouteDeps } from "./wiki-boot-line.ts";

const NETWORK = networkOrigin("https://example.invalid/muninn.git");

function app(over: Partial<BootLineRouteDeps> & { record: () => Promise<BootRecord> }) {
  const deps: BootLineRouteDeps = { git: NETWORK, slots: new ProbeSlots(4), cache: new ProbeCache(), machine: "mini", ...over };
  const a = new Hono();
  registerChecksBootLineRoute(a, { machine: "mini" }, () => deps);
  return a;
}

describe("GET /api/checks/boot-line", () => {
  test("is on SIDE_EFFECTING_GETS, and admin-only under auth, as /api/checks/answer is", () => {
    expect(SIDE_EFFECTING_GETS).toContain(BOOT_LINE_PEER_PATH);
    for (const path of [BOOT_LINE_PEER_PATH, "/api/checks/answer"]) {
      expect(decideZone({ method: "GET", path, role: "user" }).allowed).toBe(false);
      expect(decideZone({ method: "GET", path, role: "user", wikiReadSlice: true }).allowed).toBe(false);
      expect(decideZone({ method: "GET", path, role: "admin" }).allowed).toBe(true);
    }
  });

  test("answers its own line in the closed shape the asking side accepts, with no path", async () => {
    const { clone, work, base } = bootFixture();
    const record = await takeBootRecord(clone, NETWORK);
    push(work, "Peer rows (#870)");
    pull(clone);
    const res = await app({ record: async () => record }).request(`${BOOT_LINE_PEER_PATH}?v=1`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(base);
    expect(raw).not.toContain('"dir"');
    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(["line", "machine", "v"]);
    expect(Object.keys(body.line).sort()).toEqual(["at", "branch", "commit", "pr", "restart", "row", "text", "unread"]);
    const read = readPeerBootLine(body, "mini");
    expect("value" in read && read.value).toMatchObject({ row: "newer", restart: true, branch: "main", commit: record.known ? record.commit.slice(0, 8) : "" });
    expect("value" in read && read.value.text).toContain("the checkout holds 1 newer PR: #870: restart");
  });

  test("never relays: a peer reader in its deps is not called and no peers go out", async () => {
    const { clone } = bootFixture();
    const record = await takeBootRecord(clone, NETWORK);
    let asked = 0;
    const res = await app({ record: async () => record, peers: async () => (asked++, []) }).request(`${BOOT_LINE_PEER_PATH}?v=1`);
    const body = await res.json();
    expect(asked).toBe(0);
    expect(body.peers).toBeUndefined();
    expect(body.line.peers).toBeUndefined();
  });

  test("another version is a 400", async () => {
    const a = app({ record: () => new Promise(() => {}) });
    expect((await a.request(BOOT_LINE_PEER_PATH)).status).toBe(400);
    expect((await a.request(`${BOOT_LINE_PEER_PATH}?v=2`)).status).toBe(400);
  });

  test(`past ${BOOT_LINE_PEER_MAX_IN_FLIGHT} requests in flight, the next is a 429 at once`, async () => {
    let release!: (r: BootRecord) => void;
    const held = new Promise<BootRecord>((r) => (release = r));
    const a = app({ record: () => held });
    const running = Array.from({ length: BOOT_LINE_PEER_MAX_IN_FLIGHT }, () => a.request(`${BOOT_LINE_PEER_PATH}?v=1`));
    await new Promise((r) => setTimeout(r, 0));
    expect((await a.request(`${BOOT_LINE_PEER_PATH}?v=1`)).status).toBe(429);
    release({ known: false, reason: "no git", at: 0 });
    for (const r of await Promise.all(running)) expect(r.status).toBe(200);
  });
});
