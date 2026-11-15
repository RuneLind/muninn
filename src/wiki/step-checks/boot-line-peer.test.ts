/**
 * The boot line's peer rows (`boot-line-peer.ts`): the reply check refuses the
 * whole reply on any field that is off, and the reader bounds, caches and
 * down-windows each peer on its own.
 */
import { describe, expect, test } from "bun:test";
import { startFacts, type BootLine } from "./boot-line.ts";
import {
  BOOT_LINE_PEER_PATH,
  createBootLinePeerReader,
  PEER_TEXT_MAX,
  PEER_UNREAD_COUNT_MAX,
  PEER_UNREAD_MAX,
  readPeerBootLine,
  toPeerBootLine,
  type PeerBootLine,
} from "./boot-line-peer.ts";
import { createPeerAnswerer } from "./peer.ts";

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

  test("invisible characters in the text and unread names are removed, the rest kept", () => {
    const cases: [string, string][] = [
      ["zero-width space, non-joiner, joiner", "\u200B\u200C\u200D"],
      ["word joiner to invisible plus", "\u2060\u2061\u2062\u2063\u2064"],
      ["byte-order mark", "\uFEFF"],
      ["soft hyphen", "\u00AD"],
      ["tag block", "\u{E0000}\u{E0041}\u{E007F}"],
      ["lone high surrogate", "\uD800"],
      ["lone low surrogate", "\uDC00"],
    ];
    for (const [name, chars] of cases) {
      const got = readPeerBootLine(reply({ text: `started${chars}from x`, unread: [`ori${chars}gin`] }), "mini");
      expect({ name, value: "value" in got ? [got.value.text, got.value.unread] : got }).toEqual({ name, value: ["startedfrom x", ["origin"]] });
    }
    // A valid surrogate pair (an emoji) is one character and stays.
    const emoji = readPeerBootLine(reply({ text: "started from x \u{1F680}" }), "mini");
    expect("value" in emoji && emoji.value.text).toBe("started from x \u{1F680}");
  });

  test("a text made only of invisible characters and spaces refuses the reply; such an unread name is dropped", () => {
    for (const text of ["\u200B", "\u200B \u2060\uFEFF\u00AD ", "\u{E0041}\u{E0042}", "\uD800 \uDC00", " \u200D "]) {
      expect({ text, refused: refused(reply({ text })) }).toEqual({ text, refused: "sent an empty text" });
    }
    const got = readPeerBootLine(reply({ unread: ["\u200B\u00AD", "origin"] }), "mini");
    expect("value" in got && got.value.unread).toEqual(["origin"]);
  });

  const hex = (c: number) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
  const isSurrogate = (c: number) => c >= 0xd800 && c <= 0xdfff;

  // The expected set is built here from properties, not from the production pattern.
  test("every code point that renders blank, sent alone as the text, refuses the reply", () => {
    const blank = /^[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Zl}\p{Zp}\p{Zs}\p{Cc}\u{2800}]$/u;
    const accepted: string[] = [];
    let swept = 0;
    for (let c = 0; c <= 0x10ffff; c++) {
      if (isSurrogate(c)) continue;
      const ch = String.fromCodePoint(c);
      if (!blank.test(ch)) continue;
      swept++;
      if (refused(reply({ text: ch })) !== "sent an empty text") accepted.push(hex(c));
    }
    expect(swept).toBeGreaterThan(140_000);
    expect(accepted).toEqual([]);
  });

  test("a sample of unassigned code points, sent alone, refuses the reply", () => {
    const sample = [0x0378, 0x0379, 0x1fffe, 0x50000, 0x10ffff];
    for (const c of sample) expect(/^\p{Cn}$/u.test(String.fromCodePoint(c))).toBe(true);
    const accepted = sample.filter((c) => refused(reply({ text: String.fromCodePoint(c) })) !== "sent an empty text").map(hex);
    expect(accepted).toEqual([]);
  });

  test("no letter, digit, punctuation or symbol is stripped, except the four Hangul fillers and the braille blank", () => {
    const visible = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
    const removed: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (isSurrogate(c)) continue;
      const ch = String.fromCodePoint(c);
      if (!visible.test(ch)) continue;
      const got = readPeerBootLine(reply({ text: `a${ch}b` }), "mini");
      if (!("value" in got) || got.value.text !== `a${ch}b`) removed.push(hex(c));
    }
    // Default_Ignorable letters (category Lo) and U+2800 (So) render blank and go on purpose.
    expect(removed).toEqual(["U+115F", "U+1160", "U+2800", "U+3164", "U+FFA0"]);
  });

  test("Norwegian, a plain emoji and CJK come through unchanged", () => {
    for (const text of ["bl\u00E5b\u00E6rsyltet\u00F8y p\u00E5 \u00C6r\u00F8", "started \u{1F680} from x", "\u{5DF2}\u{91CD}\u{542F} \u{8D77}\u{52A8}"]) {
      const got = readPeerBootLine(reply({ text }), "mini");
      expect("value" in got && got.value.text).toBe(text);
    }
  });

  test("an unread name of only a Hangul filler, a variation selector or the braille blank is dropped", () => {
    const got = readPeerBootLine(reply({ unread: ["\u{3164}", "\u{FE0F}", "\u{2800}", "\u{3164}\u{FE0F} \u{2800}", "origin"] }), "mini");
    expect("value" in got && got.value.unread).toEqual(["origin"]);
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

  test("a line over the asker's caps is clamped on the way out, and the asker takes it with its row and restart flag", () => {
    // A real-looking long ref: the start facts name it, and the «elsewhere» text names it again.
    const ref = `refs/heads/${"feature/owner-step-drain-boot-line-peer-rows-and-the-restart-cue-".repeat(15)}x`;
    const at = new Date(2026, 10, 14, 20, 58).getTime();
    const record = { known: true as const, dir: "/x", commit: "409bfd1a".repeat(5), ref, pr: 864, tracked: { state: "clean" as const }, at };
    const text = [startFacts(record, at, "main"), "the checkout has moved off the start commit: restart", "origin has commits this checkout lacks"].join(" · ");
    expect(text.length).toBeGreaterThan(PEER_TEXT_MAX);
    const line: BootLine = {
      row: "moved-off",
      restart: true,
      text,
      start: { known: true, commit: record.commit, ref, pr: 864, at, tracked: "clean" },
      unread: [...Array(12)].map((_, i) => `part ${i} ${"y".repeat(120)}`),
      readAt: at,
    };
    const sent = toPeerBootLine(line);
    expect(sent.text.length).toBe(PEER_TEXT_MAX);
    expect(sent.text.endsWith("…")).toBe(true);
    expect(sent.unread.length).toBe(PEER_UNREAD_COUNT_MAX);
    for (const u of sent.unread) expect(u.length).toBeLessThanOrEqual(PEER_UNREAD_MAX);
    expect(sent.unread[0]!.endsWith("…")).toBe(true);
    const got = readPeerBootLine(JSON.parse(JSON.stringify({ v: 1, machine: "mini", line: sent })), "mini");
    expect("value" in got && got.value).toMatchObject({ row: "moved-off", restart: true, text: sent.text, unread: sent.unread });
  });

  test("a clamp never leaves half a surrogate pair at the cut", () => {
    const base: BootLine = { row: "same", restart: false, text: `${"x".repeat(PEER_TEXT_MAX - 2)}😀😀`, start: { known: false, reason: "no git", at: 1 }, unread: [], readAt: 1 };
    const sent = toPeerBootLine(base);
    expect(sent.text.length).toBeLessThanOrEqual(PEER_TEXT_MAX);
    expect(sent.text).toBe(`${"x".repeat(PEER_TEXT_MAX - 2)}…`);
    // At the cap exactly, nothing is cut.
    expect(toPeerBootLine({ ...base, text: "x".repeat(PEER_TEXT_MAX) }).text).toBe("x".repeat(PEER_TEXT_MAX));
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

  test("a peer that keeps failing logs once when it starts, once when its reason changes, and once when it answers again", async () => {
    let clock = 1_000_000;
    let status = 404;
    const logged: { level: string; msg: string; props: Record<string, unknown> }[] = [];
    const log = {
      warn: (msg: string, props: Record<string, unknown>) => logged.push({ level: "warn", msg, props }),
      info: (msg: string, props: Record<string, unknown>) => logged.push({ level: "info", msg, props }),
      debug: (msg: string, props: Record<string, unknown>) => logged.push({ level: "debug", msg, props }),
    };
    const fetch = async () => (status === 200 ? json(reply()) : json({}, status));
    const read = createBootLinePeerReader({ peers: new Map([["mini", "https://mini.test"]]), fetch, ttlMs: 20_000, downMs: 15_000, now: () => clock, log });
    const loud = () => logged.filter((l) => l.level !== "debug");
    // Five asks a minute apart, each past the down window: five requests, one log.
    for (let i = 0; i < 5; i++) {
      expect((await read())[0]).toMatchObject({ answered: false, why: "the peer answered HTTP 404" });
      clock += 60_000;
    }
    expect(loud()).toHaveLength(1);
    expect(loud()[0]).toMatchObject({ level: "warn", props: { machine: "mini", reason: "answered HTTP 404" } });
    // A changed reason: one more.
    status = 500;
    await read();
    clock += 60_000;
    await read();
    clock += 60_000;
    expect(loud()).toHaveLength(2);
    expect(loud()[1]).toMatchObject({ level: "warn", props: { reason: "answered HTTP 500" } });
    // It answers again: one log, and later answers add none.
    status = 200;
    expect((await read())[0]!.answered).toBe(true);
    clock += 60_000;
    await read();
    expect(loud()).toHaveLength(3);
    expect(loud()[2]).toMatchObject({ level: "info", props: { machine: "mini" } });
    // Failing again after the recovery is a new start: logged.
    status = 404;
    clock += 60_000;
    await read();
    expect(loud()).toHaveLength(4);
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

  test("peers are read in parallel: every peer is asked before any answers, and rows come in config order whatever order they answer", async () => {
    const peers = new Map([
      ["a", "https://a.test"],
      ["b", "https://b.test"],
      ["c", "https://c.test"],
    ]);
    const asked: string[] = [];
    const release = new Map<string, () => void>();
    const fetch = async (url: string) => {
      const host = new URL(url).host.replace(".test", "");
      asked.push(host);
      await new Promise<void>((r) => release.set(host, r));
      return json(reply({}, { machine: host }));
    };
    const rows = createBootLinePeerReader({ peers, fetch, timeoutMs: 5_000 })();
    for (let i = 0; i < 20 && asked.length < 3; i++) await new Promise((r) => setTimeout(r, 1));
    // A sequential read would have asked only "a" here: "b" waits on "a"'s answer.
    expect(asked).toEqual(["a", "b", "c"]);
    for (const host of ["c", "a", "b"]) release.get(host)!();
    expect((await rows).map((r) => [r.machine, r.answered])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
  });

  test("its down window is its own: a boot-line failure for a peer never makes the step-check client skip that peer", async () => {
    // An older muninn 404s the boot-line route but answers step checks; sharing one window would turn its checks unknown.
    const peers = new Map([["mini", "https://mini.test"]]);
    const probe = { kind: "env", value: "HAVE" } as const;
    const asked: string[] = [];
    const fetch = async (url: string) => {
      const u = new URL(url);
      asked.push(u.pathname);
      if (u.pathname === BOOT_LINE_PEER_PATH) return new Response("not found", { status: 404 });
      return json({ v: 1, machine: "mini", results: [{ ...probe, state: "ok", why: "set" }] });
    };
    const clock = () => 1_000_000;
    const read = createBootLinePeerReader({ peers, fetch, now: clock });
    const answer = createPeerAnswerer({ peers, fetch, now: clock });
    expect(await read()).toEqual([{ machine: "mini", answered: false, why: "the peer answered HTTP 404" }]);
    expect((await read())[0]).toMatchObject({ answered: false, why: "the peer was unreachable a moment ago (answered HTTP 404)" });
    expect(await answer("mini", [probe])).toEqual([{ state: "ok", why: "mini: set" }]);
    expect(asked).toEqual([BOOT_LINE_PEER_PATH, "/api/checks/answer"]);
  });

  test("no peers: no request", async () => {
    let calls = 0;
    const read = createBootLinePeerReader({ peers: new Map(), fetch: async () => (calls++, json(reply())) });
    expect(await read()).toEqual([]);
    expect(calls).toBe(0);
  });
});
