/**
 * The migrations read's bound covers the wait for a pool connection too: a
 * query still queued (or running) at the bound is cancelled, so it neither
 * answers late nor stays in the pool's queue. A fake postgres.js query.
 */
import { describe, expect, test } from "bun:test";
import { cancellableQuery } from "./real-deps.ts";

/** A query that settles only when told to, and records its cancel. */
function fakeQuery<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    settle = res;
    fail = rej;
  });
  const q = Object.assign(p, {
    cancels: 0,
    cancel() {
      q.cancels++;
      // postgres.js rejects a cancelled query (dequeued or cancelled on the server).
      fail(new Error("canceling statement due to user request"));
    },
  });
  return { q, settle };
}

describe("cancellableQuery", () => {
  test("a query that never gets a connection rejects at the bound and is cancelled once", async () => {
    const { q } = fakeQuery<number>();
    const t0 = Date.now();
    await expect(cancellableQuery(q, 60)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(q.cancels).toBe(1);
  });

  test("a query that answers in time is not cancelled", async () => {
    const { q, settle } = fakeQuery<number>();
    setTimeout(() => settle(7), 5);
    expect(await cancellableQuery(q, 1_000)).toBe(7);
    await Bun.sleep(20);
    expect(q.cancels).toBe(0);
  });
});
