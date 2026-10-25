import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { safeResolveRedirect } from "./safe-fetch.ts";
import { TEXT_LINKS_MAX, substituteUrls } from "./text-links.ts";
import { prepareTextLinks, type TextLinksDeps } from "./text-links-run.ts";

/**
 * `prepareTextLinks` against a fake shortener on a free loopback port, through
 * the real `safeResolveRedirect` (its DNS and fetch seams, as in
 * `safe-resolve-redirect.test.ts`). Every hostname and path is invented.
 */

let server: ReturnType<typeof Bun.serve>;
let port = 0;
/** Requests the fake answered, as `host/path`. */
let hits: string[] = [];

const PUBLIC_ADDR = "93.184.216.34";
const SHORT_HOSTS = ["t.co", "lnkd.in", "bit.ly", "pub.test"];

/** Where each `host/path` redirects to; anything else is a 404. */
const REDIRECTS: Record<string, string> = {
  // A target that carries another t.co URL in its query.
  "t.co/nest": "https://pub.test/p?u=https://t.co/inner",
  "t.co/inner": "https://pub.test/inner-target",
  // t.co → a known shortener → one more hop.
  "t.co/viaLnkd": "https://lnkd.in/abc",
  "lnkd.in/abc": "https://pub.test/final",
  // A shortener whose target is another shortener: never a third hop.
  "t.co/chain": "https://lnkd.in/chain",
  "lnkd.in/chain": "https://bit.ly/chain2",
  "bit.ly/chain2": "https://pub.test/too-far",
  // A bare shortener URL in the text.
  "bit.ly/bare": "https://pub.test/bare-target",
  // A non-shortener target that redirects again: not followed.
  "t.co/plain": "https://pub.test/moves",
  "pub.test/moves": "https://pub.test/elsewhere",
};

function deps(): TextLinksDeps {
  const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    headers.set("x-orig", `${u.hostname}${u.pathname}`);
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers });
  }) as unknown as typeof fetch;
  const lookup = async (hostname: string): Promise<string[]> => (SHORT_HOSTS.includes(hostname) ? [PUBLIC_ADDR] : []);
  return {
    resolveRedirect: (url, signal) => safeResolveRedirect(url, { signal, lookup, fetchImpl, caller: "test" }),
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const key = req.headers.get("x-orig") ?? "";
      hits.push(key);
      const many = /^t\.co\/many(\d+)$/.exec(key);
      if (many) return new Response(null, { status: 301, headers: { location: `https://pub.test/m${many[1]}` } });
      const to = REDIRECTS[key];
      return to ? new Response(null, { status: 301, headers: { location: to } }) : new Response("no", { status: 404 });
    },
  });
  port = server.port!;
});

afterAll(() => {
  server.stop(true);
});

describe("t.co resolution", () => {
  test(`resolves at most ${TEXT_LINKS_MAX} distinct t.co URLs, in order of first appearance`, async () => {
    hits = [];
    const text = Array.from({ length: 60 }, (_, i) => `https://t.co/many${i}`).join("\n");
    const prepared = await prepareTextLinks(text, deps());
    expect(hits).toHaveLength(TEXT_LINKS_MAX);
    expect(new Set(hits)).toEqual(new Set(Array.from({ length: TEXT_LINKS_MAX }, (_, i) => `t.co/many${i}`)));
    expect(prepared.tcoFound).toBe(60);
    expect(prepared.tcoResolved).toBe(TEXT_LINKS_MAX);
    // The rest stay unexpanded in the text.
    expect(prepared.text).toContain("https://t.co/many59");
  });

  test("a resolved target carrying another t.co URL is never rewritten again", async () => {
    const prepared = await prepareTextLinks("A https://t.co/nest B https://t.co/inner", deps());
    expect(prepared.text).toBe("A https://pub.test/p?u=https://t.co/inner B https://pub.test/inner-target");
  });

  test("substitution is one pass over the original text", () => {
    const out = substituteUrls(
      "x https://t.co/a y https://t.co/b",
      new Map([
        ["https://t.co/a", "https://e.test/p?u=https://t.co/b"],
        ["https://t.co/b", "https://e.test/b"],
      ]),
    );
    expect(out).toBe("x https://e.test/p?u=https://t.co/b y https://e.test/b");
  });

  test("a known shortener gets ONE more hop, after t.co or bare in the text; other hosts none", async () => {
    hits = [];
    const prepared = await prepareTextLinks(
      "One https://t.co/viaLnkd two https://t.co/chain three https://bit.ly/bare four https://t.co/plain",
      deps(),
    );
    expect(prepared.text).toBe(
      "One https://pub.test/final two https://bit.ly/chain2 three https://pub.test/bare-target four https://pub.test/moves",
    );
    expect(hits).not.toContain("bit.ly/chain2");
    expect(hits).not.toContain("pub.test/moves");
  });

  test("the shortener hop counts against the same resolution cap", async () => {
    hits = [];
    // 39 first hops (two of them land on lnkd.in), so ONE second hop is left:
    // the first in text order.
    const text = [
      "https://t.co/viaLnkd",
      "https://t.co/chain",
      ...Array.from({ length: TEXT_LINKS_MAX - 3 }, (_, i) => `https://t.co/many${i}`),
    ].join("\n");
    await prepareTextLinks(text, deps());
    expect(hits).toContain("lnkd.in/abc");
    expect(hits).not.toContain("lnkd.in/chain");
    expect(hits).toHaveLength(TEXT_LINKS_MAX);
  });
});

