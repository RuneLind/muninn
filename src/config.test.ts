import { test, expect, describe, afterEach } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { loadConfig, optionalEnvFlag, __resetEnvFlagWarningsForTest, adminIdentsFromEnv, allowedOriginsFromEnv, resolveServingProfile, resolveWikiAnswerRetention, ConfigError, parseAnswerGroups, answerGroupsBootLines, resolveWikiAnswerConfig } from "./config.ts";

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

/**
 * Retention windows are DAY COUNTS the sweeper subtracts from `NOW()`, so a
 * non-positive one is not a shorter window — it is a wipe. `= 0` makes the
 * scheduler's next tick run `created_at < NOW() - 0 days` over every row in
 * `prompt_snapshots`, and a negative value deletes rows from the future too.
 *
 * They therefore clamp instead of parsing straight through: a value that PARSES
 * and is below 1 is refused, warned about once and replaced by the default.
 * Refusing rather than throwing for that band, because the degrade direction
 * there is the safe one — a typo that keeps prompts three days too long costs
 * disk, and one that empties the archive is unrecoverable.
 *
 * A value that does not parse as an integer at all is the OTHER band and still
 * throws out of `optionalEnvInt`, refusing the boot. Both are pinned below,
 * because the docblocks describe two answers and a reader who tried `=ninety`
 * expecting a warning would find the process gone.
 */
describe("prompt-snapshot retention clamps", () => {
  const CHAT = "PROMPT_SNAPSHOTS_RETENTION_DAYS";
  const CAPTURE = "PROMPT_SNAPSHOTS_CAPTURE_RETENTION_DAYS";
  const saved: Record<string, string | undefined> = {};

  function config() {
    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL ??= "postgresql://x@127.0.0.1:5432/x";
    try {
      return loadConfig();
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL;
    }
  }

  async function capture(): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    return records;
  }

  function set(name: string, value: string | undefined) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      delete saved[name];
    }
    __resetEnvFlagWarningsForTest();
    await reset();
  });

  test("unset ⇒ the shipped windows", () => {
    set(CHAT, undefined);
    set(CAPTURE, undefined);
    const c = config();
    expect([c.promptSnapshotsRetentionDays, c.promptSnapshotsCaptureRetentionDays]).toEqual([3, 90]);
  });

  test("a positive value is honoured on both windows", () => {
    set(CHAT, "1");
    set(CAPTURE, "14");
    const c = config();
    expect([c.promptSnapshotsRetentionDays, c.promptSnapshotsCaptureRetentionDays]).toEqual([1, 14]);
  });

  test("0 falls back to the default rather than wiping the archive", () => {
    set(CHAT, "0");
    set(CAPTURE, "0");
    const c = config();
    expect([c.promptSnapshotsRetentionDays, c.promptSnapshotsCaptureRetentionDays]).toEqual([3, 90]);
  });

  test("a negative value falls back too", () => {
    set(CHAT, "-1");
    set(CAPTURE, "-7");
    const c = config();
    expect([c.promptSnapshotsRetentionDays, c.promptSnapshotsCaptureRetentionDays]).toEqual([3, 90]);
  });

  test("a NON-INTEGER refuses the boot instead of warning — the other band", () => {
    // `positiveEnvInt` delegates to `optionalEnvInt`, which throws on a value
    // that names no number at all. The clamp above never sees it.
    set(CAPTURE, "ninety");
    expect(() => config()).toThrow(/PROMPT_SNAPSHOTS_CAPTURE_RETENTION_DAYS/);
  });

  test("the refusal is warned about, naming the variable and the value", async () => {
    const records = await capture();
    set(CAPTURE, "0");
    config();
    const warning = records.find((r) => r.level === "warning" && String(r.message.join("")).includes(CAPTURE));
    expect(warning).toBeDefined();
    expect(String(warning!.message.join("") + JSON.stringify(warning!.properties))).toContain("0");
  });
});

/** Answer retention (D17): unset ⇒ off, 0 ⇒ OFF and carried as refused (the
 *  boot line warns about it once logging is up — never 0, which would delete
 *  every answer), anything but digits refuses the boot. */
