import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { $ } from "bun";
import {
  ADMIN_DENY_LIST,
  AUDITED_COLLECTION_PATHS,
  HEALTH_LIVE_PATH,
  HEALTH_READY_PATH,
  OPEN_ZONE_PATHS,
  USER_ZONE_PATHS,
  decideZone,
  inPathList,
  isAuditedCollectionRead,
  matchPathPattern,
} from "./zones.ts";
import { AUTH_EXCLUDED_PATHS } from "./mode.ts";

const asUser = (path: string, method = "GET") => decideZone({ method, path, role: "user" });
const asAdmin = (path: string, method = "GET") => decideZone({ method, path, role: "admin" });

describe("matchPathPattern", () => {
  test(":segment matches exactly one non-empty segment", () => {
    const p = "/chat/bot-preferences/:botName/default-user";
    expect(matchPathPattern(p, "/chat/bot-preferences/jarvis/default-user")).toBe(true);
    // Not two segments, and not an empty one — Hono matches `:x` the same way.
    expect(matchPathPattern(p, "/chat/bot-preferences/a/b/default-user")).toBe(false);
    expect(matchPathPattern(p, "/chat/bot-preferences//default-user")).toBe(false);
    expect(matchPathPattern(p, "/chat/bot-preferences/jarvis/default-user/x")).toBe(false);
  });
});

describe("inPathList", () => {
  test("a trailing slash makes an entry a PREFIX, and the bare path is NOT one", () => {
    // The whole reason the collection reads stay admin: `/api/goals/` admits
    // `/api/goals/<user>` and does not admit `/api/goals`.
    expect(inPathList(["/api/goals/"], "/api/goals/rune")).toBe(true);
    expect(inPathList(["/api/goals/"], "/api/goals")).toBe(false);
  });

  test("`/` is an exact entry, never a prefix over the whole app", () => {
    expect(inPathList(["/"], "/")).toBe(true);
    expect(inPathList(["/"], "/traces")).toBe(false);
  });
});

describe("decideZone", () => {
  test("default-deny: an unlisted route is refused to role `user`", () => {
    for (const path of ["/traces", "/models", "/plans", "/agents", "/logs", "/api/prompts/abc", "/api/attention"]) {
      expect(asUser(path).allowed, path).toBe(false);
    }
  });

  test("an admin reaches everything, deny list included", () => {
    for (const path of ["/traces", "/api/users", "/chat/bot-preferences/jarvis/default-user", "/chat/me"]) {
      expect(asAdmin(path).allowed, path).toBe(true);
    }
  });

  test("the user zone covers /chat/* and the routes the chat page fetches", () => {
    for (const path of ["/chat", "/chat/me", "/chat/events", "/api/goals/rune", "/api/traces/abc", "/api/jira/drafts"]) {
      expect(asUser(path).allowed, path).toBe(true);
      expect(asUser(path).zone, path).toBe("user");
    }
  });

  test("GET /api/events is NOT in the user zone", () => {
    // The route has its own `resolveRole` denial, and this is the second lock:
    // if that check were ever removed, the zone must still refuse it. Its
    // channels replay every user's message text and a process-wide agent_runs
    // snapshot.
    expect(inPathList(USER_ZONE_PATHS, "/api/events")).toBe(false);
    expect(asUser("/api/events").allowed).toBe(false);
  });

  test("the unfiltered collection reads are admin while their id-addressed siblings are not", () => {
    for (const path of AUDITED_COLLECTION_PATHS) expect(asUser(path).allowed, path).toBe(false);
    // …and the pairs that differ by one trailing segment.
    expect(asUser("/api/goals/rune").allowed).toBe(true);
    expect(asUser("/api/traces/abc").allowed).toBe(true);
    expect(asUser("/api/memories/user/rune").allowed).toBe(true);
    expect(asUser("/api/memories/by-user").allowed).toBe(false);
  });

  test("the deny list beats the /chat/* prefix, on every method incl. HEAD", () => {
    const path = "/chat/bot-preferences/jarvis/default-user";
    for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) {
      expect(asUser(path, method).allowed, method).toBe(false);
    }
    // The sibling under the same prefix is still in the user zone.
    expect(asUser("/chat/preferences/rune/jarvis").allowed).toBe(true);
  });

  test("HEAD is judged as GET — Hono dispatches it to the get handler and RUNS the body", () => {
    expect(asUser("/chat/me", "HEAD").allowed).toBe(true);
    expect(asUser("/api/users", "HEAD").allowed).toBe(false);
  });

  test("the open zone answers for a `user`, health paths and favicons alike", () => {
    for (const path of OPEN_ZONE_PATHS) {
      expect(asUser(path).allowed, path).toBe(true);
      expect(asUser(path).zone, path).toBe("open");
    }
  });

  test("auth off (no role) allows everything — no middleware is mounted there", () => {
    expect(decideZone({ method: "GET", path: "/traces", role: null }).allowed).toBe(true);
    expect(decideZone({ method: "GET", path: "/traces", role: undefined }).allowed).toBe(true);
  });

  test("the simulator compat redirects are dispositioned, not 403'd on the way to /chat", () => {
    // They are registered AFTER app.route, so the `app.use("*")` middleware
    // covers them: without an entry a `user` would be refused at a URL whose
    // only job is to 301 into the surface they do have.
    expect(asUser("/simulator").allowed).toBe(true);
    expect(asUser("/simulator/threads/abc").allowed).toBe(true);
  });
});

