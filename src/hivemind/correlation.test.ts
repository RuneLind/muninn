import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "../db/client.ts";
import {
  setPendingPeer,
  getPendingPeer,
  clearPendingPeer,
} from "./correlation.ts";

setupTestDb();

// Thread ids are UUIDs (the column type). No FK, so the rows don't need a
// matching threads row — the router validates the thread separately.
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

describe("peer-correlation store (DB-backed)", () => {
  test("get returns null when nothing is set", async () => {
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBeNull();
  });

  test("set then get returns the threadId", async () => {
    await setPendingPeer("jarvis", "peer-huginn", T1);
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBe(T1);
  });

  test("last write wins for the same (bot, peer) key", async () => {
    await setPendingPeer("jarvis", "peer-huginn", T1);
    await setPendingPeer("jarvis", "peer-huginn", T2);
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBe(T2);
  });

  test("entries expire after TTL", async () => {
    await setPendingPeer("jarvis", "peer-huginn", T1, 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBeNull();
  });

  test("get does not consume the entry (follow-ups still route)", async () => {
    await setPendingPeer("jarvis", "peer-huginn", T1);
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBe(T1);
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBe(T1);
  });

  test("different (bot, peer) keys are independent", async () => {
    await setPendingPeer("jarvis", "peer-huginn", T1);
    await setPendingPeer("melosys", "peer-huginn", T2);
    await setPendingPeer("jarvis", "peer-yggdrasil", T1);
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBe(T1);
    expect(await getPendingPeer("melosys", "peer-huginn")).toBe(T2);
    expect(await getPendingPeer("jarvis", "peer-yggdrasil")).toBe(T1);
  });

  test("clear removes the entry", async () => {
    await setPendingPeer("jarvis", "peer-huginn", T1);
    await clearPendingPeer("jarvis", "peer-huginn");
    expect(await getPendingPeer("jarvis", "peer-huginn")).toBeNull();
  });

  test("correlation is durable — survives a process restart (DB-backed)", async () => {
    // Simulate a restart: the binding lives in the DB, so a brand-new read
    // (no in-memory state) still resolves it. We assert directly against the
    // persisted row and a fresh getPendingPeer call.
    await setPendingPeer("jarvis", "peer-huginn", T1);

    const sql = getDb();
    const rows = await sql`
      SELECT thread_id FROM peer_thread_correlation
      WHERE bot_name = 'jarvis' AND peer_id = 'peer-huginn'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.thread_id).toBe(T1);

    expect(await getPendingPeer("jarvis", "peer-huginn")).toBe(T1);
  });
});