describe("resolveWikiAnswerRetention", () => {
  const E = "WIKI_ANSWER_RETENTION_DAYS";
  const U = "WIKI_ANSWER_UNEXPORTED_DAYS";

  test("unset or blank ⇒ both rules off", () => {
    expect(resolveWikiAnswerRetention({})).toEqual({ exportedDays: null, unexportedDays: null, refused: [] });
    expect(resolveWikiAnswerRetention({ [E]: " ", [U]: "" })).toEqual({ exportedDays: null, unexportedDays: null, refused: [] });
  });

  test("positive integers are honoured, each on its own, surrounding space trimmed", () => {
    expect(resolveWikiAnswerRetention({ [E]: "30", [U]: " 90 " })).toEqual({ exportedDays: 30, unexportedDays: 90, refused: [] });
    expect(resolveWikiAnswerRetention({ [U]: "90" })).toEqual({ exportedDays: null, unexportedDays: 90, refused: [] });
  });

  test("0 turns the rule OFF and is carried as refused, for the boot line to warn about", () => {
    expect(resolveWikiAnswerRetention({ [E]: "0", [U]: "00" })).toEqual({
      exportedDays: null,
      unexportedDays: null,
      refused: [
        { name: E, value: "0" },
        { name: U, value: "00" },
      ],
    });
  });

  test("anything but digits refuses the boot, naming the variable: no lenient parse of a deletion window", () => {
    for (const raw of ["thirty", "1e3", "1.9", "30d", "0.5", "-5", "+30", "3 0", "0x10"]) {
      expect(() => resolveWikiAnswerRetention({ [E]: raw })).toThrow(ConfigError);
      expect(() => resolveWikiAnswerRetention({ [U]: raw })).toThrow(/WIKI_ANSWER_UNEXPORTED_DAYS/);
    }
  });
});

