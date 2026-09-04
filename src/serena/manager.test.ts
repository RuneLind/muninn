import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serenaManager } from "./manager.ts";

/**
 * `init()` scans the roster this process DISCOVERED, not a second hardcoded copy
 * of `../../bots`.
 *
 * The two diverge the moment `MUNINN_BOTS_DIR` is set — a spawned e2e server, a
 * deployment whose bots live outside the checkout — and the failure is silent:
 * the manager reports zero instances and the `/serena` page is empty, for bots
 * whose `config.json` declares Serena perfectly well.
 */

const created: string[] = [];

afterEach(() => {
  delete process.env.MUNINN_BOTS_DIR;
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

test("init() discovers Serena instances under MUNINN_BOTS_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "muninn-serena-bots-"));
  created.push(root);
  const dir = join(root, "zzserenabot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "persona");
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      serena: [{ name: "zzserenaproj", projectPath: "/tmp/zz-serena-project", port: 19999 }],
    }),
  );

  process.env.MUNINN_BOTS_DIR = root;
  serenaManager.init();

  const inst = serenaManager.getInstance("zzserenaproj");
  expect(inst).toBeDefined();
  expect(inst!.botName).toBe("zzserenabot");
  // Nothing was started — `init()` only populates the map.
  expect(inst!.status).toBe("stopped");
});
