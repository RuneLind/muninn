import { describe, test, expect } from "bun:test";
import {
  claimsFromIntrospection,
  createEntraIntrospector,
  createIntrospector,
  denialReason,
  identityOf,
  INTROSPECTION_CACHE_MAX_ENTRIES,
  INTROSPECTION_CACHE_MAX_MS,
  INTROSPECTION_NEGATIVE_TTL_MS,
  type NavTokenClaims,
} from "./introspect.ts";
import { resolveAuthConfig } from "./mode.ts";

/**
 * The Entra introspector, driven with no network and no database.
 *
 * The cache and the single flight are the two properties nothing else can see:
 * both are pure performance from the outside — an instance with neither works
 * perfectly and just asks Texas per request, and in `entra` mode "per request"
 * also means "a provisioning transaction per request". So they are asserted by
 * COUNTING the injected calls.
 *
 * No NAV values anywhere: this repo is public. `example-tenant`, `X999999` and
 * a `texas.test` URL that resolves to nothing.
 */

const CONFIG = resolveAuthConfig({
  MUNINN_AUTH: "entra",
  NAIS_TOKEN_INTROSPECTION_ENDPOINT: "http://texas.test/introspect",
  MUNINN_TENANT: "example-tenant",
  MUNINN_ADMIN_IDENTS: "X999999",
  MUNINN_ALLOWED_ORIGINS: "https://muninn.example.test",
});

const OID = "00000000-1111-2222-3333-444444444444";

interface Harness {
  posts: number;
  resolves: number;
  bodies: unknown[];
  now: number;
}

function harness(
  body: unknown = { active: true, oid: OID, NAVident: "X999999", name: "Test Person", exp: 4102444800 },
  opts: { status?: number; throws?: boolean; resolveThrows?: boolean; delayMs?: number } = {},
) {
  const h: Harness = { posts: 0, resolves: 0, bodies: [], now: 1_700_000_000_000 };
  const introspector = createEntraIntrospector(CONFIG, {
    now: () => h.now,
    async post() {
      h.posts++;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throws) throw new Error("connect ECONNREFUSED");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    async resolveUser(claims: NavTokenClaims) {
      h.resolves++;
      h.bodies.push(claims);
      if (opts.resolveThrows) throw new Error("the database is unreachable");
      return `nav-${(claims.navIdent ?? claims.oid).toLowerCase()}`;
    },
  });
  return { h, introspector };
}

describe("claimsFromIntrospection", () => {
  test("active:true with an oid maps every field", () => {
    expect(claimsFromIntrospection(
      { active: true, oid: OID, NAVident: "X999999", name: "Test Person", exp: 1_700_003_600 },
      "example-tenant",
    )).toEqual({
      oid: OID,
      navIdent: "X999999",
      displayName: "Test Person",
      tenant: "example-tenant",
      expiresAt: 1_700_003_600_000,
    });
  });

  test("active anything but true is a refusal", () => {
    for (const active of [false, "true", 1, undefined, null]) {
      expect(claimsFromIntrospection({ active, oid: OID }, "t")).toBeNull();
    }
  });

  test("no oid is a refusal — it is the match key", () => {
    // Without it there is no stable row to link, and minting per login would
    // hand one person a brand-new account every token refresh.
    expect(claimsFromIntrospection({ active: true, NAVident: "X999999" }, "t")).toBeNull();
    expect(claimsFromIntrospection({ active: true, oid: "   " }, "t")).toBeNull();
  });

  test("an absent NAVident is NOT a refusal", () => {
    // The `claims.extra: ["NAVident"]` entry lives in another repository, so
    // this half must work without it.
    expect(claimsFromIntrospection({ active: true, oid: OID }, "t")?.navIdent).toBeNull();
  });

  test("a garbage or absent exp yields null rather than a bogus cap", () => {
    for (const exp of [undefined, "soon", -1, 0, null]) {
      expect(claimsFromIntrospection({ active: true, oid: OID, exp }, "t")?.expiresAt).toBeNull();
    }
  });

  test("a non-object body is a refusal, not a throw", () => {
    for (const body of [null, "yes", 42, undefined]) {
      expect(claimsFromIntrospection(body, "t")).toBeNull();
    }
  });

  test("an APP token is refused — `idtyp` says it is not a human", () => {
    // Client-credentials tokens introspect as `active: true` with an `oid`, so
    // the parser accepted them and provisioned a `users` row for a MACHINE,
    // which then holds a role, memories and threads. Measured against the stub
    // Texas: `idtyp: "app"` answered 200 and minted `nav-<oid>`.
    expect(claimsFromIntrospection({ active: true, oid: OID, idtyp: "app" }, "t")).toBeNull();
    expect(claimsFromIntrospection({ active: true, oid: OID, idtyp: "App" }, "t")).toBeNull();
    expect(claimsFromIntrospection({ active: true, oid: OID, idtyp: "user" }, "t")).not.toBeNull();
    // ABSENT is not "not user": Texas need not send the claim at all, and
    // refusing on its absence would refuse every ordinary human token.
    expect(claimsFromIntrospection({ active: true, oid: OID }, "t")).not.toBeNull();
  });
});

