import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "../db/client.ts";
import {
  birthDevRun,
  getDevRunById,
  insertHandoff,
  listHandoffs,
  listDevRunEvents,
  updateDevRun,
} from "../db/dev-runs.ts";
import {
  parseHandoffMarker,
  parseNoteMarker,
  stripNoteMarker,
  verdictToHandoffStatus,
  resolveRun,
  setFrontmatterStatus,
  flipSpecToVerified,
  interpretHandoffReply,
  truncateHandoffMessage,
  HANDOFF_LAST_MESSAGE_CAP,
} from "./handoff-interpreter.ts";
import { parseGithubRunUrl } from "./ci-conclusion.ts";
import { shortRunId } from "./mcp-server.ts";

setupTestDb();

describe("parseHandoffMarker", () => {
  test("parses build/test status markers", () => {
    expect(parseHandoffMarker("done!\n<!-- status: done run:ab12cd34 -->")).toEqual({
      verdict: "done", runIdPrefix: "ab12cd34",
    });
    expect(parseHandoffMarker("<!-- status: failed run:ABCD1234 -->")).toEqual({
      verdict: "failed", runIdPrefix: "abcd1234",
    });
  });

  test("parses orchestrate e2e markers", () => {
    expect(parseHandoffMarker("green <!-- e2e: green run:deadbeef -->")).toEqual({
      verdict: "green", runIdPrefix: "deadbeef",
    });
    expect(parseHandoffMarker("<!--e2e:red   run:deadbeef-->")).toEqual({
      verdict: "red", runIdPrefix: "deadbeef",
    });
  });

  test("takes the LAST marker when several appear", () => {
    const text = "earlier <!-- status: failed run:11111111 --> ... actually <!-- status: done run:22222222 -->";
    expect(parseHandoffMarker(text)).toEqual({ verdict: "done", runIdPrefix: "22222222" });
  });

  test("returns null for ordinary chatter", () => {
    expect(parseHandoffMarker("just a normal reply, no marker")).toBeNull();
    expect(parseHandoffMarker("<!-- prompt:specDomain -->")).toBeNull();
  });

  test("a note marker is NOT a terminal marker (terminal-first parse depends on this)", () => {
    expect(parseHandoffMarker("<!-- note: discovery run:ab12cd34 -->")).toBeNull();
  });
});

describe("truncateHandoffMessage", () => {
  const CI_URL = "https://github.com/navikt/melosys-api/actions/runs/123456789";

  test("short messages pass through unchanged", () => {
    expect(truncateHandoffMessage("all done " + CI_URL)).toBe("all done " + CI_URL);
  });

  test("a CI URL within the cap survives plain truncation", () => {
    const text = CI_URL + " ".repeat(HANDOFF_LAST_MESSAGE_CAP * 2);
    const out = truncateHandoffMessage(text);
    expect(out.length).toBe(HANDOFF_LAST_MESSAGE_CAP);
    expect(parseGithubRunUrl(out)).not.toBeNull();
  });

  test("a CI URL PAST the cap is preserved (the green-gate stuck-at-verifying bug)", () => {
    // The URL sits beyond char 2000 in a long handoff; naive slice(0,2000) would
    // drop it and the green gate would never find it → run stuck at 'verifying'.
    const text = "x".repeat(HANDOFF_LAST_MESSAGE_CAP + 500) + "\nCI run: " + CI_URL;
    const naive = text.slice(0, HANDOFF_LAST_MESSAGE_CAP);
    expect(parseGithubRunUrl(naive)).toBeNull(); // confirms the bug premise

    const out = truncateHandoffMessage(text);
    const parsed = parseGithubRunUrl(out);
    expect(parsed).not.toBeNull();
    expect(parsed!.repo).toBe("navikt/melosys-api");
    expect(parsed!.runId).toBe("123456789");
  });

  test("no URL anywhere → plain truncation to the cap", () => {
    const text = "y".repeat(HANDOFF_LAST_MESSAGE_CAP + 100);
    const out = truncateHandoffMessage(text);
    expect(out.length).toBe(HANDOFF_LAST_MESSAGE_CAP);
    expect(parseGithubRunUrl(out)).toBeNull();
  });

  test("a runId STRADDLING the cap boundary recovers the full URL, not the truncated one", () => {
    // Pad so the cut lands in the middle of the runId digits: the slice carries
    // ".../runs/1234" (a parseable but WRONG short id). The fix must not trust the
    // slice-local parse — it appends the full canonical URL with runId 123456789.
    const prefix = "z".repeat(HANDOFF_LAST_MESSAGE_CAP - (CI_URL.length - 4));
    const text = prefix + CI_URL;
    const naive = text.slice(0, HANDOFF_LAST_MESSAGE_CAP);
    // Premise: the naive slice parses to a TRUNCATED (wrong) runId.
    const naiveParsed = parseGithubRunUrl(naive);
    expect(naiveParsed).not.toBeNull();
    expect(naiveParsed!.runId).not.toBe("123456789");

    const out = truncateHandoffMessage(text);
    const parsed = parseGithubRunUrl(out);
    expect(parsed).not.toBeNull();
    expect(parsed!.repo).toBe("navikt/melosys-api");
    expect(parsed!.runId).toBe("123456789");
  });
});

