/**
 * The boot line's peer rows (`boot-line-peer.ts`): the reply check refuses the
 * whole reply on any field that is off, and the reader bounds, caches and
 * down-windows each peer on its own.
 */
import { describe, expect, test } from "bun:test";
import type { BootLine } from "./boot-line.ts";
import { BOOT_LINE_PEER_PATH, createBootLinePeerReader, readPeerBootLine, toPeerBootLine, type PeerBootLine } from "./boot-line-peer.ts";

const LINE: PeerBootLine = {
  row: "newer",
  restart: true,
  text: "started from 409bfd1a (#864) on 14.11 20:58 · the checkout holds 1 newer PR: #870: restart",
  commit: "409bfd1a",
  pr: 864,
  branch: "main",
  at: 1_700_000_000_000,
  unread: [],
};
const reply = (line: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({ v: 1, machine: "mini", line: { ...LINE, ...line }, ...over });
const refused = (body: unknown) => {
  const got = readPeerBootLine(body, "mini");
  return "refused" in got ? got.refused : null;
};

describe("readPeerBootLine", () => {
  test("a well-formed reply is taken as it is", () => {
    expect(readPeerBootLine(reply(), "mini")).toEqual({ value: LINE });
  });

  test("nulls are taken for commit, pr, branch and at", () => {
    const got = readPeerBootLine(reply({ row: "start-unknown", restart: false, commit: null, pr: null, branch: null, at: null }), "mini");
    expect("value" in got && got.value).toMatchObject({ commit: null, pr: null, branch: null, at: null });
  });

  test("the envelope: not an object, another version, another machine, no line", () => {
    expect(refused(null)).toBe("not a JSON object");
    expect(refused([reply()])).toBe("not a JSON object");
    expect(refused(reply({}, { v: 2 }))).toBe("speaks another version");
    expect(refused(reply({}, { machine: "laptop" }))).toBe("answered as another machine");
    expect(refused({ v: 1, machine: "mini" })).toBe("sent no line");
    expect(refused({ v: 1, machine: "mini", line: "x" })).toBe("sent no line");
  });

  test("an unknown row kind refuses", () => {
    expect(refused(reply({ row: "live" }))).toBe("answered a row muninn does not know");
    expect(refused(reply({ row: 3 }))).toBe("answered a row muninn does not know");
  });

  test("every field must be present", () => {
    for (const k of ["row", "restart", "text", "commit", "pr", "branch", "at", "unread"]) {
      const line: Record<string, unknown> = { ...LINE };
      delete line[k];
      expect(refused({ v: 1, machine: "mini", line })).toBe(`sent no ${k}`);
    }
  });

  test("wrong types refuse", () => {
    expect(refused(reply({ restart: "yes" }))).toContain("restart flag");
    expect(refused(reply({ text: 5 }))).toContain("text");
    expect(refused(reply({ commit: 409 }))).toContain("commit");
    expect(refused(reply({ pr: "864" }))).toContain("PR");
    expect(refused(reply({ pr: 1.5 }))).toContain("PR");
    expect(refused(reply({ pr: 0 }))).toContain("PR");
    expect(refused(reply({ at: "yesterday" }))).toContain("start time");
    expect(refused(reply({ at: -1 }))).toContain("start time");
    expect(refused(reply({ unread: "origin" }))).toContain("unread list");
    expect(refused(reply({ unread: [1] }))).toContain("unread name");
    expect(refused(reply({ branch: 7 }))).toContain("branch");
  });

  test("a bad branch refuses the whole reply", () => {
    for (const branch of ["", "-x", ".hidden", "a..b", "feat/../../etc", "a b", "a\nb", "x‮y", "a".repeat(101), "ä"]) {
      expect(refused(reply({ branch }))).toBe("sent a branch muninn does not take");
    }
    for (const branch of ["main", "boot-line-peers", "feat/x.y_z", "a".repeat(100)]) expect(refused(reply({ branch }))).toBeNull();
  });

  test("a commit that is not a lower-case sha refuses; a long one is shortened", () => {
    expect(refused(reply({ commit: "409bfd1a<b>" }))).toContain("commit");
    expect(refused(reply({ commit: "409BFD1A" }))).toContain("commit");
    const got = readPeerBootLine(reply({ commit: "a".repeat(40) }), "mini");
    expect("value" in got && got.value.commit).toBe("aaaaaaaa");
  });

  test("over-long text refuses; an empty one too", () => {
    expect(refused(reply({ text: "x".repeat(1_001) }))).toContain("too long");
    expect(refused(reply({ text: "x".repeat(1_000) }))).toBeNull();
    expect(refused(reply({ text: " \n\u0000 " }))).toBe("sent an empty text");
  });

  test("too many or over-long unread names refuse", () => {
    expect(refused(reply({ unread: Array(9).fill("origin") }))).toContain("unread list");
    expect(refused(reply({ unread: ["x".repeat(101)] }))).toContain("unread name");
  });

  test("unsafe characters in the text and unread names become one line of plain text", () => {
    const got = readPeerBootLine(reply({ text: "started\nfrom‮ x y\u0007", unread: ["the\rcheckout"] }), "mini");
    expect("value" in got && got.value.text).toBe("started from x y");
    expect("value" in got && got.value.unread).toEqual(["the checkout"]);
  });

  test("an absolute-path-looking string is just text: kept as text, for the client to escape", () => {
    const got = readPeerBootLine(reply({ text: "started from /Users/someone/<b>muninn</b>" }), "mini");
    expect("value" in got && got.value.text).toBe("started from /Users/someone/<b>muninn</b>");
  });
});

describe("toPeerBootLine", () => {
  test("takes the closed fields and no path; detached or odd refs read no branch", () => {
    const line: BootLine = {
      row: "same",
      restart: false,
      text: "started from aaaaaaaa on 14.11 20:58",
      start: { known: true, commit: "a".repeat(40), ref: "refs/heads/main", pr: 12, at: 5, tracked: "clean" },
      unread: ["origin"],
      readAt: 9,
    };
    expect(toPeerBootLine(line)).toEqual({ row: "same", restart: false, text: line.text, commit: "aaaaaaaa", pr: 12, branch: "main", at: 5, unread: ["origin"] });
    expect(toPeerBootLine({ ...line, start: { ...line.start, ref: null } as BootLine["start"] }).branch).toBeNull();
    expect(toPeerBootLine({ ...line, start: { ...line.start, ref: "refs/tags/v1" } as BootLine["start"] }).branch).toBeNull();
    expect(toPeerBootLine({ ...line, start: { known: false, reason: "no git", at: 3 } })).toMatchObject({ commit: null, pr: null, branch: null, at: null });
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createBootLinePeerReader", () => {
  test("one row per peer: an answer, a 404, a timeout and a malformed reply each on its own", async () => {
    const peers = new Map([
      ["mini", "https://mini.test"],
      ["old", "https://old.test"],
      ["slow", "https://slow.test"],
      ["junk", "https://junk.test"],
    ]);
    const urls: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      urls.push(url);
      const host = new URL(url).host;
      if (host === "mini.test") return json(reply());
      if (host === "old.test") return json({ error: "not found" }, 404);
      if (host === "junk.test") return json(reply({ row: "live" }, { machine: "junk" }));
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    };
    const started = Date.now();
    const rows = await createBootLinePeerReader({ peers, fetch, timeoutMs: 80 })();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(rows).toEqual([
      { machine: "mini", answered: true, ...LINE },
      { machine: "old", answered: false, why: "the peer answered HTTP 404" },
      { machine: "slow", answered: false, why: "the peer timed out" },
      { machine: "junk", answered: false, why: "the peer answered a row muninn does not know" },
    ]);
    expect(urls[0]).toBe(`https://mini.test${BOOT_LINE_PEER_PATH}?v=1`);
  });

  test("an answer is kept for the TTL under its machine; a failure opens the down window and is not cached", async () => {
    let clock = 1_000_000;
    let calls = 0;
    let ok = true;
    const fetch = async () => (calls++, ok ? json(reply()) : json({}, 500));
    const read = createBootLinePeerReader({ peers: new Map([["mini", "https://mini.test"]]), fetch, ttlMs: 20_000, downMs: 15_000, now: () => clock });
    expect((await read())[0]!.answered).toBe(true);
    clock += 19_999;
    expect((await read())[0]!.answered).toBe(true);
    expect(calls).toBe(1);
    clock += 1;
    ok = false;
    expect(await read()).toEqual([{ machine: "mini", answered: false, why: "the peer answered HTTP 500" }]);
    expect(calls).toBe(2);
    // Inside the down window: answered at once, no request.
    clock += 14_999;
    expect((await read())[0]).toMatchObject({ answered: false, why: "the peer was unreachable a moment ago (answered HTTP 500)" });
    expect(calls).toBe(2);
    clock += 1;
    ok = true;
    expect((await read())[0]!.answered).toBe(true);
    expect(calls).toBe(3);
  });

  test("concurrent reads share one request per peer", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = async () => {
      calls++;
      await gate;
      return json(reply());
    };
    const read = createBootLinePeerReader({ peers: new Map([["mini", "https://mini.test"]]), fetch });
    const a = read();
    const b = read();
    release();
    expect((await a)[0]!.answered).toBe(true);
    expect((await b)[0]!.answered).toBe(true);
    expect(calls).toBe(1);
  });

  test("no peers: no request", async () => {
    let calls = 0;
    const read = createBootLinePeerReader({ peers: new Map(), fetch: async () => (calls++, json(reply())) });
    expect(await read()).toEqual([]);
    expect(calls).toBe(0);
  });
});
