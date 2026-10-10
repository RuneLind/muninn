/**
 * See a wiki the way one answer group sees it on the pod, on this machine.
 *
 *   bun run preview:role <role> --wiki <name>=<root> [--port 3013] [--lens overview|all]
 *
 * Boots a second muninn shaped like the nais pod for a colleague in `<role>`:
 * `MUNINN_PROFILE=nais`, `MUNINN_AUTH=local` at role `user`, and a pinned
 * identity whose `MUNINN_LOCAL_IDENT` is in that group. The reader then orders
 * and marks the lanes for that role, opens in the instance's default lens, and
 * shows only the surface role `user` gets. «Se som rolle» on the pod replays
 * the lanes for an admin; this shows the rest of the page as the role sees it.
 *
 * What makes it safe to run beside `bun run dev`:
 *  - the groups are synthetic (`X9000NN`, one per `roleKeys` entry in
 *    `<root>/.wiki-reader.json`), so no real ident enters an env or a page;
 *  - `MUNINN_BOTS_DIR` is a fresh temp dir with one token-less bot, and
 *    `e2eEnv()` blanks every platform token, so no bot polls Telegram or Slack;
 *  - the wiki root is read-only (`WIKI_READONLY_ROOTS`);
 *  - `DATABASE_URL` is the `_test` database (`TEST_DATABASE_URL`), never the
 *    one `bun run dev` uses. A choice clicked on a card is stored there, under
 *    the synthetic ident, until the next test run wipes it; an answer with a
 *    body is refused with 503 `scanner_unavailable`, because the nais profile
 *    needs `WIKI_ANSWER_SCANNER` and this leaves it blank. Run
 *    `bun run db:setup:test` once if that database does not exist.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "../e2e/e2e-env.ts";
import { parseRoleKeys } from "../src/format/lane-roles.ts";
import { TEST_DATABASE_URL } from "../src/test/test-db-url.ts";

export const PREVIEW_DEFAULT_PORT = 3013;

/** The synthetic ident for the n-th role key (0-based): `X900001`, `X900002` … */
const syntheticIdent = (n: number) => `X9${String(n + 1).padStart(5, "0")}`;
/** On the admin allowlist an authenticating mode requires, and in no group. */
const PREVIEW_ADMIN_IDENT = "X999999";

export interface PreviewRoleOptions {
  role: string;
  wiki: string;
  /** Absolute wiki root. */
  root: string;
  roleKeys: readonly string[];
  port: number;
  botsDir: string;
  lens?: "overview" | "all";
}

/** The env overrides for one preview muninn. Spread after `...process.env`
 *  and `...e2eEnv()`. Throws when `role` is not one of `roleKeys`. */
export function previewRoleEnv(o: PreviewRoleOptions): Record<string, string> {
  const at = o.roleKeys.indexOf(o.role);
  if (at < 0) {
    throw new Error(
      o.roleKeys.length
        ? `"${o.role}" is not a role key of ${o.wiki}; its roleKeys are ${o.roleKeys.join(", ")}`
        : `${o.wiki} has no roleKeys in .wiki-reader.json, so there is no role to preview`,
    );
  }
  const base = `http://127.0.0.1:${o.port}`;
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    DASHBOARD_PORT: String(o.port),
    DASHBOARD_HOST: "127.0.0.1",
    SCHEDULER_ENABLED: "false",
    MUNINN_BOTS_DIR: o.botsDir,
    MUNINN_PROFILE: "nais",
    MUNINN_AUTH: "local",
    MUNINN_LOCAL_TOKEN: crypto.randomUUID().replaceAll("-", ""),
    MUNINN_LOCAL_USER: `preview-${o.role}`,
    MUNINN_LOCAL_NAME: `Preview (${o.role})`,
    MUNINN_LOCAL_ROLE: "user",
    MUNINN_LOCAL_IDENT: syntheticIdent(at),
    MUNINN_ADMIN_IDENTS: PREVIEW_ADMIN_IDENT,
    MUNINN_ALLOWED_ORIGINS: `${base},http://localhost:${o.port}`,
    WIKI_EXTRA: `${o.wiki}=${o.root}`,
    WIKI_READONLY_ROOTS: o.root,
    WIKI_DEFAULT_LENS: `${o.wiki}=${o.lens ?? "overview"}`,
    WIKI_ANSWER_WIKIS: o.wiki,
    WIKI_ANSWER_GROUPS: o.roleKeys.map((k, i) => `${k}=${syntheticIdent(i)}`).join(";"),
  };
}

/** The `roleKeys` of the wiki at `root`, as the reader parses them. */
export function readRoleKeys(root: string): string[] {
  const file = path.join(root, ".wiki-reader.json");
  if (!existsSync(file)) return [];
  return parseRoleKeys((JSON.parse(readFileSync(file, "utf8")) as { roleKeys?: unknown }).roleKeys).keys;
}

/** A bots dir with one bot and no platform token: discovery finds a bot and
 *  nothing polls. */
export function makePreviewBotsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "muninn-preview-role-bots-"));
  mkdirSync(path.join(dir, "preview"));
  writeFileSync(path.join(dir, "preview", "CLAUDE.md"), "# throwaway preview bot, no wiki, no token\n", "utf8");
  return dir;
}

function usage(message?: string): never {
  if (message) console.error(`preview-role: ${message}`);
  console.error("usage: bun run preview:role <role> --wiki <name>=<root> [--port 3013] [--lens overview|all]");
  process.exit(2);
}

function main(argv: string[]): void {
  let role = "";
  let wikiArg = "";
  let port = PREVIEW_DEFAULT_PORT;
  let lens: "overview" | "all" = "overview";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--wiki") wikiArg = argv[++i] ?? "";
    else if (a === "--port") port = Number(argv[++i]);
    else if (a === "--lens") {
      const v = argv[++i];
      if (v !== "overview" && v !== "all") usage(`--lens takes overview or all, not ${v}`);
      lens = v;
    } else if (a.startsWith("-")) usage(`unknown flag ${a}`);
    else if (!role) role = a.toLowerCase();
    else usage(`unexpected argument ${a}`);
  }
  const eq = wikiArg.indexOf("=");
  if (!role || eq <= 0) usage();
  if (!Number.isInteger(port) || port < 1024 || port > 65535) usage("--port takes a port number from 1024");
  const wiki = wikiArg.slice(0, eq);
  const root = path.resolve(wikiArg.slice(eq + 1).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!existsSync(root)) usage(`no wiki root at ${root}`);

  const botsDir = makePreviewBotsDir();
  let env: Record<string, string>;
  try {
    env = previewRoleEnv({ role, wiki, root, roleKeys: readRoleKeys(root), port, botsDir, lens });
  } catch (e) {
    rmSync(botsDir, { recursive: true, force: true });
    usage((e as Error).message);
  }
  const repoRoot = path.resolve(import.meta.dir, "..");
  const url = `http://127.0.0.1:${port}/wiki?wiki=${encodeURIComponent(wiki)}`;
  console.log(
    [
      `Preview as ${role}: ${url}`,
      `  pod surface (MUNINN_PROFILE=nais), role user, ${role} = ${env.MUNINN_LOCAL_IDENT} (synthetic), default lens ${lens}`,
      `  ${root} is read-only; answers go to the _test database, and one with text is refused (no scanner).`,
      `  Ctrl-C stops it.`,
    ].join("\n"),
  );
  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...e2eEnv(), ...env },
    stdio: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => {
    rmSync(botsDir, { recursive: true, force: true });
    process.exit(code ?? 0);
  });
}

if (import.meta.main) main(process.argv.slice(2));