describe("parseNoteMarker", () => {
  test("parses each note kind, tolerant of whitespace/case", () => {
    expect(parseNoteMarker("found it <!-- note: discovery run:ab12cd34 -->")).toEqual({
      kind: "discovery", runIdPrefix: "ab12cd34",
    });
    expect(parseNoteMarker("<!--note:blocker   run:DEADBEEF-->")).toEqual({
      kind: "blocker", runIdPrefix: "deadbeef",
    });
  });

  test("takes the LAST note when several appear", () => {
    const t = "<!-- note: discovery run:11111111 --> ... <!-- note: milestone run:22222222 -->";
    expect(parseNoteMarker(t)).toEqual({ kind: "milestone", runIdPrefix: "22222222" });
  });

  test("returns null for a terminal marker, an unknown kind, or ordinary chatter", () => {
    expect(parseNoteMarker("<!-- status: done run:ab12cd34 -->")).toBeNull();
    expect(parseNoteMarker("<!-- note: bogus run:ab12cd34 -->")).toBeNull();
    expect(parseNoteMarker("just chatter")).toBeNull();
  });
});

describe("stripNoteMarker", () => {
  test("removes the marker and trims the surrounding body", () => {
    expect(stripNoteMarker("the discovery text\n<!-- note: discovery run:ab12cd34 -->")).toBe(
      "the discovery text",
    );
    expect(stripNoteMarker("<!-- note: milestone run:ab12cd34 -->")).toBe("");
  });
});

describe("verdictToHandoffStatus", () => {
  test("maps green→done, red→failed", () => {
    expect(verdictToHandoffStatus("done")).toBe("done");
    expect(verdictToHandoffStatus("green")).toBe("done");
    expect(verdictToHandoffStatus("failed")).toBe("failed");
    expect(verdictToHandoffStatus("red")).toBe("failed");
  });
});

describe("setFrontmatterStatus", () => {
  test("flips status in the leading frontmatter only", () => {
    const content = "---\njira: M-1\nstatus: approved\ndate: 2026-05-24\n---\n\nbody\nstatus: notthis\n";
    const out = setFrontmatterStatus(content, "verified");
    expect(out).toContain("status: verified");
    expect(out).toContain("status: notthis"); // body line untouched
    expect(out.indexOf("status: verified")).toBeLessThan(out.indexOf("---\n\nbody"));
  });

  test("no-op when there's no frontmatter status", () => {
    expect(setFrontmatterStatus("no frontmatter here", "verified")).toBe("no frontmatter here");
    expect(setFrontmatterStatus("---\njira: M-1\n---\nbody", "verified")).toBe("---\njira: M-1\n---\nbody");
  });

  test("replaces the WHOLE value (hyphenated/quoted not garbled)", () => {
    expect(setFrontmatterStatus("---\nstatus: in-progress\n---\nx", "verified")).toContain("status: verified");
    expect(setFrontmatterStatus("---\nstatus: in-progress\n---\nx", "verified")).not.toContain("verified-progress");
    expect(setFrontmatterStatus('---\nstatus: "approved"\n---\nx', "verified")).toContain("status: verified");
  });

  test("tolerates CRLF frontmatter", () => {
    const crlf = "---\r\njira: M-1\r\nstatus: approved\r\n---\r\n\r\nbody";
    expect(setFrontmatterStatus(crlf, "verified")).toContain("status: verified");
  });
});