describe("the health paths", () => {
  test("both are excluded from auth, and are the ONLY exclusions", () => {
    // An entry in AUTH_EXCLUDED_PATHS is a route reachable with no credential
    // at all, so the list being short is the property, not an accident.
    expect([...AUTH_EXCLUDED_PATHS].sort()).toEqual([HEALTH_LIVE_PATH, HEALTH_READY_PATH].sort());
  });

  test("and they are in the open zone, so the zone middleware cannot re-close them", () => {
    expect(inPathList(OPEN_ZONE_PATHS, HEALTH_LIVE_PATH)).toBe(true);
    expect(inPathList(OPEN_ZONE_PATHS, HEALTH_READY_PATH)).toBe(true);
  });
});

describe("isAuditedCollectionRead", () => {
  test("all seven collections, eight path entries — by-user is a separate registration", () => {
    expect(AUDITED_COLLECTION_PATHS).toHaveLength(8);
    for (const path of AUDITED_COLLECTION_PATHS) {
      expect(isAuditedCollectionRead("GET", path), path).toBe(true);
      expect(isAuditedCollectionRead("HEAD", path), path).toBe(true);
    }
    expect(AUDITED_COLLECTION_PATHS).toContain("/api/memories");
    expect(AUDITED_COLLECTION_PATHS).toContain("/api/memories/by-user");
  });

  test("exact paths only — a prefix would swallow the owner-guarded siblings", () => {
    expect(isAuditedCollectionRead("GET", "/api/memories/user/rune")).toBe(false);
    expect(isAuditedCollectionRead("GET", "/api/traces/abc")).toBe(false);
    expect(isAuditedCollectionRead("GET", "/api/goals/rune")).toBe(false);
  });

  test("a WRITE is not a collection read", () => {
    expect(isAuditedCollectionRead("POST", "/api/users")).toBe(false);
    expect(isAuditedCollectionRead("DELETE", "/api/threads")).toBe(false);
  });
});

