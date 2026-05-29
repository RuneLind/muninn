import { describe, test, expect, mock } from "bun:test";

// Silence the logger (unconfigured loggers are no-ops, but the module calls getLog at import).
mock.module("../logging.ts", () => ({
  getLog: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { resolveChannelId } = await import("./cache.ts");

/** Minimal fake WebClient that records how many times conversations.list paginates. */
function fakeClient(channels: { id: string; name: string }[]) {
  let listCalls = 0;
  const client = {
    conversations: {
      list: async () => {
        listCalls++;
        return { channels, response_metadata: { next_cursor: undefined } };
      },
    },
  };
  return { client: client as any, calls: () => listCalls };
}

describe("resolveChannelId", () => {
  test("resolves a #name to its id and caches it (no re-pagination on hit)", async () => {
    const name = `pos-${crypto.randomUUID()}`;
    const { client, calls } = fakeClient([{ id: "C123", name }]);

    const first = await resolveChannelId(client, `#${name}`);
    expect(first).toBe("C123");
    expect(calls()).toBe(1);

    // Second lookup is a cache hit — must not paginate again.
    const second = await resolveChannelId(client, `#${name}`);
    expect(second).toBe("C123");
    expect(calls()).toBe(1);
  });

  test("passes through an id-shaped name without an API call", async () => {
    const { client, calls } = fakeClient([]);
    const out = await resolveChannelId(client, "C0ABCDEF123");
    expect(out).toBe("C0ABCDEF123");
    expect(calls()).toBe(0);
  });

  test("negative-caches a miss so a second lookup does not re-paginate", async () => {
    const missing = `missing-${crypto.randomUUID()}`;
    const { client, calls } = fakeClient([{ id: "Cother", name: "other" }]);

    // First miss paginates the full list, then falls back to the raw name.
    const first = await resolveChannelId(client, `#${missing}`);
    expect(first).toBe(missing);
    expect(calls()).toBe(1);

    // Second lookup of the same missing name is served from the negative cache.
    const second = await resolveChannelId(client, `#${missing}`);
    expect(second).toBe(missing);
    expect(calls()).toBe(1); // NOT 2 — this is the fix
  });
});
