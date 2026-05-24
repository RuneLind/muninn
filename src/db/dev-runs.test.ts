import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  birthDevRun,
  getDevRunById,
  getDevRunByThreadId,
  getDevRunByIdentity,
  updateDevRun,
  linkSpecToDevRun,
  insertHandoff,
  updateHandoffStatus,
  listHandoffs,
  computeRunStatus,
} from "./dev-runs.ts";

setupTestDb();

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
});
