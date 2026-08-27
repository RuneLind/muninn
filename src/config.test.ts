import { test, expect, describe, afterEach } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { loadConfig, optionalEnvFlag, __resetEnvFlagWarningsForTest, adminIdentsFromEnv, allowedOriginsFromEnv, resolveServingProfile } from "./config.ts";

/**
 * `optionalEnvFlag` is how the instance-profile switches (`MUNINN_WIKI_READONLY`)
 * are read, and its accept-set is deliberately narrow: `1` / `true`.
 *
 * The failure it now reports is silent-OFF. `MUNINN_WIKI_READONLY=yes` on the Mac
 * mini reads as "writes are allowed here" — the exact configuration mistake the
 * flag exists to prevent, arriving with no signal at all. The value still parses
 * to OFF (fail-open on an unrecognized value is right — a typo must not brick an
 * instance), but it now says so once.
 */
describe("optionalEnvFlag", () => {
  const VAR = "MUNINN_TEST_FLAG";

  /** Capture muninn warnings — the logger is a silent no-op unless configured. */
  async function capture(): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    return records;
  }

  afterEach(async () => {
    delete process.env[VAR];
    __resetEnvFlagWarningsForTest();
    await reset();
  });

  test("accepts 1/true (case-insensitive, trimmed) and treats absence as OFF", () => {
    for (const raw of ["1", "true", "TRUE", " true ", "True"]) {
      process.env[VAR] = raw;
      expect(`${raw} → ${optionalEnvFlag(VAR)}`).toBe(`${raw} → true`);
    }
    delete process.env[VAR];
    expect(optionalEnvFlag(VAR)).toBe(false);
    process.env[VAR] = "";
    expect(optionalEnvFlag(VAR)).toBe(false);
  });

  test("explicit OFF spellings (0/false/no/off, case-insensitive, trimmed) are OFF and warn about NOTHING", async () => {
    // The warn exists to report SILENT-OFF: a value the operator meant as ON
    // that reads as OFF. `MUNINN_WIKI_READONLY=0` is not that — it is the flag
    // being turned off on purpose, and it got the same "unrecognized" warning as
    // a typo, which teaches operators to ignore the one line that matters.
    // NB the asymmetry with `on` (below) is deliberate, not an oversight: `off`
    // asks for OFF and gets OFF, while `on` asks for ON and silently gets OFF.
    const records = await capture();
    for (const raw of ["0", "false", "FALSE", " false ", "no", "NO", "off", "Off", " 0 "]) {
      process.env[VAR] = raw;
      expect(`${raw} → ${optionalEnvFlag(VAR)}`).toBe(`${raw} → false`);
    }
    expect(records.filter((r) => r.level === "warning")).toEqual([]);
  });

  test("an unrecognized non-empty value warns ONCE, naming the var and that it is OFF", async () => {
    const records = await capture();
    process.env[VAR] = "yes";
    expect(optionalEnvFlag(VAR)).toBe(false);
    // Read again — config flags are read at call time (the readonly seam reads on
    // every write), so a per-call warn would flood the log.
    expect(optionalEnvFlag(VAR)).toBe(false);

    const warns = records.filter((r) => r.level === "warning");
    expect(warns.length).toBe(1);
    const rendered = warns[0]!.message.join("");
    expect(rendered).toContain(VAR);
    expect(rendered).toContain("yes");
    expect(rendered.toLowerCase()).toContain("off");
  });

  test("a recognized value warns about nothing", async () => {
    const records = await capture();
    process.env[VAR] = "1";
    optionalEnvFlag(VAR);
    delete process.env[VAR];
    optionalEnvFlag(VAR);
    expect(records.filter((r) => r.level === "warning")).toEqual([]);
  });

  test("each unrecognized VALUE gets its own warning — a corrected typo is not silent", async () => {
    const records = await capture();
    process.env[VAR] = "on";
    optionalEnvFlag(VAR);
    process.env[VAR] = "2";
    optionalEnvFlag(VAR);
    expect(records.filter((r) => r.level === "warning").length).toBe(2);
  });
});

/**
 * `CLAUDE_USAGE_URL` is nullable-when-unset rather than defaulted-plus-a-boolean,
 * so "is this a claude-usage host?" and "what URL do we read?" are ONE fact
 * derived from ONE trimmed read. The pair it replaced could disagree: a
 * whitespace-only value made `configured` true (a non-empty string) while the URL
 * fell back to the default — a card promising an error about a service the
 * operator never actually pointed anywhere.
 */
describe("claudeUsageUrl", () => {
  const VAR = "CLAUDE_USAGE_URL";
  let prev: string | undefined;
  let prevDb: string | undefined;

  function config() {
    // loadConfig requires DATABASE_URL; this suite is about one field.
    prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL ??= "postgresql://x@127.0.0.1:5432/x";
    try {
      return loadConfig();
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL;
    }
  }

  afterEach(() => {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
    prev = undefined;
  });

  test("unset ⇒ null — the route applies the default, the config claims nothing", () => {
    prev = process.env[VAR];
    delete process.env[VAR];
    expect(config().claudeUsageUrl).toBeNull();
  });

  test("set ⇒ the trimmed value", () => {
    prev = process.env[VAR];
    process.env[VAR] = "  http://mini.local:9999/  ";
    expect(config().claudeUsageUrl).toBe("http://mini.local:9999/");
  });

  test("whitespace-only ⇒ null, NOT a configured-but-garbage URL", () => {
    prev = process.env[VAR];
    process.env[VAR] = "   ";
    expect(config().claudeUsageUrl).toBeNull();
  });
});

