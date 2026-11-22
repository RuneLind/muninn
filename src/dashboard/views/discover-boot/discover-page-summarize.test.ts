/**
 * Summarize on the Discover page (architecture review 2026-11-16, F17), driven
 * through the real `bootDiscoverPage` in happy-dom with `fetch` stubbed: a
 * capture job that fails puts the video back (only while it is still `queued`)
 * and re-enables Summarize; a job that succeeds leaves it queued; Undo of a dismissal
 * after a failed job brings the video back actionable, not stuck queued. The page follows
 * jobs through one poll of `GET /api/youtube/jobs`, never a stream per click.
 * Invented ids only (public repo).
 *
 * Isolation (load-bearing, pinned by `src/test/mock-isolation.test.ts`): this
 * file installs happy-dom's globals over Bun's own for the life of the process,
 * so it runs in a `bun test` link of its own in every chain.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { DiscoverShelf } from "../../../db/youtube-discover.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();

function installWindow(w: GlobalWindow): void {
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(w))) {
    if (IGNORE.has(key)) continue;
    const cur = Object.getOwnPropertyDescriptor(globalThis, key);
    if (cur && "value" in desc && cur.value === desc.value) continue;
    saved.set(key, cur);
    const next = "value" in desc && desc.value === w ? { ...desc, value: globalThis } : desc;
    Object.defineProperty(globalThis, key, { ...next, configurable: true });
  }
}

function restoreGlobals(): void {
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
}

const V1 = "vidAAAAAAA1";
const V2 = "vidBBBBBBB2";
const V3 = "vidCCCCCCC3";
const V4 = "vidDDDDDDD4";
const hit = (videoId: string, rank: number) => ({
  videoId,
  title: `Video ${videoId}`,
  channel: "Invented",
  durationSec: 600,
  viewCount: 10,
  score: 0.8,
  why: "fits",
  query: "agent evals",
  rank,
  state: "new" as const,
  details: null,
});
const SHELF: DiscoverShelf = {
  runId: "00000000-0000-4000-8000-000000000001",
  seedSource: "youtube",
  seedDocId: "ai/Invented seed.md",
  seedTitle: "Invented seed",
  seedVideoId: null,
  seedCategory: "ai",
  seedDate: "2026-11-20",
  queries: [{ query: "agent evals", why: "same" }],
  searched: 5,
  known: 0,
  origin: "watcher",
  failed: 0,
  createdAt: Date.parse("2026-11-20T12:00:00Z"),
  hits: [hit(V1, 1), hit(V2, 2), hit(V3, 3), hit(V4, 4)],
};

/** The server's side: each video's state, each job's status, and every URL asked. */
const serverState = new Map<string, string>([V1, V2, V3, V4].map((v) => [v, "new"]));
const jobs = new Map<string, { status: string; error?: string }>();
const fetched: string[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: unknown, init?: { method?: string; body?: unknown }): Promise<Response> {
  const url = String(input);
  fetched.push(url);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
  if (url === "/api/youtube/summarize") {
    const id = `job-${body.video_id}`;
    jobs.set(id, { status: "summarizing" });
    return json(200, { job_id: id });
  }
  if (url === "/api/summaries/discover/state") {
    if (body.ifState && serverState.get(body.videoId!) !== body.ifState) return json(409, { error: "changed", code: "state_changed" });
    serverState.set(body.videoId!, body.state!);
    return json(200, { videoId: body.videoId, state: body.state });
  }
  if (url.startsWith("/api/youtube/jobs")) return json(200, { jobs: [...jobs].map(([id, j]) => ({ id, ...j })) });
  return json(404, { error: "not stubbed" });
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const card = (v: string) => document.querySelector<HTMLElement>(`.dsc-card[data-video="${v}"]`);
const sumBtn = (v: string) => card(v)?.querySelector<HTMLButtonElement>('[data-act="sum"]') ?? null;
const toastText = () => document.getElementById("dscToast")?.textContent ?? "";

beforeAll(async () => {
  installWindow(new GlobalWindow({ url: "http://localhost:3011/summaries/discover" }));
  g.fetch = stubFetch;
  document.body.innerHTML =
    `<span id="dscCount"></span><main id="dscMain"></main>` +
    `<div id="dscDrawerBg" hidden></div><aside id="dscDrawer" hidden></aside>` +
    `<div id="dscToast"></div><div id="dscAnnounce"></div>` +
    `<script type="application/json" id="dscData">${JSON.stringify({ shelves: [SHELF], hidden: 0 })}</script>`;
  const client = await import("../components/discover-page-client.ts");
  client.__setDiscoverJobPollMsForTest(5);
  client.bootDiscoverPage();
});

afterAll(() => restoreGlobals());

describe("Summarize follows the capture job (F17)", () => {
  test("a failed job puts the video back to new, re-enables Summarize and shows the job's error", async () => {
    sumBtn(V1)!.click();
    await until(() => sumBtn(V1)?.textContent === "✓ Queued", "queued");
    expect(serverState.get(V1)).toBe("queued");
    jobs.set(`job-${V1}`, { status: "error", error: "Transcript unavailable" });
    await until(() => sumBtn(V1)?.textContent === "Summarize", "back to Summarize");
    expect(sumBtn(V1)!.getAttribute("aria-disabled")).toBeNull();
    expect(serverState.get(V1)).toBe("new");
    expect(toastText()).toContain("The summary failed: Transcript unavailable. You can try again.");
  });

  test("dismissed while the job ran, then the job fails: it stays dismissed", async () => {
    sumBtn(V2)!.click();
    await until(() => sumBtn(V2)?.textContent === "✓ Queued", "queued");
    card(V2)!.querySelector<HTMLButtonElement>('[data-act="dismiss"]')!.click();
    await until(() => card(V2) === null, "dismissed");
    expect(serverState.get(V2)).toBe("dismissed");
    jobs.set(`job-${V2}`, { status: "error", error: "Transcript unavailable" });
    await until(() => toastText().includes("The summary failed"), "failure toast");
    expect(serverState.get(V2)).toBe("dismissed");
    expect(card(V2)).toBeNull();
    expect(toastText()).not.toContain("still marked queued");
  });

  test("dismissed while the job ran, the job fails, then Undo: back to new with Summarize, never a stuck queued", async () => {
    sumBtn(V4)!.click();
    await until(() => sumBtn(V4)?.textContent === "✓ Queued", "queued");
    card(V4)!.querySelector<HTMLButtonElement>('[data-act="dismiss"]')!.click();
    await until(() => card(V4) === null, "dismissed");
    jobs.set(`job-${V4}`, { status: "error", error: "Transcript unavailable" });
    await until(() => toastText().includes("The summary failed: Transcript unavailable."), "failure toast");
    expect(serverState.get(V4)).toBe("dismissed");
    document.querySelector<HTMLButtonElement>("#dscToast [data-undo]")!.click();
    await until(() => card(V4) !== null, "restored card");
    expect(serverState.get(V4)).toBe("new");
    expect(sumBtn(V4)!.textContent).toBe("Summarize");
    expect(sumBtn(V4)!.getAttribute("aria-disabled")).toBeNull();
  });

  test("a job that succeeds leaves the video queued", async () => {
    sumBtn(V3)!.click();
    await until(() => sumBtn(V3)?.textContent === "✓ Queued", "queued");
    jobs.set(`job-${V3}`, { status: "complete" });
    const polls = fetched.filter((u) => u.startsWith("/api/youtube/jobs")).length;
    await until(() => fetched.filter((u) => u.startsWith("/api/youtube/jobs")).length > polls, "a poll after completion");
    expect(serverState.get(V3)).toBe("queued");
    expect(sumBtn(V3)!.textContent).toBe("✓ Queued");
    // Nothing followed any more: the page stops polling.
    const settledPolls = fetched.filter((u) => u.startsWith("/api/youtube/jobs")).length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fetched.filter((u) => u.startsWith("/api/youtube/jobs")).length).toBe(settledPolls);
    // Never a stream per click.
    expect(fetched.some((u) => u.includes("/api/youtube/stream/"))).toBe(false);
  });
});