describe("denialReason — a Texas body-shape mismatch is a 5-minute diagnosis", () => {
  test("it names WHY a body that claimed to be active was refused", () => {
    // Before this, an `active: true` body with no usable `oid` was cached as a
    // denial with no log line at all: every colleague 401s, the sidecar looks
    // healthy, and nothing anywhere says the claim is missing.
    expect(denialReason({ active: true, oid: OID })).toBeNull();
    expect(denialReason({ active: true, oid: OID, idtyp: "user" })).toBeNull();
    expect(denialReason({ active: true })).toContain("oid");
    expect(denialReason({ active: true, oid: "  " })).toContain("oid");
    expect(denialReason({ active: true, oid: OID, idtyp: "app" })).toContain("idtyp");
  });

  test("an ordinary `active: false` has no reason to report", () => {
    // That is Texas answering the question, not a shape mismatch. Logging it
    // would put a line on every expired background tab's retry.
    expect(denialReason({ active: false })).toBeNull();
    expect(denialReason("nonsense")).toBeNull();
  });
});

describe("the Texas call and its mapping", () => {
  test("a valid token yields an entra identity carrying the resolved users.id", async () => {
    const { introspector, h } = harness();
    const identity = identityOf(await introspector.introspect("tok-a", "credential"));
    expect(identity).toEqual({
      userId: "nav-x999999",
      displayName: "Test Person",
      navIdent: "X999999",
      oid: OID,
      provider: "entra",
      expiresAt: 4102444800_000,
    });
    expect(h.resolves).toBe(1);
    expect(h.bodies[0]).toMatchObject({ tenant: "example-tenant" });
  });

  test("displayName falls back to NAVident, then to the oid", async () => {
    const noName = harness({ active: true, oid: OID, NAVident: "X999999" });
    expect(identityOf(await noName.introspector.introspect("t", "credential"))?.displayName).toBe("X999999");
    const bare = harness({ active: true, oid: OID });
    expect(identityOf(await bare.introspector.introspect("t", "credential"))?.displayName).toBe(OID);
  });

  test("the SESSION channel is refused without a Texas call at all", async () => {
    // `writeSessionCookie` no-ops in entra mode, so muninn mints no cookie
    // there: a `muninn_session` value can only be something a client made up,
    // and introspecting it would be a Texas round-trip per forged cookie.
    const { introspector, h } = harness();
    expect((await introspector.introspect("anything", "session")).kind).toBe("denied");
    expect(h.posts).toBe(0);
  });

  test("an empty token is refused without a call", async () => {
    const { introspector, h } = harness();
    expect((await introspector.introspect("", "credential")).kind).toBe("denied");
    expect(h.posts).toBe(0);
  });

  test("a non-200, a transport failure and a non-JSON body are UNAVAILABLE, not denied", async () => {
    // The distinction is the whole point of the three-way answer: an outage
    // must not be answered with the sidecar login url, or every client in the
    // building reloads into a service that is already struggling.
    for (const opts of [{ status: 503 }, { throws: true }]) {
      const { introspector } = harness(undefined, opts);
      expect((await introspector.introspect("tok", "credential")).kind).toBe("unavailable");
    }
    const bad = createEntraIntrospector(CONFIG, {
      post: async () => new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } }),
      resolveUser: async () => "nav-x",
    });
    expect((await bad.introspect("tok", "credential")).kind).toBe("unavailable");
  });

  test("a database failure refuses the login rather than inventing an identity", async () => {
    const { introspector } = harness(undefined, { resolveThrows: true });
    expect((await introspector.introspect("tok", "credential")).kind).toBe("unavailable");
  });
});

