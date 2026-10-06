import { describe, expect, test } from "bun:test";
import {
  fellesPublishableFor,
  fellesPublishChildEnv,
  fellesPublishConfigFromEnv,
  fellesScriptArgs,
  fellesPublishPayloadField,
} from "./felles-publish.ts";

const BIN = "/abs/muninn-nais/scripts/publiser-felles-wiki.ts";

describe("fellesPublishConfigFromEnv", () => {
  test("is on with an absolute script and at least one wiki", () => {
    const c = fellesPublishConfigFromEnv({ FELLES_WIKI_PUBLISH_BIN: BIN, FELLES_WIKI_PUBLISH_WIKIS: " Melosys-Kode-Wiki , x " });
    expect(c.bin).toBe(BIN);
    expect([...c.wikis]).toEqual(["melosys-kode-wiki", "x"]);
  });

  test.each([
    ["no script", { FELLES_WIKI_PUBLISH_WIKIS: "w" }],
    ["no wikis", { FELLES_WIKI_PUBLISH_BIN: BIN }],
    ["blank wikis", { FELLES_WIKI_PUBLISH_BIN: BIN, FELLES_WIKI_PUBLISH_WIKIS: " , " }],
    ["relative script", { FELLES_WIKI_PUBLISH_BIN: "scripts/p.ts", FELLES_WIKI_PUBLISH_WIKIS: "w" }],
    ["nais profile", { FELLES_WIKI_PUBLISH_BIN: BIN, FELLES_WIKI_PUBLISH_WIKIS: "w", MUNINN_PROFILE: "nais" }],
    ["unknown profile", { FELLES_WIKI_PUBLISH_BIN: BIN, FELLES_WIKI_PUBLISH_WIKIS: "w", MUNINN_PROFILE: "bogus" }],
  ])("is off with %s", (_label, env) => {
    expect(fellesPublishConfigFromEnv(env).bin).toBeNull();
  });
});

describe("fellesPublishableFor", () => {
  const config = fellesPublishConfigFromEnv({ FELLES_WIKI_PUBLISH_BIN: BIN, FELLES_WIKI_PUBLISH_WIKIS: "melosys-kode-wiki" });

  test("matches the wiki name without case", () => {
    expect(fellesPublishableFor("melosys-kode-wiki", config)).toBe(true);
    expect(fellesPublishableFor("Melosys-Kode-Wiki", config)).toBe(true);
  });

  test("refuses another wiki, no name, and an off config", () => {
    expect(fellesPublishableFor("mimir", config)).toBe(false);
    expect(fellesPublishableFor(undefined, config)).toBe(false);
    expect(fellesPublishableFor("melosys-kode-wiki", { bin: null, wikis: config.wikis, bucket: null })).toBe(false);
  });

  test("the payload field carries the script path only where the control is offered", () => {
    expect(fellesPublishPayloadField("melosys-kode-wiki", "/w", config)).toEqual({ fellesPublish: { bin: BIN } });
    expect(fellesPublishPayloadField("mimir", "/w", config)).toEqual({});
  });

  test("the payload carries the bucket override the route's child will see", () => {
    const withBucket = fellesPublishConfigFromEnv({
      FELLES_WIKI_PUBLISH_BIN: BIN,
      FELLES_WIKI_PUBLISH_WIKIS: "melosys-kode-wiki",
      FELLES_WIKI_BUCKET: " my-bucket ",
    });
    expect(fellesPublishPayloadField("melosys-kode-wiki", "/w", withBucket)).toEqual({
      fellesPublish: { bin: BIN, bucket: "my-bucket" },
    });
  });

  test("a read-only root offers no control", () => {
    expect(fellesPublishPayloadField("melosys-kode-wiki", "/w", config, () => true)).toEqual({});
  });
});

test("publish args come in the order the operator types them", () => {
  const page = { root: "/w", relPath: "plans/a.mdx" };
  expect(fellesScriptArgs({ action: "publish", dryRun: true, allowIdent: true, ...page })).toEqual([
    "--dry-run",
    "--tillat-ident",
    "/w",
    "./plans/a.mdx",
  ]);
  expect(fellesScriptArgs({ action: "publish", dryRun: false, allowIdent: false, ...page })).toEqual([
    "/w",
    "./plans/a.mdx",
  ]);
});

test("remove names the bare object after --, and never passes the root or --tillat-ident", () => {
  // The relPath is the bucket object name here, so a ./ prefix would name a
  // different object; `--` keeps a dash-led page from reading as a flag.
  const page = { root: "/w", relPath: "-x.md" };
  expect(fellesScriptArgs({ action: "remove", dryRun: true, allowIdent: true, ...page })).toEqual([
    "--fjern",
    "--dry-run",
    "--ja",
    "--",
    "-x.md",
  ]);
  expect(fellesScriptArgs({ action: "remove", dryRun: false, allowIdent: false, ...page })).toEqual([
    "--fjern",
    "--ja",
    "--",
    "-x.md",
  ]);
});

test("remove names the object in NFC, the spelling publish uploaded", () => {
  // The script uploads `rel.normalize("NFC")` but deletes the name it is given,
  // and readdir on APFS hands back an NFD spelling as written.
  const nfd = "plans/pa\u030A.md";
  const [object] = fellesScriptArgs({ action: "remove", dryRun: true, allowIdent: false, root: "/w", relPath: nfd }).slice(-1);
  expect(object).toBe("plans/p\u00E5.md");
});

test("the child environment is an allowlist", () => {
  const env = fellesPublishChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    CLOUDSDK_CONFIG: "/home/x/.gcloud",
    FELLES_WIKI_BUCKET: "b",
    DATABASE_URL: "postgres://secret",
    TELEGRAM_BOT_TOKEN_JARVIS: "t",
    TMPDIR: "",
  });
  expect(env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/x",
    CLOUDSDK_CONFIG: "/home/x/.gcloud",
    FELLES_WIKI_BUCKET: "b",
  });
});
