import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  birthDevRun,
  getDevRunById,
  getDevRunByThreadId,
  getDevRunByIdentity,
  getDevRunsByIdPrefix,
  updateDevRun,
  claimForVerify,
  persistRunStatus,
  claimForReengage,
  clearOrchestrateHandoffs,
  linkSpecToDevRun,
  insertHandoff,
  updateHandoffStatus,
  listHandoffs,
  listStaleHandoffs,
  setResearchStageByThread,
  computeRunStatus,
  insertDevRunEvent,
  listDevRunEvents,
  markHandoffWorking,
  DEV_RUN_EVENT_TEXT_CAP,
} from "./dev-runs.ts";

setupTestDb();

/** Insert a dev_run with a crafted id so prefix-collision paths are testable
 *  (birthDevRun uses gen_random_uuid(), which we can't steer to share a prefix). */
async function insertRunWithId(id: string, issueKey: string, status = "building"): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO dev_runs (id, bot_name, user_id, issue_key, status, research_stage)
    VALUES (${id}, ${"b"}, ${"u"}, ${issueKey}, ${status}, ${"analysis"})
  `;
}

const THREAD = "11111111-1111-1111-1111-111111111111";
const THREAD2 = "22222222-2222-2222-2222-222222222222";

describe("dev-runs", () => {
  test("birthDevRun creates a run with status analyzing / stage analysis", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-1", threadId: THREAD });
    expect(run.id).toBeTruthy();
    expect(run.status).toBe("analyzing");
    expect(run.researchStage).toBe("analysis");
    expect(run.issueKey).toBe("MELOSYS-1");
    expect(run.threadId).toBe(THREAD);
  });

  test("birthDevRun is idempotent per (bot,user,issue) and repoints the thread", async () => {
    const r1 = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-1", threadId: THREAD });
    const r2 = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-1", threadId: THREAD2 });
    expect(r2.id).toBe(r1.id);
    expect(r2.threadId).toBe(THREAD2);
    expect((await getDevRunByIdentity("b", "u", "MELOSYS-1"))!.id).toBe(r1.id);
  });

  test("re-birth resets status/stage (overwrite semantics)", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-1", threadId: THREAD });
    await updateDevRun(run.id, { status: "green", researchStage: "deep" });
    const reborn = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-1", threadId: THREAD });
    expect(reborn.id).toBe(run.id);
    expect(reborn.status).toBe("analyzing");
    expect(reborn.researchStage).toBe("analysis");
  });

  test("accepts the synthetic research-<8hex> key + thread lookup", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "research-abcd1234", threadId: THREAD });
    expect((await getDevRunById(run.id))!.issueKey).toBe("research-abcd1234");
    expect((await getDevRunByThreadId(THREAD))!.id).toBe(run.id);
  });

  test("updateDevRun sets spec path, stage and status", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-2" });
    const upd = await updateDevRun(run.id, {
      specPath: "specs/u/MELOSYS-2.md",
      researchStage: "deep",
      status: "spec_approved",
    });
    expect(upd!.specPath).toBe("specs/u/MELOSYS-2.md");
    expect(upd!.researchStage).toBe("deep");
    expect(upd!.status).toBe("spec_approved");
  });

  test("linkSpecToDevRun updates the matching run's specPath + status", async () => {
    const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-9", threadId: THREAD });
    const linked = await linkSpecToDevRun({
      botName: "b",
      userId: "u",
      issueKey: "MELOSYS-9",
      specPath: "specs/u/MELOSYS-9.md",
      status: "spec_approved",
    });
    expect(linked!.id).toBe(run.id);
    expect(linked!.specPath).toBe("specs/u/MELOSYS-9.md");
    expect(linked!.status).toBe("spec_approved");
  });

  test("linkSpecToDevRun does not regress an approved spec back to draft", async () => {
    await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-10", threadId: THREAD });
    await linkSpecToDevRun({
      botName: "b",
      userId: "u",
      issueKey: "MELOSYS-10",
      specPath: "specs/u/MELOSYS-10.md",
      status: "spec_approved",
    });
    // A later Save Spec click posts spec_draft — must keep the run approved,
    // but still refresh the spec_path.
    const draft = await linkSpecToDevRun({
      botName: "b",
      userId: "u",
      issueKey: "MELOSYS-10",
      specPath: "specs/u/MELOSYS-10-v2.md",
      status: "spec_draft",
    });
    expect(draft!.status).toBe("spec_approved");
    expect(draft!.specPath).toBe("specs/u/MELOSYS-10-v2.md");
  });

  test("linkSpecToDevRun returns null (no throw) when no run matches", async () => {
    const linked = await linkSpecToDevRun({
      botName: "b",
      userId: "u",
      issueKey: "MELOSYS-MISSING",
      specPath: "specs/u/MELOSYS-MISSING.md",
      status: "spec_draft",
    });
    expect(linked).toBeNull();
  });

  describe("setResearchStageByThread", () => {
    test("advances the open run's research_stage by thread", async () => {
      const tid = crypto.randomUUID();
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "STAGE-1", threadId: tid });
      expect(run.researchStage).toBe("analysis");
      const upd = await setResearchStageByThread(tid, "investigation");
      expect(upd!.id).toBe(run.id);
      expect(upd!.researchStage).toBe("investigation");
      const upd2 = await setResearchStageByThread(tid, "deep");
      expect(upd2!.researchStage).toBe("deep");
    });

    test("returns null (no throw) when the thread has no run", async () => {
      expect(await setResearchStageByThread(crypto.randomUUID(), "investigation")).toBeNull();
    });
  });

  describe("getDevRunsByIdPrefix", () => {
    test("resolves a run by its 8-hex id prefix", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-PFX-1", threadId: THREAD });
      const prefix = run.id.slice(0, 8);
      const matches = await getDevRunsByIdPrefix(prefix);
      expect(matches.map((m) => m.id)).toContain(run.id);
    });

    test("non-hex prefix returns [] (no LIKE wildcard injection)", async () => {
      expect(await getDevRunsByIdPrefix("abc%def")).toEqual([]);
      expect(await getDevRunsByIdPrefix("zzzzzzzz")).toEqual([]);
    });

    test(">1 match returns all, most-recently-updated first", async () => {
      // Two runs sharing the same 8-hex prefix — the collision the inbound
      // resolver must handle. Crafted ids; bump one's updated_at to assert order.
      await insertRunWithId("abcd1234-0000-4000-8000-000000000001", "PFX-COLLIDE-A");
      await insertRunWithId("abcd1234-0000-4000-8000-000000000002", "PFX-COLLIDE-B");
      const sql = getDb();
      await sql`UPDATE dev_runs SET updated_at = now() + interval '1 second' WHERE id = ${"abcd1234-0000-4000-8000-000000000002"}`;

      const matches = await getDevRunsByIdPrefix("abcd1234");
      const ids = matches.map((m) => m.id);
      expect(ids).toContain("abcd1234-0000-4000-8000-000000000001");
      expect(ids).toContain("abcd1234-0000-4000-8000-000000000002");
      // most-recently-updated first
      expect(ids[0]).toBe("abcd1234-0000-4000-8000-000000000002");
    });
  });

  describe("listStaleHandoffs", () => {
    test("flags a pending handoff past the threshold, ignores terminal + recent ones", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "STALE-1", threadId: THREAD });
      const stale = await insertHandoff({ runId: run.id, peerName: "dead-peer", role: "build" });
      const fresh = await insertHandoff({ runId: run.id, peerName: "live-peer", role: "test" });
      const doneHandoff = await insertHandoff({ runId: run.id, peerName: "done-peer", role: "review", status: "done" });
      const sql = getDb();
      // Backdate only the stale + the done handoff well past the threshold.
      await sql`UPDATE dev_run_handoffs SET updated_at = now() - interval '1 day' WHERE id IN ${sql([stale.id, doneHandoff.id])}`;

      const result = await listStaleHandoffs(60 * 60 * 1000); // 1h threshold
      const flaggedIds = result.map((r) => r.handoff.id);
      expect(flaggedIds).toContain(stale.id); // pending + old → stale
      expect(flaggedIds).not.toContain(fresh.id); // pending but recent
      expect(flaggedIds).not.toContain(doneHandoff.id); // old but terminal
      const flagged = result.find((r) => r.handoff.id === stale.id)!;
      expect(flagged.run.id).toBe(run.id);
      expect(flagged.run.issueKey).toBe("STALE-1");
    });

    test("ignores handoffs whose run is already terminal", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "STALE-2", threadId: THREAD2 });
      const h = await insertHandoff({ runId: run.id, peerName: "p", role: "build" });
      const sql = getDb();
      await sql`UPDATE dev_run_handoffs SET updated_at = now() - interval '1 day' WHERE id = ${h.id}`;
      await updateDevRun(run.id, { status: "red" });

      const result = await listStaleHandoffs(60 * 60 * 1000);
      expect(result.map((r) => r.handoff.id)).not.toContain(h.id);
    });
  });

  describe("handoffs + computeRunStatus", () => {
    test("no handoffs → run.status passthrough", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-3" });
      await updateDevRun(run.id, { status: "spec_approved" });
      expect(await computeRunStatus(run.id)).toBe("spec_approved");
    });

    test("build+test in flight → building; both done → ready_to_verify", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-4" });
      await insertHandoff({ runId: run.id, peerName: "melosys-api", role: "build" });
      await insertHandoff({ runId: run.id, peerName: "melosys-e2e", role: "test" });
      expect(await computeRunStatus(run.id)).toBe("building");

      expect(await updateHandoffStatus({ runId: run.id, peerName: "melosys-api", status: "done" })).toBe(1);
      await updateHandoffStatus({ runId: run.id, peerName: "melosys-e2e", status: "done", lastMessage: "spec ready" });
      expect(await computeRunStatus(run.id)).toBe("ready_to_verify");

      const handoffs = await listHandoffs(run.id);
      expect(handoffs.length).toBe(2);
      expect(handoffs.find((h) => h.peerName === "melosys-e2e")!.lastMessage).toBe("spec ready");
    });

    test("orchestrate done (with build+test done) → green; failed → red", async () => {
      const green = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-5" });
      await insertHandoff({ runId: green.id, peerName: "api", role: "build", status: "done" });
      await insertHandoff({ runId: green.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: green.id, peerName: "orch", role: "orchestrate", status: "done" });
      expect(await computeRunStatus(green.id)).toBe("green");

      const red = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-6" });
      await insertHandoff({ runId: red.id, peerName: "api", role: "build", status: "done" });
      await insertHandoff({ runId: red.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: red.id, peerName: "orch", role: "orchestrate", status: "failed" });
      expect(await computeRunStatus(red.id)).toBe("red");
    });

    test("review role is NOT in the green gate", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MELOSYS-8" });
      await insertHandoff({ runId: run.id, peerName: "api", role: "build", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "rev", role: "review", status: "failed" });
      // review failed must not flip the run red, nor block ready_to_verify
      expect(await computeRunStatus(run.id)).toBe("ready_to_verify");
    });
  });

  describe("claimForVerify + persistRunStatus (Phase 6a auto-orchestrate)", () => {
    test("claimForVerify flips ready_to_verify → verifying for the single winner", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6A-1" });
      await updateDevRun(run.id, { status: "ready_to_verify" });
      const claimed = await claimForVerify(run.id);
      expect(claimed?.status).toBe("verifying");
      // A second concurrent claim loses — the run already moved past the gate.
      expect(await claimForVerify(run.id)).toBeNull();
    });

    test("claimForVerify is a no-op (null) when the run isn't ready_to_verify", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6A-2" }); // status analyzing
      expect(await claimForVerify(run.id)).toBeNull();
      await updateDevRun(run.id, { status: "building" });
      expect(await claimForVerify(run.id)).toBeNull();
    });

    test("persistRunStatus lands the first ready_to_verify (building → ready_to_verify)", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6A-3" });
      await updateDevRun(run.id, { status: "building" });
      expect((await persistRunStatus(run.id, "ready_to_verify"))?.status).toBe("ready_to_verify");
    });

    test("persistRunStatus never downgrades a verify-in-flight / terminal run back to ready_to_verify", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6A-4" });
      // A claimed run (verifying) must not be reopened by a late/duplicate build|test marker.
      await updateDevRun(run.id, { status: "verifying" });
      expect((await persistRunStatus(run.id, "ready_to_verify"))?.status).toBe("verifying");
      // Terminal runs are likewise sticky.
      await updateDevRun(run.id, { status: "green" });
      expect((await persistRunStatus(run.id, "ready_to_verify"))?.status).toBe("green");
    });

    test("persistRunStatus passes through all non-ready_to_verify transitions normally", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6A-5" });
      await updateDevRun(run.id, { status: "ready_to_verify" });
      // verifying / green / red writes are unconditional (the green gate sets them).
      expect((await persistRunStatus(run.id, "verifying"))?.status).toBe("verifying");
      expect((await persistRunStatus(run.id, "green"))?.status).toBe("green");
    });
  });

  describe("claimForReengage + clearOrchestrateHandoffs (Phase 6b re-engage on red)", () => {
    test("a fresh run starts with reengage_count 0", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6B-0" });
      expect(run.reengageCount).toBe(0);
    });

    test("claimForReengage increments + re-opens red → building for the single winner", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6B-1" });
      await updateDevRun(run.id, { status: "red" });
      const claimed = await claimForReengage(run.id);
      expect(claimed?.status).toBe("building");
      expect(claimed?.reengageCount).toBe(1);
      // A concurrent second claim loses — the run already left `red`.
      expect(await claimForReengage(run.id)).toBeNull();
    });

    test("claimForReengage is a no-op (null) when the run isn't red", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6B-2" }); // analyzing
      expect(await claimForReengage(run.id)).toBeNull();
      await updateDevRun(run.id, { status: "verifying" });
      expect(await claimForReengage(run.id)).toBeNull();
    });

    test("claimForReengage stops at the cap (run stays red, count unchanged)", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6B-3" });
      // Simulate a run that has already spent both attempts and gone red again.
      await updateDevRun(run.id, { status: "red" });
      const sql = getDb();
      await sql`UPDATE dev_runs SET reengage_count = ${2} WHERE id = ${run.id}`;
      expect(await claimForReengage(run.id, 2)).toBeNull();
      const after = await getDevRunById(run.id);
      expect(after?.status).toBe("red");
      expect(after?.reengageCount).toBe(2); // not bumped past the cap
    });

    test("claimForReengage honours a custom maxAttempts", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6B-4" });
      await updateDevRun(run.id, { status: "red" });
      // First attempt allowed (0 < 1).
      expect((await claimForReengage(run.id, 1))?.reengageCount).toBe(1);
      // Back to red; second attempt blocked (1 < 1 is false).
      await updateDevRun(run.id, { status: "red" });
      expect(await claimForReengage(run.id, 1)).toBeNull();
    });

    test("clearOrchestrateHandoffs deletes only orchestrate rows, leaving build/test/review", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6B-5" });
      await insertHandoff({ runId: run.id, peerName: "api", role: "build", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "rev", role: "review", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "orch", role: "orchestrate", status: "failed" });

      expect(await clearOrchestrateHandoffs(run.id)).toBe(1);
      const remaining = await listHandoffs(run.id);
      expect(remaining.map((h) => h.role).sort()).toEqual(["build", "review", "test"]);
    });

    test("re-engage reset lets a re-fixed build roll back up to ready_to_verify", async () => {
      // orchestrate-red run: build done, test done, orchestrate failed.
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "P6B-6" });
      await insertHandoff({ runId: run.id, peerName: "api", role: "build", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "e2e", role: "test", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "orch", role: "orchestrate", status: "failed" });
      await updateDevRun(run.id, { status: "red" });
      expect(await computeRunStatus(run.id)).toBe("red");

      // Claim + clear (what the router does on a red re-engage).
      const claimed = await claimForReengage(run.id);
      expect(claimed?.status).toBe("building");
      await clearOrchestrateHandoffs(run.id);

      // The re-engage turn re-delegates build (a fresh row, same peer); until it
      // reports, the run is `building`.
      await insertHandoff({ runId: run.id, peerName: "api", role: "build", status: "sent" });
      expect(await computeRunStatus(run.id)).toBe("building");

      // The build peer's reply rolls up ALL its build rows by (run, peer_name).
      await updateHandoffStatus({ runId: run.id, peerName: "api", status: "done" });
      // build∧test done, no orchestrate → ready to re-verify (a fresh e2e re-runs).
      expect(await computeRunStatus(run.id)).toBe("ready_to_verify");
    });
  });

  describe("dev_run_events (Phase A progress notes)", () => {
    test("insertDevRunEvent appends; listDevRunEvents returns chronological", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "EV-1" });
      const e1 = await insertDevRunEvent({ runId: run.id, peerName: "api", kind: "discovery", text: "found it", role: "build" });
      const e2 = await insertDevRunEvent({ runId: run.id, peerName: "e2e", kind: "blocker", text: "mock missing field", role: "test" });
      const events = await listDevRunEvents(run.id);
      expect(events.map((e) => e.id)).toEqual([e1.id, e2.id]); // oldest first
      expect(events[0]!.kind).toBe("discovery");
      expect(events[0]!.role).toBe("build");
      expect(events[1]!.peerName).toBe("e2e");
    });

    test("insertDevRunEvent caps text at DEV_RUN_EVENT_TEXT_CAP", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "EV-2" });
      const e = await insertDevRunEvent({
        runId: run.id, peerName: "api", kind: "decision", text: "x".repeat(DEV_RUN_EVENT_TEXT_CAP + 200),
      });
      expect(e.text.length).toBe(DEV_RUN_EVENT_TEXT_CAP);
    });

    test("listDevRunEvents keeps only the last `limit` (newest), re-ordered oldest-first", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "EV-3" });
      for (let i = 0; i < 5; i++) {
        await insertDevRunEvent({ runId: run.id, peerName: "api", kind: "milestone", text: `note ${i}` });
      }
      const events = await listDevRunEvents(run.id, 3);
      expect(events.map((e) => e.text)).toEqual(["note 2", "note 3", "note 4"]);
    });

    test("role is optional (a note with no matching handoff)", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "EV-4" });
      const e = await insertDevRunEvent({ runId: run.id, peerName: "unknown", kind: "discovery", text: "x" });
      expect(e.role).toBeUndefined();
    });

    test("FK CASCADE: deleting a run removes its events", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "EV-5" });
      await insertDevRunEvent({ runId: run.id, peerName: "api", kind: "discovery", text: "x" });
      await getDb()`DELETE FROM dev_runs WHERE id = ${run.id}`;
      expect(await listDevRunEvents(run.id)).toHaveLength(0);
    });
  });

  describe("markHandoffWorking (Phase A — guarded sent → working)", () => {
    test("flips sent → working for the matching (run, peer_name)", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MW-1" });
      await insertHandoff({ runId: run.id, peerName: "api", role: "build" }); // sent
      expect(await markHandoffWorking(run.id, "api")).toBe(1);
      expect((await listHandoffs(run.id))[0]!.status).toBe("working");
    });

    test("never downgrades done/failed; no-op once already working", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MW-2" });
      await insertHandoff({ runId: run.id, peerName: "done-peer", role: "build", status: "done" });
      await insertHandoff({ runId: run.id, peerName: "fail-peer", role: "test", status: "failed" });
      await insertHandoff({ runId: run.id, peerName: "live", role: "review" });
      expect(await markHandoffWorking(run.id, "done-peer")).toBe(0);
      expect(await markHandoffWorking(run.id, "fail-peer")).toBe(0);
      expect(await markHandoffWorking(run.id, "live")).toBe(1);
      expect(await markHandoffWorking(run.id, "live")).toBe(0); // already working
      const statuses = (await listHandoffs(run.id)).map((h) => `${h.peerName}:${h.status}`).sort();
      expect(statuses).toEqual(["done-peer:done", "fail-peer:failed", "live:working"]);
    });

    test("0 rows on a (run, peer_name) join miss", async () => {
      const run = await birthDevRun({ botName: "b", userId: "u", issueKey: "MW-3" });
      await insertHandoff({ runId: run.id, peerName: "api", role: "build" });
      expect(await markHandoffWorking(run.id, "WRONG")).toBe(0);
    });
  });
});