/** A resolver over a fixed answer table, recording every call; a `/hang` URL never answers. */
function tableResolver(answers: Record<string, string>, calls: string[], delays: Record<string, number> = {}) {
  return (url: string, signal: AbortSignal): Promise<string | null> => {
    calls.push(url);
    if (url.endsWith("/hang")) return new Promise(() => {});
    const answer = answers[url] ?? null;
    const ms = delays[url] ?? 0;
    if (ms === 0) return Promise.resolve(answer);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(answer), ms);
      signal.addEventListener("abort", () => clearTimeout(t), { once: true });
    });
  };
}

describe("second hops chained per link (fix round 2 batch 2, G2)", () => {
  test("one hanging t.co does not starve another link's second hop", async () => {
    const calls: string[] = [];
    const prepared = await prepareTextLinks("A https://t.co/hang B https://t.co/toLnkd", {
      resolveRedirect: tableResolver(
        { "https://t.co/toLnkd": "https://lnkd.in/mid", "https://lnkd.in/mid": "https://pub.test/final" },
        calls,
      ),
      tcoBudgetMs: 300,
    });
    expect(prepared.text).toBe("A https://t.co/hang B https://pub.test/final");
  });

  test("a shortener both bare in the text and a t.co target is looked up once", async () => {
    const calls: string[] = [];
    const prepared = await prepareTextLinks("A https://t.co/a1 B https://bit.ly/zz", {
      resolveRedirect: tableResolver({ "https://t.co/a1": "https://bit.ly/zz", "https://bit.ly/zz": "https://pub.test/z" }, calls),
    });
    expect(calls.sort()).toEqual(["https://bit.ly/zz", "https://t.co/a1"]);
    expect(prepared.text).toBe("A https://pub.test/z B https://pub.test/z");
  });

  test("a bare shortener that lands on another shortener gets no second hop (M23)", async () => {
    const calls: string[] = [];
    const prepared = await prepareTextLinks("A https://bit.ly/toLnkd", {
      resolveRedirect: tableResolver({ "https://bit.ly/toLnkd": "https://lnkd.in/x", "https://lnkd.in/x": "https://pub.test/x" }, calls),
    });
    expect(calls).toEqual(["https://bit.ly/toLnkd"]);
    expect(prepared.text).toBe("A https://lnkd.in/x");
  });

  test("the last lookup under the cap goes to the earlier link in the text, however fast the later one answers", async () => {
    const calls: string[] = [];
    // 39 first hops leave ONE lookup; the slow t.co comes first in the text.
    const text = [
      "https://t.co/slow",
      "https://t.co/fast",
      ...Array.from({ length: TEXT_LINKS_MAX - 3 }, (_, i) => `https://t.co/many${i}`),
    ].join("\n");
    const prepared = await prepareTextLinks(text, {
      resolveRedirect: tableResolver(
        {
          "https://t.co/slow": "https://lnkd.in/p",
          "https://t.co/fast": "https://lnkd.in/q",
          "https://lnkd.in/p": "https://pub.test/p",
          "https://lnkd.in/q": "https://pub.test/q",
        },
        calls,
        { "https://t.co/slow": 50 },
      ),
    });
    expect(calls).toContain("https://lnkd.in/p");
    expect(calls).not.toContain("https://lnkd.in/q");
    expect(calls).toHaveLength(TEXT_LINKS_MAX);
    expect(prepared.text.split("\n").slice(0, 2)).toEqual(["https://pub.test/p", "https://lnkd.in/q"]);
  });

  test("under a tight cap a link waits on a hanging earlier one only while that one could take the last lookup", async () => {
    const calls: string[] = [];
    // 38 first hops leave TWO lookups; the hanging t.co could take one at most.
    const text = [
      "https://t.co/hang",
      "https://t.co/plain1",
      "https://t.co/plain2",
      "https://t.co/toLnkd",
      ...Array.from({ length: TEXT_LINKS_MAX - 6 }, (_, i) => `https://t.co/many${i}`),
    ].join("\n");
    const prepared = await prepareTextLinks(text, {
      resolveRedirect: tableResolver(
        {
          "https://t.co/plain1": "https://pub.test/1",
          "https://t.co/plain2": "https://pub.test/2",
          "https://t.co/toLnkd": "https://lnkd.in/mid",
          "https://lnkd.in/mid": "https://pub.test/final",
        },
        calls,
      ),
      tcoBudgetMs: 300,
    });
    expect(prepared.text.split("\n")[3]).toBe("https://pub.test/final");
  });
});