describe("flipSpecToVerified", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muninn-spec-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("rewrites the file's frontmatter status to verified", async () => {
    const path = join(dir, "spec.md");
    await Bun.write(path, "---\njira: M-1\nstatus: approved\n---\n\nthe spec");
    expect(await flipSpecToVerified(path)).toBe(true);
    expect(await Bun.file(path).text()).toContain("status: verified");
  });

  test("returns false for a missing file", async () => {
    expect(await flipSpecToVerified(join(dir, "nope.md"))).toBe(false);
  });
});

describe("resolveRun", () => {
  async function insertRunWithId(id: string, issueKey: string, status: string, threadId?: string): Promise<void> {
    const sql = getDb();
    await sql`
      INSERT INTO dev_runs (id, bot_name, user_id, issue_key, thread_id, status, research_stage)
      VALUES (${id}, ${"b"}, ${"u"}, ${issueKey}, ${threadId ?? null}, ${status}, ${"analysis"})
    `;
  }

  test("single prefix match resolves directly", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "RR-1" });
    const got = await resolveRun({ runIdPrefix: shortRunId(run.id) });
    expect(got!.id).toBe(run.id);
  });

  test("collision: prefers the run on the routed thread", async () => {
    const T = "33333333-3333-3333-3333-333333333333";
    await insertRunWithId("cafe0001-0000-4000-8000-000000000001", "RR-C1", "building", undefined);
    await insertRunWithId("cafe0001-0000-4000-8000-000000000002", "RR-C2", "building", T);
    const got = await resolveRun({ runIdPrefix: "cafe0001", routedThreadId: T });
    expect(got!.id).toBe("cafe0001-0000-4000-8000-000000000002");
  });

  test("collision with no routed-thread match: newest OPEN run", async () => {
    await insertRunWithId("cafe0002-0000-4000-8000-000000000001", "RR-D1", "green"); // terminal
    await insertRunWithId("cafe0002-0000-4000-8000-000000000002", "RR-D2", "building"); // open
    const sql = getDb();
    // Make the terminal one the most-recently-updated, so "newest open" must skip it.
    await sql`UPDATE dev_runs SET updated_at = now() + interval '1 second' WHERE id = ${"cafe0002-0000-4000-8000-000000000001"}`;
    const got = await resolveRun({ runIdPrefix: "cafe0002" });
    expect(got!.id).toBe("cafe0002-0000-4000-8000-000000000002");
  });

  test("no prefix match falls back to the routed thread's run", async () => {
    const T = "44444444-4444-4444-4444-444444444444";
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "RR-2", threadId: T });
    const got = await resolveRun({ runIdPrefix: "ffffffff", routedThreadId: T });
    expect(got!.id).toBe(run.id);
  });
});