describe("the cache", () => {
  test("a second call on the same token makes no second Texas call", async () => {
    const { introspector, h } = harness();
    await introspector.introspect("tok-a", "credential");
    await introspector.introspect("tok-a", "credential");
    await introspector.introspect("tok-a", "credential");
    expect(h.posts).toBe(1);
    // The provisioning half matters as much: uncached, every request would open
    // a transaction against `user_identities`.
    expect(h.resolves).toBe(1);
  });

  test("a DIFFERENT token is a different entry", async () => {
    const { introspector, h } = harness();
    await introspector.introspect("tok-a", "credential");
    await introspector.introspect("tok-b", "credential");
    expect(h.posts).toBe(2);
  });

  test("the entry expires at the cap, and is then re-fetched", async () => {
    const { introspector, h } = harness();
    await introspector.introspect("tok-a", "credential");
    h.now += INTROSPECTION_CACHE_MAX_MS - 1;
    await introspector.introspect("tok-a", "credential");
    expect(h.posts).toBe(1);
    h.now += 2;
    await introspector.introspect("tok-a", "credential");
    expect(h.posts).toBe(2);
  });

  test("the token's own exp beats the cap when it is nearer", async () => {
    // Correctness, not tuning: a token must stop working when it expires, even
    // if the cap would have kept it another four minutes.
    const start = 1_700_000_000_000;
    const { introspector, h } = harness({ active: true, oid: OID, exp: (start + 60_000) / 1000 });
    await introspector.introspect("tok-a", "credential");
    h.now = start + 59_000;
    await introspector.introspect("tok-a", "credential");
    expect(h.posts).toBe(1);
    h.now = start + 61_000;
    await introspector.introspect("tok-a", "credential");
    expect(h.posts).toBe(2);
  });

  test("a token past its own exp is DENIED, whatever Texas says about it", async () => {
    // Measured before the fix: Texas answering `active: true` with an `exp` in
    // the PAST was accepted — the expired token got a 200 AND provisioned a
    // user. The cache TTL clamped to `exp` so it was never REUSED, which is why
    // it looked handled; every request simply re-asked and was let in again.
    const start = 1_700_000_000_000;
    const { introspector, h } = harness({ active: true, oid: OID, exp: (start - 10_000) / 1000 });
    expect((await introspector.introspect("tok-a", "credential")).kind).toBe("denied");
    // …and it is a real denial, so it is remembered for the negative window
    // rather than re-asking Texas per retry.
    await introspector.introspect("tok-a", "credential");
    expect(h.posts).toBe(1);
    expect(h.resolves).toBe(0);
  });

  test("a DEFINITIVE refusal is cached briefly; an OUTAGE is not cached at all", async () => {
    // The split is the point. `active: false` for these exact bytes cannot
    // become true, so a retrying background tab costs one call per window. A
    // Texas blip must not refuse logins for a window after it recovers.
    const no = harness({ active: false });
    expect((await no.introspector.introspect("tok", "credential")).kind).toBe("denied");
    await no.introspector.introspect("tok", "credential");
    expect(no.h.posts).toBe(1);
    no.h.now += INTROSPECTION_NEGATIVE_TTL_MS + 1;
    await no.introspector.introspect("tok", "credential");
    expect(no.h.posts).toBe(2);

    const down = harness(undefined, { throws: true });
    await down.introspector.introspect("tok", "credential");
    await down.introspector.introspect("tok", "credential");
    expect(down.h.posts).toBe(2);
  });
});