describe("every `admin-zone` inventory row is CHECKED against decideZone", () => {
  // `inventory.test.ts` only checks that the disposition STRING is in the
  // vocabulary — it never probes that an `admin-zone` row is actually denied to
  // role `user`. Mutation proof: adding `/api/messages/` + `/api/users/` to
  // USER_ZONE_PATHS opens a colleague's message history and passes that suite
  // green. This is the probe-column idiom `zone-inventory.test.ts` uses, over
  // the claimed-id fixture.
  const FIXTURE = "src/auth/claimed-id-inventory.txt";

  interface Probe { file: string; method: string; path: string; raw: string; }

  async function adminZoneProbes(): Promise<Probe[]> {
    const text = await readFile(FIXTURE, "utf8");
    const probes: Probe[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const [body] = line.split("   #");
      const parts = body!.split("|").map((p) => p.trim());
      if (parts.length !== 3 || parts[2] !== "admin-zone") continue;
      const file = parts[0]!;
      // signature is `<METHOD> <PATH>` or `<token> in <METHOD> <PATH>`.
      const m = parts[1]!.match(/(?:.* in )?([A-Z]+)\s+(\/\S+)/);
      if (!m) throw new Error(`admin-zone row has no METHOD PATH: ${line}`);
      let path = m[2]!.replace(/:[^/]+/g, "x");
      // Chat routes are mounted under `/chat`; the fixture path is relative.
      if (file === "src/chat/routes.ts" && !path.startsWith("/chat")) path = `/chat${path}`;
      probes.push({ file, method: m[1]!, path, raw: parts[1]! });
    }
    return probes;
  }

  test("there is at least one admin-zone row to probe", async () => {
    expect((await adminZoneProbes()).length).toBeGreaterThan(0);
  });

  test("each derived path is denied to role `user`", async () => {
    const wrong: string[] = [];
    for (const p of await adminZoneProbes()) {
      const got = decideZone({ method: p.method, path: p.path, role: "user" });
      if (got.allowed) wrong.push(`${p.raw} (probe ${p.method} ${p.path}): says admin-zone but decideZone ALLOWS it`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("AUDITED_COLLECTION_PATHS name REAL registered routes", () => {
  // The list drives the admin-collection audit hook, but nothing ties it to the
  // route table. Mutation proof: renaming `/api/watchers` → `/api/watcherz`
  // leaves the suite green (`toHaveLength(8)` cannot see a substitution), so a
  // typo'd or renamed route silently drops out of the audit forever. Cross-check
  // each entry against a real `app.get("<path>", …)` registration.
  async function registeredGetPaths(): Promise<Set<string>> {
    // Both `app.get("/p"` and `app.on("GET"|"HEAD", "/p"` forms, over the same
    // files the claimed-id inventory walks.
    const out = await $`grep -rnE ${String.raw`app\.(get|on)\(`} src/chat/routes.ts src/dashboard/routes/`
      .nothrow().text();
    const paths = new Set<string>();
    for (const line of out.split("\n")) {
      if (line.trim() === "" || line.split(":")[0]!.includes(".test.")) continue;
      const on = line.match(/app\.on\(\s*"[A-Z]+"\s*,\s*"([^"]+)"/);
      const get = line.match(/app\.get\(\s*"([^"]+)"/);
      if (on) paths.add(on[1]!);
      else if (get) paths.add(get[1]!);
    }
    return paths;
  }

  test("every audited path has a GET registration in the route table", async () => {
    const registered = await registeredGetPaths();
    const orphans = [...AUDITED_COLLECTION_PATHS].filter((p) => !registered.has(p));
    expect(orphans, "audited paths with no app.get registration").toEqual([]);
  });
});

describe("the deny list", () => {
  test("every entry names a real note and a pattern under a user-zone prefix", () => {
    for (const entry of ADMIN_DENY_LIST) {
      expect(entry.note.length, entry.pattern).toBeGreaterThan(10);
      // A deny row that is NOT under an allowlist prefix is dead weight —
      // default-deny already refuses it — and reads as protection it is not.
      const concrete = entry.pattern.replace(/:[^/]+/g, "x");
      expect(inPathList(USER_ZONE_PATHS, concrete), entry.pattern).toBe(true);
    }
  });
});