/**
 * The two auth env lists. Both are read by `src/auth/mode.ts`'s boot refusals
 * before `DATABASE_URL` exists, which is why they are getters rather than
 * `loadConfig()` fields.
 */
describe("adminIdentsFromEnv", () => {
  test("splits, trims, lowercases and de-duplicates", () => {
    // Lowercasing both sides is what makes `A123456` and `nav-a123456` the same
    // person to `resolveRole`; a case mismatch would resolve NOBODY to admin.
    expect(adminIdentsFromEnv({ MUNINN_ADMIN_IDENTS: " A123456 , a123456 ,B999999 " }))
      .toEqual(["a123456", "b999999"]);
  });

  test("unset, blank and separator-only all mean an empty allowlist", () => {
    expect(adminIdentsFromEnv({})).toEqual([]);
    expect(adminIdentsFromEnv({ MUNINN_ADMIN_IDENTS: "" })).toEqual([]);
    expect(adminIdentsFromEnv({ MUNINN_ADMIN_IDENTS: " , , " })).toEqual([]);
  });
});

describe("allowedOriginsFromEnv", () => {
  test("normalises through URL so spellings of one origin compare equal", () => {
    expect(allowedOriginsFromEnv({ MUNINN_ALLOWED_ORIGINS: "https://Host.example/,https://host.example" }))
      .toEqual(["https://host.example"]);
    expect(allowedOriginsFromEnv({ MUNINN_ALLOWED_ORIGINS: "http://127.0.0.1:3010/chat" }))
      .toEqual(["http://127.0.0.1:3010"]);
  });

  test("a wildcard is refused, not honoured", () => {
    // The fail-OPEN direction for a list whose only job is to fail closed.
    // Dropped here, it reaches the boot assert as "empty" and refuses loudly.
    expect(allowedOriginsFromEnv({ MUNINN_ALLOWED_ORIGINS: "*" })).toEqual([]);
    expect(allowedOriginsFromEnv({ MUNINN_ALLOWED_ORIGINS: "*,https://ok.example" }))
      .toEqual(["https://ok.example"]);
  });

  test("an unparseable entry is dropped rather than silently matching nothing", () => {
    expect(allowedOriginsFromEnv({ MUNINN_ALLOWED_ORIGINS: "not a url,https://ok.example" }))
      .toEqual(["https://ok.example"]);
  });

  test("unset means empty", () => {
    expect(allowedOriginsFromEnv({})).toEqual([]);
  });
});

/**
 * `MUNINN_PROFILE` — the serving profile, parsed fail-CLOSED.
 *
 * The direction is the whole point and it is the opposite of `optionalEnvFlag`'s
 * above: a typo there degrades to OFF (safe), a typo here would degrade to
 * `default`, i.e. serving the filesystem-bound and CLI-bound routes the `nais`
 * profile exists to drop — on the one deployment where colleagues are on the
 * other side of the door. So it throws, like `parseAuthMode`.
 */
describe("resolveServingProfile", () => {
  test("unset, blank or whitespace-only means the default profile", () => {
    expect(resolveServingProfile({})).toBe("default");
    expect(resolveServingProfile({ MUNINN_PROFILE: "" })).toBe("default");
    expect(resolveServingProfile({ MUNINN_PROFILE: "   " })).toBe("default");
  });

  test("accepts the known profiles, trimmed and case-insensitively", () => {
    for (const raw of ["nais", "NAIS", " nais ", "Nais"]) {
      expect(`${raw} → ${resolveServingProfile({ MUNINN_PROFILE: raw })}`).toBe(`${raw} → nais`);
    }
    expect(resolveServingProfile({ MUNINN_PROFILE: "default" })).toBe("default");
  });

  test("an unrecognised value THROWS rather than degrading to default", () => {
    // The near-misses an operator actually types. Each one would silently serve
    // the full surface if this parsed like a boolean flag.
    for (const raw of ["nais-prod", "prod", "nais1", "true", "1"]) {
      expect(() => resolveServingProfile({ MUNINN_PROFILE: raw })).toThrow(/not a known serving profile/);
    }
  });

  test("the refusal names the variable, the value and the known profiles", () => {
    // A boot refusal is read once, in a container log, by someone who cannot
    // attach a debugger — it has to carry the fix.
    let message = "";
    try { resolveServingProfile({ MUNINN_PROFILE: "nais-prod" }); } catch (err) { message = String(err); }
    expect(message).toContain("MUNINN_PROFILE");
    expect(message).toContain("nais-prod");
    expect(message).toContain("default, nais");
  });
});