describe("the cache is BOUNDED, not merely swept", () => {
  test("a flood of tokens Texas refuses cannot grow the map past the cap", async () => {
    // Measured before the fix: 5000 distinct forged tokens ⇒ 5000 live entries.
    // The sweep only ever evicted EXPIRED rows, and a denial is live for its
    // whole 30 s window — so an unauthenticated client could size the map from
    // outside. Nothing about this is hypothetical: the tokens need not be
    // valid, only distinct.
    const { introspector } = harness({ active: false });
    for (let i = 0; i < INTROSPECTION_CACHE_MAX_ENTRIES * 2; i++) {
      await introspector.introspect(`forged-${i}`, "credential");
    }
    expect(introspector.cacheSize()).toBeLessThanOrEqual(INTROSPECTION_CACHE_MAX_ENTRIES);
  });

  test("eviction takes the SOONEST-to-expire first, so live sessions survive a flood", async () => {
    // A cap that evicted arbitrarily would answer a flood by throwing away the
    // working sessions — one Texas call per request for everyone in the
    // building, which is the outage the cache exists to prevent.
    let posts = 0;
    const introspector = createEntraIntrospector(CONFIG, {
      now: () => 1_700_000_000_000,
      async post(_endpoint, token) {
        posts++;
        // A denial lives for 30 s; the real identity for the 5-minute cap.
        const body = token === "real-token"
          ? { active: true, oid: OID, NAVident: "X999999", exp: 4102444800 }
          : { active: false };
        return new Response(JSON.stringify(body));
      },
      resolveUser: async () => "nav-x999999",
    });
    await introspector.introspect("real-token", "credential");
    const afterReal = posts;
    for (let i = 0; i < INTROSPECTION_CACHE_MAX_ENTRIES + 200; i++) {
      await introspector.introspect(`forged-${i}`, "credential");
    }
    await introspector.introspect("real-token", "credential");
    // No second call for the real token: it outlived the flood.
    expect(posts).toBe(afterReal + INTROSPECTION_CACHE_MAX_ENTRIES + 200);
  });
});

describe("the socket's expiry cap always exists in entra", () => {
  test("an identity whose token declared no usable exp still carries one", async () => {
    // `expiresAt: null` reads as "no cap" at the WebSocket (`src/chat/ws.ts`),
    // so a token with a missing, zero or garbage `exp` produced a socket that
    // never expired — measured, still streaming eight seconds after the
    // credential's own lifetime. The introspection cap is the honest bound:
    // it is the longest this process will go without re-asking Texas anyway.
    for (const exp of [undefined, 0, "soon", -1]) {
      const { introspector, h } = harness({ active: true, oid: OID, exp });
      const identity = identityOf(await introspector.introspect("tok", "credential"));
      expect(identity?.expiresAt).toBe(h.now + INTROSPECTION_CACHE_MAX_MS);
    }
  });

  test("a real exp is still what wins when it is nearer", async () => {
    const start = 1_700_000_000_000;
    const { introspector } = harness({ active: true, oid: OID, exp: (start + 60_000) / 1000 });
    expect(identityOf(await introspector.introspect("tok", "credential"))?.expiresAt).toBe(start + 60_000);
  });
});

describe("the single flight", () => {
  test("concurrent misses on one token collapse onto ONE Texas call", async () => {
    // Acceptance 17's unit half: the chat page issues an HTTP request and a
    // /chat/ws upgrade on the same token milliseconds apart, and both miss.
    const { introspector, h } = harness(undefined, { delayMs: 20 });
    const results = await Promise.all([
      introspector.introspect("tok-a", "credential"),
      introspector.introspect("tok-a", "credential"),
      introspector.introspect("tok-a", "credential"),
    ]);
    expect(h.posts).toBe(1);
    expect(h.resolves).toBe(1);
    expect(results.map((r) => identityOf(r)?.userId)).toEqual(["nav-x999999", "nav-x999999", "nav-x999999"]);
  });

  test("the in-flight slot is released, so a later miss can still call", async () => {
    const { introspector, h } = harness(undefined, { delayMs: 5 });
    await Promise.all([
      introspector.introspect("tok-a", "credential"),
      introspector.introspect("tok-a", "credential"),
    ]);
    h.now += INTROSPECTION_CACHE_MAX_MS + 1;
    await introspector.introspect("tok-a", "credential");
    expect(h.posts).toBe(2);
  });

  test("a failing flight does not poison the slot", async () => {
    const { introspector } = harness(undefined, { throws: true, delayMs: 5 });
    await Promise.all([
      introspector.introspect("tok", "credential"),
      introspector.introspect("tok", "credential"),
    ]);
    expect((await introspector.introspect("tok", "credential")).kind).toBe("unavailable");
  });
});

describe("createIntrospector dispatch", () => {
  test("off ⇒ null, local ⇒ the shared-secret one, entra ⇒ the Texas one", () => {
    expect(createIntrospector(resolveAuthConfig({}))).toBeNull();
    expect(createIntrospector(resolveAuthConfig({
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: "a-sufficiently-long-secret",
      MUNINN_LOCAL_USER: "rune",
      MUNINN_ADMIN_IDENTS: "X999999",
      MUNINN_ALLOWED_ORIGINS: "http://127.0.0.1:3010",
    }))).not.toBeNull();
    expect(createIntrospector(CONFIG)).not.toBeNull();
  });
});
