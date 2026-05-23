import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "../db/client.ts";
import {
  mintCorrelationToken,
  setCorrelationToken,
  getThreadByCorrelationToken,
  clearCorrelationToken,
} from "./correlation-tokens.ts";

setupTestDb();

// Thread ids are UUIDs (the column type). No FK, so the rows don't need a
// matching threads row — the router validates the thread separately.
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

describe("correlation-token store (DB-backed)", () => {
  test("get returns null when nothing is set", async () => {
    expect(await getThreadByCorrelationToken("jarvis", "cid-absent")).toBeNull();
  });

  test("set then get returns the threadId", async () => {
    await setCorrelationToken("jarvis", "cid-a", T1);
    expect(await getThreadByCorrelationToken("jarvis", "cid-a")).toBe(T1);
  });

  test("mintCorrelationToken returns distinct opaque tokens", () => {
    const a = mintCorrelationToken();
    const b = mintCorrelationToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("precision: two tokens for the same (bot, peer) resolve to different threads", async () => {
    // This is the whole point — unlike peer_thread_correlation's last-write-wins,
    // a unique token per outbound means concurrent outbounds don't collide.
    await setCorrelationToken("jarvis", "cid-1", T1);
    await setCorrelationToken("jarvis", "cid-2", T2);
    expect(await getThreadByCorrelationToken("jarvis", "cid-1")).toBe(T1);
    expect(await getThreadByCorrelationToken("jarvis", "cid-2")).toBe(T2);
  });

  test("entries expire after TTL", async () => {
    await setCorrelationToken("jarvis", "cid-ttl", T1, 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await getThreadByCorrelationToken("jarvis", "cid-ttl")).toBeNull();
  });

  test("get does not consume the entry (follow-ups still route)", async () => {
    await setCorrelationToken("jarvis", "cid-followup", T1);
    expect(await getThreadByCorrelationToken("jarvis", "cid-followup")).toBe(T1);
    expect(await getThreadByCorrelationToken("jarvis", "cid-followup")).toBe(T1);
  });

  test("tokens are scoped by bot — a foreign bot's token doesn't resolve", async () => {
    await setCorrelationToken("jarvis", "cid-shared", T1);
    expect(await getThreadByCorrelationToken("melosys", "cid-shared")).toBeNull();
    expect(await getThreadByCorrelationToken("jarvis", "cid-shared")).toBe(T1);
  });

  test("clear removes the token", async () => {
    await setCorrelationToken("jarvis", "cid-clear", T1);
    await clearCorrelationToken("jarvis", "cid-clear");
    expect(await getThreadByCorrelationToken("jarvis", "cid-clear")).toBeNull();
  });

  test("setCorrelationToken sweeps expired rows opportunistically", async () => {
    await setCorrelationToken("jarvis", "cid-old", T1, 1); // expires immediately
    await new Promise((r) => setTimeout(r, 10));
    // A later write triggers the sweep, removing the expired row entirely.
    await setCorrelationToken("jarvis", "cid-new", T2);
    const sql = getDb();
    const rows = await sql`
      SELECT correlation_id FROM peer_correlation_tokens
      WHERE bot_name = 'jarvis' AND correlation_id = 'cid-old'
    `;
    expect(rows).toHaveLength(0);
  });
});