describe("interpretHandoffReply", () => {
  test("ignores replies with no marker", async () => {
    const r = await interpretHandoffReply({ botName: "b", peerName: "p", text: "hello there" });
    expect(r.matched).toBe(false);
  });

  test("marker for an unknown run is matched but updates nothing", async () => {
    const r = await interpretHandoffReply({ botName: "b", peerName: "p", text: "<!-- status: done run:00000000 -->" });
    expect(r.matched).toBe(true);
    expect(r.runId).toBeUndefined();
  });

  test("build done + test done parks the run at ready_to_verify", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "IH-1" });
    await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build" });
    await insertHandoff({ runId: run.id, peerName: "melosys-e2e", role: "test" });
    const id = shortRunId(run.id);

    const r1 = await interpretHandoffReply({
      botName: "b", peerName: "melosys-api", text: `built it\n<!-- status: done run:${id} -->`,
    });
    expect(r1.rolesUpdated).toEqual(["build"]);
    expect(r1.runStatus).toBe("building"); // test still pending

    const r2 = await interpretHandoffReply({
      botName: "b", peerName: "melosys-e2e", text: `spec ready\n<!-- status: done run:${id} -->`,
    });
    expect(r2.runStatus).toBe("ready_to_verify");
    // Persisted on the run (so the orchestrate confirm renders off it next turn).
    expect((await getDevRunById(run.id))!.status).toBe("ready_to_verify");
  });

  test("failed build flips the run red", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "IH-2" });
    await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build" });
    const r = await interpretHandoffReply({
      botName: "b", peerName: "melosys-api", text: `broke\n<!-- status: failed run:${shortRunId(run.id)} -->`,
    });
    expect(r.runStatus).toBe("red");
    const handoff = (await listHandoffs(run.id)).find((h) => h.peerName === "melosys-api")!;
    expect(handoff.status).toBe("failed");
    expect(handoff.lastMessage).toContain("broke");
  });

  test("a marker for an already-terminal run is ignored (no clobber)", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "IH-T1" });
    await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build", status: "done" });
    await updateDevRun(run.id, { status: "green" });
    // A flapping retry reports failed AFTER the run is green — must not reopen it.
    const r = await interpretHandoffReply({
      botName: "b", peerName: "melosys-api", text: `<!-- status: failed run:${shortRunId(run.id)} -->`,
    });
    expect(r.note).toContain("already terminal");
    expect((await getDevRunById(run.id))!.status).toBe("green");
    expect((await listHandoffs(run.id))[0]!.status).toBe("done"); // handoff untouched
  });

  test("(run_id, peer_name) miss is reported, run not rolled up", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "IH-3" });
    await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build" });
    const r = await interpretHandoffReply({
      botName: "b", peerName: "WRONG-NAME", text: `<!-- status: done run:${shortRunId(run.id)} -->`,
    });
    expect(r.matched).toBe(true);
    expect(r.runId).toBe(run.id);
    expect(r.note).toContain("no handoff row");
    expect((await listHandoffs(run.id))[0]!.status).toBe("sent");
  });

  describe("non-terminal progress notes (Phase A)", () => {
    test("a note records an event, flips the handoff sent → working, never recomputes status", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "NOTE-1" });
      await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build" }); // sent
      await updateDevRun(run.id, { status: "building" });
      const id = shortRunId(run.id);

      const r = await interpretHandoffReply({
        botName: "b", peerName: "melosys-api",
        text: `field already on the DTO — smaller change\n<!-- note: discovery run:${id} -->`,
      });

      expect(r.matched).toBe(true);
      expect(r.event).toBeDefined();
      expect(r.event!.kind).toBe("discovery");
      expect(r.event!.role).toBe("build");
      expect(r.event!.text).toBe("field already on the DTO — smaller change");
      // The note path never sets terminal-result fields.
      expect(r.runStatus).toBeUndefined();
      expect(r.verified).toBeUndefined();
      // Handoff flipped sent → working; run status untouched (no recompute).
      expect((await listHandoffs(run.id))[0]!.status).toBe("working");
      expect((await getDevRunById(run.id))!.status).toBe("building");
      // Recorded in the timeline.
      const events = await listDevRunEvents(run.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe(r.event!.id);
    });

    test("a terminal marker in the same reply ALWAYS wins (no event recorded)", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "NOTE-2" });
      await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build" });
      const id = shortRunId(run.id);
      // A reply carrying BOTH a note and a terminal marker → terminal path.
      const r = await interpretHandoffReply({
        botName: "b", peerName: "melosys-api",
        text: `interim\n<!-- note: milestone run:${id} -->\nall done\n<!-- status: done run:${id} -->`,
      });
      expect(r.event).toBeUndefined();
      expect(r.rolesUpdated).toEqual(["build"]);
      expect((await listHandoffs(run.id))[0]!.status).toBe("done"); // terminal, not working
      expect(await listDevRunEvents(run.id)).toHaveLength(0);
    });

    test("a note on an already-terminal run is ignored (no event, no reopen)", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "NOTE-3" });
      await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build", status: "done" });
      await updateDevRun(run.id, { status: "green" });
      const r = await interpretHandoffReply({
        botName: "b", peerName: "melosys-api",
        text: `late thought\n<!-- note: discovery run:${shortRunId(run.id)} -->`,
      });
      expect(r.note).toContain("already terminal");
      expect(r.event).toBeUndefined();
      expect(await listDevRunEvents(run.id)).toHaveLength(0);
      expect((await getDevRunById(run.id))!.status).toBe("green");
    });

    test("a note whose peer_name matches no handoff still records the event (role undefined)", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "NOTE-4" });
      await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build" });
      const r = await interpretHandoffReply({
        botName: "b", peerName: "DRIFTED-NAME",
        text: `from a peer with no handoff\n<!-- note: blocker run:${shortRunId(run.id)} -->`,
      });
      expect(r.event).toBeDefined();
      expect(r.event!.role).toBeUndefined();
      expect(await listDevRunEvents(run.id)).toHaveLength(1);
      // The known handoff is untouched (the join missed).
      expect((await listHandoffs(run.id))[0]!.status).toBe("sent");
    });

    test("a note for an unknown run is matched but records nothing", async () => {
      const r = await interpretHandoffReply({
        botName: "b", peerName: "p", text: "<!-- note: discovery run:00000000 -->",
      });
      expect(r.matched).toBe(true);
      expect(r.event).toBeUndefined();
    });
  });

  describe("green gate (CI-confirmed)", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "muninn-bot-"));
      await mkdir(join(dir, "specs", "u"), { recursive: true });
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    async function greenRunReady(issueKey: string): Promise<{ runId: string; id: string }> {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey });
      await updateDevRun(run.id, { specPath: "specs/u/" + issueKey + ".md" });
      await Bun.write(join(dir, "specs", "u", issueKey + ".md"), "---\njira: " + issueKey + "\nstatus: approved\n---\n\nspec body");
      await insertHandoff({ runId: run.id, peerName: "api", role: "build", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "orch", role: "orchestrate" });
      return { runId: run.id, id: shortRunId(run.id) };
    }

    test("confirmed-green flips the spec to verified and sets run green", async () => {
      const { runId, id } = await greenRunReady("IH-G1");
      const r = await interpretHandoffReply({
        botName: "b", peerName: "orch",
        text: `all green https://github.com/navikt/melosys-api/actions/runs/77\n<!-- e2e: green run:${id} -->`,
        deps: {
          getBotDir: () => dir,
          fetchCi: async () => ({ status: "completed", conclusion: "success", repo: "navikt/melosys-api", runId: "77" }),
        },
      });
      expect(r.runStatus).toBe("green");
      expect(r.verified).toBe(true);
      expect((await getDevRunById(runId))!.status).toBe("green");
      expect(await Bun.file(join(dir, "specs", "u", "IH-G1.md")).text()).toContain("status: verified");
    });

    test("green marker but CI not yet complete → verifying, spec NOT flipped", async () => {
      const { runId, id } = await greenRunReady("IH-G2");
      const r = await interpretHandoffReply({
        botName: "b", peerName: "orch",
        text: `running https://github.com/navikt/melosys-api/actions/runs/78\n<!-- e2e: green run:${id} -->`,
        deps: {
          getBotDir: () => dir,
          fetchCi: async () => ({ status: "in_progress", conclusion: null, repo: "navikt/melosys-api", runId: "78" }),
        },
      });
      expect(r.runStatus).toBe("verifying");
      expect(r.verified).toBe(false);
      expect((await getDevRunById(runId))!.status).toBe("verifying");
      expect(await Bun.file(join(dir, "specs", "u", "IH-G2.md")).text()).toContain("status: approved");
    });

    test("green marker with no CI URL → verifying (never trust the marker alone)", async () => {
      const { runId, id } = await greenRunReady("IH-G3");
      let ciCalled = false;
      const r = await interpretHandoffReply({
        botName: "b", peerName: "orch",
        text: `looks good!\n<!-- e2e: green run:${id} -->`,
        deps: { getBotDir: () => dir, fetchCi: async () => { ciCalled = true; return null; } },
      });
      expect(ciCalled).toBe(false); // no URL → never even fetches
      expect(r.runStatus).toBe("verifying");
      expect((await getDevRunById(runId))!.status).toBe("verifying");
    });

    test("out-of-order: orchestrate green FIRST, build/test land later — still CI-confirms before green", async () => {
      // The reply-ordering bug: orchestrate replies green before build/test are
      // done, so the run parks at `verifying`; when build then completes, the
      // tipping reply's verdict is `done` (not `green`). The gate must still fire
      // off the run REACHING green, pulling the CI URL from the orchestrate
      // handoff's stored reply — not from this build reply.
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "IH-OOO" });
      await updateDevRun(run.id, { specPath: "specs/u/IH-OOO.md" });
      await Bun.write(join(dir, "specs", "u", "IH-OOO.md"), "---\njira: IH-OOO\nstatus: approved\n---\n\nspec");
      await insertHandoff({ runId: run.id, peerName: "api", role: "build" });
      await insertHandoff({ runId: run.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "orch", role: "orchestrate" });
      const id = shortRunId(run.id);

      let ciCalls = 0;
      const deps = {
        getBotDir: () => dir,
        fetchCi: async () => { ciCalls++; return { status: "completed", conclusion: "success", repo: "navikt/melosys-api", runId: "90" } as const; },
      };

      // 1) Orchestrate green arrives while build is still pending → parks at verifying, no flip.
      const r1 = await interpretHandoffReply({
        botName: "b", peerName: "orch",
        text: `green https://github.com/navikt/melosys-api/actions/runs/90\n<!-- e2e: green run:${id} -->`,
        deps,
      });
      expect(r1.runStatus).toBe("verifying");
      expect(ciCalls).toBe(0); // run not green yet (build pending) → no CI fetch
      expect(await Bun.file(join(dir, "specs", "u", "IH-OOO.md")).text()).toContain("status: approved");

      // 2) Build finishes with a plain `status: done` — run reaches green; CI must
      //    be confirmed from the orchestrate handoff's stored reply, then flip.
      const r2 = await interpretHandoffReply({
        botName: "b", peerName: "api", text: `built\n<!-- status: done run:${id} -->`, deps,
      });
      expect(ciCalls).toBe(1);
      expect(r2.runStatus).toBe("green");
      expect(r2.verified).toBe(true);
      expect((await getDevRunById(run.id))!.status).toBe("green");
      expect(await Bun.file(join(dir, "specs", "u", "IH-OOO.md")).text()).toContain("status: verified");
    });

    test("CI-confirmed but spec flip fails (no specPath) → stays verifying, not green", async () => {
      // CI says green, but the run has no spec_path to flip. green ⟹ verified must
      // hold, so don't claim a terminal green the spec file doesn't reflect.
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "IH-NOSPEC" });
      await insertHandoff({ runId: run.id, peerName: "api", role: "build", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "orch", role: "orchestrate" });
      const r = await interpretHandoffReply({
        botName: "b", peerName: "orch",
        text: `green https://github.com/navikt/melosys-api/actions/runs/91\n<!-- e2e: green run:${shortRunId(run.id)} -->`,
        deps: {
          getBotDir: () => dir, // dir exists but run.specPath is unset
          fetchCi: async () => ({ status: "completed", conclusion: "success", repo: "navikt/melosys-api", runId: "91" }),
        },
      });
      expect(r.verified).toBe(false);
      expect(r.runStatus).toBe("verifying");
      expect((await getDevRunById(run.id))!.status).toBe("verifying");
    });

    test("orchestrate red flips the run red without touching the spec", async () => {
      const { runId, id } = await greenRunReady("IH-G4");
      const r = await interpretHandoffReply({
        botName: "b", peerName: "orch",
        text: `e2e failed https://github.com/navikt/melosys-api/actions/runs/79\n<!-- e2e: red run:${id} -->`,
        deps: { getBotDir: () => dir },
      });
      expect(r.runStatus).toBe("red");
      expect(r.verified).toBeFalsy();
      expect((await getDevRunById(runId))!.status).toBe("red");
      expect(await Bun.file(join(dir, "specs", "u", "IH-G4.md")).text()).toContain("status: approved");
    });
  });
});