describe("WIKI_ANSWER_GROUPS", () => {
  const plain = (g: ReturnType<typeof parseAnswerGroups>["groups"]) =>
    Object.fromEntries([...g].map(([k, v]) => [k, [...v].sort()]));

  test("unset or blank ⇒ no groups, no warnings", () => {
    expect(plain(parseAnswerGroups(undefined).groups)).toEqual({});
    expect(parseAnswerGroups(" ; ;").warnings).toEqual([]);
    expect(answerGroupsBootLines(resolveWikiAnswerConfig({}))).toEqual({ info: null, warnings: [] });
  });

  test("names lower-cased, idents trimmed and upper-cased, empty idents ignored, one ident in two groups", () => {
    const { groups, warnings } = parseAnswerGroups(" Fag = z990001 , Z990002,, ; utvikler=Z990002;;Ø_test-1=Z990003 ");
    expect(plain(groups)).toEqual({ fag: ["Z990001", "Z990002"], utvikler: ["Z990002"], "ø_test-1": ["Z990003"] });
    expect(warnings).toEqual([]);
  });

  test("duplicates: an ident twice is one member; a group twice merges, with a warning naming the group", () => {
    const { groups, warnings } = parseAnswerGroups("fag=Z990001,z990001;FAG=Z990002");
    expect(plain(groups)).toEqual({ fag: ["Z990001", "Z990002"] });
    expect(warnings).toEqual(['WIKI_ANSWER_GROUPS entry 2: group "fag" is defined again — its members are merged']);
  });

  test("a malformed entry is dropped with its position and why, and never echoes an ident", () => {
    const raw = "Z990011,Z990012;b@d=Z990013;tom=;fag=Z990014,not an-ident;ok=Z990015";
    const { groups, warnings } = parseAnswerGroups(raw);
    expect(plain(groups)).toEqual({ ok: ["Z990015"] });
    expect(warnings).toEqual([
      'WIKI_ANSWER_GROUPS entry 1 dropped: no "=" between the group name and its members',
      'WIKI_ANSWER_GROUPS entry 2 dropped: the group name must be letters, digits, "_" or "-"',
      'WIKI_ANSWER_GROUPS entry 3 dropped: group "tom" names no members',
      'WIKI_ANSWER_GROUPS entry 4 dropped: a member of group "fag" is not a NAV ident (letters and digits only)',
    ]);
    for (const w of warnings) expect(w).not.toMatch(/Z9900\d\d|not an-ident/i);
  });

  test("the boot line names groups and member counts, never an ident; warnings ride along", () => {
    const cfg = resolveWikiAnswerConfig({ WIKI_ANSWER_GROUPS: "fag=Z990001,Z990002;utvikler=Z990003;x" });
    const lines = answerGroupsBootLines(cfg);
    expect(lines.info).toBe("Answer groups: fag (2 members), utvikler (1 member)");
    expect(lines.warnings).toEqual(['WIKI_ANSWER_GROUPS entry 3 dropped: no "=" between the group name and its members']);
    expect(JSON.stringify(lines)).not.toMatch(/Z9900/);
  });

  const DIGIT_RUN = "the group name contains six or more digits in a row, which could be a NAV ident";

  test("a group name shaped like a NAV ident is refused by position, never echoed", () => {
    const { groups, warnings } = parseAnswerGroups("Z990001=Z990002;fag=Z990003");
    expect(plain(groups)).toEqual({ fag: ["Z990003"] });
    expect(warnings).toEqual([`WIKI_ANSWER_GROUPS entry 1 dropped: ${DIGIT_RUN}`]);
    for (const w of warnings) expect(w).not.toMatch(/z990001/i);
    // Five digits in a row at most: kept, whatever surrounds them.
    expect(plain(parseAnswerGroups("z99=Z990004;team7=Z990005;z99001=Z990006;uke2025-41=Z990007;a1b2c3d4e5f6g7=Z990008;team-2=Z990009").groups)).toEqual({
      z99: ["Z990004"],
      team7: ["Z990005"],
      z99001: ["Z990006"],
      "uke2025-41": ["Z990007"],
      a1b2c3d4e5f6g7: ["Z990008"],
      "team-2": ["Z990009"],
    });
  });

  test("a group name with six or more digits in a row is refused, wherever they sit and whatever precedes them", () => {
    // `a123456` pins the first letter of the alphabet, `z9900011` a garbled
    // ident with a seventh digit, `123456`/`fag-123456` a run with no letter
    // before it, `uke202541` a week code (written `uke2025-41` instead).
    const names = ["fag-z990001", "z990001_", "z990001x", "team_z990001", "fagz990001", "zz990001", "ab123456", "a123456", "z9900011", "123456", "fag-123456", "uke202541"];
    const { groups, warnings } = parseAnswerGroups(names.map((n) => `${n}=Z990002`).join(";"));
    expect(plain(groups)).toEqual({});
    expect(warnings).toEqual(names.map((_, i) => `WIKI_ANSWER_GROUPS entry ${i + 1} dropped: ${DIGIT_RUN}`));
    expect(JSON.stringify(answerGroupsBootLines(resolveWikiAnswerConfig({ WIKI_ANSWER_GROUPS: "fag-z990001=Z990002" })))).not.toMatch(/990001/);
  });

  test("positions count the raw ;-segments, blank ones included", () => {
    expect(parseAnswerGroups("fag=Z990001;;;x").warnings).toEqual([
      'WIKI_ANSWER_GROUPS entry 4 dropped: no "=" between the group name and its members',
    ]);
  });

  test("an owner whose bare name is a group name is warned about at boot", () => {
    const cfg = resolveWikiAnswerConfig({ WIKI_ANSWER_GROUPS: "fag=Z990001", WIKI_ANSWER_OWNER: " FAG " });
    expect(answerGroupsBootLines(cfg).warnings).toEqual([
      'WIKI_ANSWER_OWNER is the name of answer group "fag": a question naming nobody asks that group, and the owner\'s own answers under MUNINN_AUTH=off read as not asked — give the owner as "Name (IDENT)" or rename the group',
    ]);
    // With an ident the owner is a person, and a different name is no clash.
    for (const owner of ["fag (Z990009)", "Synne Testdal", "fagansvarlig"]) {
      expect(answerGroupsBootLines(resolveWikiAnswerConfig({ WIKI_ANSWER_GROUPS: "fag=Z990001", WIKI_ANSWER_OWNER: owner })).warnings).toEqual([]);
    }
    // No groups: nothing to clash with.
    expect(answerGroupsBootLines(resolveWikiAnswerConfig({ WIKI_ANSWER_OWNER: "fag" })).warnings).toEqual([]);
  });
});
