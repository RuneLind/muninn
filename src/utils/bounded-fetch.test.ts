/**
 * The bounded read's cap failure is a TYPE, in both of its paths (a declared
 * `content-length` and a streamed body), so a caller classifies "too big"
 * without matching message text; the messages themselves are unchanged.
 */

import { describe, expect, test } from "bun:test";
import { BoundedReadCapError, readBounded, readBoundedBytes } from "./bounded-fetch.ts";

describe("BoundedReadCapError", () => {
  test("a declared length over the cap throws it, with the old message", async () => {
    const res = new Response("x".repeat(20), { headers: { "content-length": "20" } });
    const err = await readBoundedBytes(res, 10, "http://h/p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedReadCapError);
    expect((err as Error).message).toBe("response body is 20 bytes, over the 10-byte cap (http://h/p)");
  });

  test("a streamed body over the cap throws it, with the old message", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(8)));
        c.enqueue(new TextEncoder().encode("y".repeat(8)));
        c.close();
      },
    });
    const err = await readBounded(new Response(body), 10, "http://h/p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedReadCapError);
    expect((err as Error).message).toBe("response body exceeded the 10-byte cap (http://h/p)");
  });
});
