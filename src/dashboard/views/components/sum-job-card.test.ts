import { describe, expect, test } from "bun:test";
import { sumJobCardHtml, sumJobCardScript, sumJobCardStyles } from "./sum-job-card.ts";

/**
 * The Vimeo sentence map, driven out of the REAL injected script.
 *
 * Every route refusal and the one job-error code that is not a message
 * (`no_captions`) render as a sentence about the VIDEO rather than as a generic
 * failure, and all of them live in ONE map — a code spelled in two places drifts
 * into a card reporting "Error" for a video Vimeo simply declined to describe.
 * These cases are what makes removing an entry a test failure rather than a
 * silently generic card.
 *
 * The DOM is stubbed, not emulated (the `jira-entry.test.ts` precedent), so the
 * banner assertions read the text the script actually wrote.
 */

interface Harness {
  vimeoSentence: (code: string, data?: unknown) => string | null;
  showError: (message: string) => void;
  showCaptureOutcome: (url: string, opts: Record<string, unknown>) => void;
  showJob: (jobId: string | null, title: string, url: string | null, source: string) => void;
  connectSSE: (jobId: string, source: string) => void;
  setSource: (source: string) => void;
  bannerText: () => string;
  bannerClasses: () => string[];
  badgeHtml: () => string;
  titleHtml: () => string;
  titleText: () => string;
  summaryText: () => string;
  appended: () => string[];
  /** The handler map the script passed to `sseClient`, so a test can fire one. */
  sse: () => Record<string, (e: { data?: string }) => void>;
}

function harness(): Harness {
  const classes: Record<string, Set<string>> = {};
  const text: Record<string, string> = {};
  const html: Record<string, string> = {};
  const appended: string[] = [];

  const element = (id: string) => {
    classes[id] = new Set<string>();
    return {
      addEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      hasAttribute: () => false,
      appendChild(node: { text?: string }) {
        appended.push(node.text ?? "");
      },
      querySelectorAll: () => [],
      style: {},
      get className() {
        return [...classes[id]!].join(" ");
      },
      set className(v: string) {
        classes[id] = new Set(v.split(/\s+/).filter(Boolean));
      },
      get textContent() {
        return text[id] ?? "";
      },
      set textContent(v: string) {
        text[id] = v;
      },
      get innerHTML() {
        return html[id] ?? "";
      },
      set innerHTML(v: string) {
        html[id] = v;
      },
      classList: {
        add: (c: string) => classes[id]!.add(c),
        remove: (c: string) => classes[id]!.delete(c),
        toggle: (c: string, on?: boolean) => {
          if (on === undefined) {
            if (classes[id]!.has(c)) classes[id]!.delete(c);
            else classes[id]!.add(c);
          } else if (on) classes[id]!.add(c);
          else classes[id]!.delete(c);
        },
        contains: (c: string) => classes[id]!.has(c),
      },
    };
  };

  const nodes: Record<string, ReturnType<typeof element>> = {};
  const doc = {
    getElementById: (id: string) => (nodes[id] ??= element(id)),
    // The link half of a duplicate outcome — recorded as text so the assertion
    // can see the label without a real DOM.
    createElement: () => ({ href: "", text: "", set textContent(v: string) { this.text = v; } }),
    createTextNode: (t: string) => ({ text: t }),
  };

  let sse: Record<string, (e: { data?: string }) => void> = {};
  const ctx = {
    document: doc,
    esc: (s: string) => s,
    marked: undefined,
    sseClient: (_url: string, handlers: Record<string, (e: { data?: string }) => void>) => {
      sse = handlers;
      return { close() {} };
    },
    openSummaryDoc: () => {},
    SOURCES: { vimeo: { apiBase: "/api/vimeo" } },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    // Injected by the page from the SERVER constant (src/vimeo/limits.ts).
    VIMEO_MAX_DURATION_SEC: 3 * 60 * 60,
  };

  const prelude = [
    "var document = ctx.document;",
    "var esc = ctx.esc;",
    "var marked = ctx.marked;",
    "var sseClient = ctx.sseClient;",
    "var openSummaryDoc = ctx.openSummaryDoc;",
    "var SOURCES = ctx.SOURCES;",
    "var fetch = ctx.fetch;",
    "var VIMEO_MAX_DURATION_SEC = ctx.VIMEO_MAX_DURATION_SEC;",
  ].join("\n");

  const made = new Function(
    "ctx",
    `${prelude}\n${sumJobCardScript()}\n` +
      "return { vimeoSentence: vimeoSentence, showError: showError," +
      " showCaptureOutcome: showCaptureOutcome, showJob: showJob," +
      " connectSSE: connectSSE," +
      " setSource: function(s) { currentSource = s; } };",
  )(ctx) as Pick<
    Harness,
    | "vimeoSentence"
    | "showError"
    | "showCaptureOutcome"
    | "showJob"
    | "connectSSE"
    | "setSource"
  >;

  return {
    ...made,
    bannerText: () => text.errorBanner ?? "",
    bannerClasses: () => [...(classes.errorBanner ?? [])],
    badgeHtml: () => html.statusBadge ?? "",
    titleHtml: () => html.jobTitle ?? "",
    titleText: () => text.jobTitle ?? "",
    summaryText: () => text.summaryArea ?? "",
    appended: () => appended,
    sse: () => sse,
  };
}

describe("sum-job-card: the Vimeo sentence map", () => {
  const h = harness();

  test("names every route refusal", () => {
    expect(h.vimeoSentence("bad_url")).toBe("Not a Vimeo video URL");
    expect(h.vimeoSentence("not_public")).toBe("Vimeo says this video is not public");
    expect(h.vimeoSentence("duration_unknown")).toBe(
      "Vimeo did not report a duration, so the 3 h cap cannot be checked",
    );
    // …and the cap in it is DERIVED from the injected server constant, not
    // spelled: a route that reports its own maxSec names that one instead.
    expect(h.vimeoSentence("duration_unknown", { maxSec: 5400 })).toBe(
      "Vimeo did not report a duration, so the 1 h 30 m cap cannot be checked",
    );
    expect(h.vimeoSentence("oembed_failed")).toBe("Vimeo did not answer");
  });

  test("names the two answers that are not refusals", () => {
    expect(h.vimeoSentence("duplicate")).toBe("Already captured");
    expect(h.vimeoSentence("in_flight")).toBe("Already being captured");
  });

  test("names the one job-error CODE, which is a fact about the video", () => {
    expect(h.vimeoSentence("no_captions")).toBe("This video has no caption track");
  });

  test("too_long carries the measurement the route reported", () => {
    expect(h.vimeoSentence("too_long", { durationSec: 20000 })).toBe(
      "Longer than the 3 h cap (5h 33m)",
    );
    expect(h.vimeoSentence("too_long", { durationSec: 10801 })).toBe(
      "Longer than the 3 h cap (3h 0m)",
    );
    // A duration the route did not report degrades to the cap alone rather than
    // to "NaNh NaNm".
    expect(h.vimeoSentence("too_long", {})).toBe("Longer than the 3 h cap");
    expect(h.vimeoSentence("too_long")).toBe("Longer than the 3 h cap");
  });

  test("an unknown code has no sentence, so the caller can fall back", () => {
    expect(h.vimeoSentence("something_else")).toBeNull();
  });
});

describe("sum-job-card: showError", () => {
  test("translates a vimeo job's error CODE into the sentence", () => {
    const h = harness();
    h.setSource("vimeo");
    h.showError("no_captions");
    expect(h.bannerText()).toBe("This video has no caption track");
  });

  test("leaves another vertical's error message alone", () => {
    const h = harness();
    h.setSource("youtube");
    h.showError("no_captions");
    expect(h.bannerText()).toBe("no_captions");
  });

  test("leaves a vimeo message that is not a code alone", () => {
    const h = harness();
    h.setSource("vimeo");
    h.showError("yt-dlp exited with code 1");
    expect(h.bannerText()).toBe("yt-dlp exited with code 1");
  });
});

describe("sum-job-card: showCaptureOutcome", () => {
  test("a refusal renders the sentence in the error tone", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "error",
      sentence: "Vimeo says this video is not public",
    });
    expect(h.bannerText()).toBe("Vimeo says this video is not public");
    expect(h.bannerClasses()).toContain("visible");
    expect(h.bannerClasses()).not.toContain("notice");
    expect(h.badgeHtml()).toContain("Error");
  });

  test("a duplicate renders the notice tone plus a link to the stored document", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "duplicate",
      tone: "notice",
      sentence: "Already captured",
      link: "/summaries?source=vimeo&doc=x&duplicate=1",
      linkLabel: "open the summary",
    });
    expect(h.bannerText()).toBe("Already captured");
    expect(h.bannerClasses()).toContain("notice");
    expect(h.appended()).toContain(" — ");
    expect(h.badgeHtml()).toContain("Already captured");
  });
});

describe("sum-job-card: the duplicate badge", () => {
  test("is terminal (no spinner) and has a tone of its own", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "duplicate",
      sentence: "Already captured",
    });
    expect(h.badgeHtml()).not.toContain("spinner");
    expect(sumJobCardStyles()).toContain(".status-duplicate");
  });

  test("the banner's tone is overridable — its border is no longer inline", () => {
    // An inline `style=` wins over every stylesheet rule, so the notice tone
    // could not repaint the red top border while it lived on the element.
    expect(sumJobCardHtml()).toContain('<div class="error-banner" id="errorBanner"></div>');
    expect(sumJobCardStyles()).toContain("#errorBanner.notice");
  });
});

describe("sum-job-card: the too_long measurement", () => {
  const h = harness();

  /**
   * The minutes are rounded ONCE off the whole duration and the hours read off
   * that. Rounding the REMAINDER instead — `Math.round((secs - h*3600)/60)` —
   * produced a minute field of 60, because 3590 s rounds to 60 minutes and 60 is
   * not a minute count. Measured end to end on 14390 s: "3h 60m".
   */
  test("never renders a 60-minute remainder", () => {
    expect(h.vimeoSentence("too_long", { durationSec: 14390 })).toBe(
      "Longer than the 3 h cap (4h 0m)",
    );
    expect(h.vimeoSentence("too_long", { durationSec: 21599 })).toBe(
      "Longer than the 3 h cap (6h 0m)",
    );
    // The rounding is to the nearest minute of the WHOLE measurement, so 3h59m50s
    // is four hours — 14390 above is that value, and this is the boundary either
    // side of it.
    expect(h.vimeoSentence("too_long", { durationSec: 14369 })).toBe(
      "Longer than the 3 h cap (3h 59m)",
    );
  });

  test("names the cap the ROUTE reported, when it reported one", () => {
    expect(h.vimeoSentence("too_long", { durationSec: 20000, maxSec: 7200 })).toBe(
      "Longer than the 2 h cap (5h 33m)",
    );
    // No maxSec on the wire ⇒ the injected server constant.
    expect(h.vimeoSentence("too_long", { durationSec: 20000 })).toBe(
      "Longer than the 3 h cap (5h 33m)",
    );
  });
});

describe("sum-job-card: vimeoSentence is not a prototype read", () => {
  /**
   * A bare `VIMEO_SENTENCES[code]` answers every inherited member of
   * `Object.prototype` — the route's `error` string is not a closed set (a proxy
   * or a future branch can put anything there), and `constructor` rendered the
   * source of `Object` into the card's banner.
   */
  test("an inherited member is not a sentence", () => {
    const h = harness();
    for (const code of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(h.vimeoSentence(code)).toBeNull();
    }
  });

  test("and the real codes still answer", () => {
    const h = harness();
    expect(h.vimeoSentence("not_public")).toBe("Vimeo says this video is not public");
  });
});

describe("sum-job-card: showCaptureOutcome while a capture is STREAMING", () => {
  /** Start a job and open its stream — the state a mid-capture paste lands in. */
  function streaming() {
    const h = harness();
    h.showJob("job-1", "The real talk", "https://vimeo.com/1223358361", "vimeo");
    h.connectSSE("job-1", "vimeo");
    return h;
  }

  test("a refusal is the banner ONLY — the running card is untouched", () => {
    const h = streaming();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "error",
      sentence: "Vimeo says this video is not public",
    });

    expect(h.bannerText()).toBe("Vimeo says this video is not public");
    expect(h.bannerClasses()).toContain("visible");
    // The badge still belongs to the running job — repainting it to Error is
    // what put the first job's summary under an Error badge twelve seconds later.
    expect(h.badgeHtml()).not.toContain("Error");
    expect(h.badgeHtml()).toContain("Pending");
    // …and so does the title, which was being replaced by the url that FAILED.
    expect(h.titleHtml()).toContain("The real talk");
    expect(h.titleHtml()).not.toContain("https://vimeo.com/1\"");
  });

  test("an in-flight notice is the banner ONLY, in the notice tone", () => {
    const h = streaming();
    h.showCaptureOutcome("https://vimeo.com/1223358361", {
      status: "pending",
      tone: "notice",
      jobId: "job-1",
      sentence: "Already being captured",
    });
    expect(h.bannerText()).toBe("Already being captured");
    expect(h.bannerClasses()).toContain("notice");
    expect(h.titleHtml()).toContain("The real talk");
  });

  test("a duplicate is the banner ONLY — the summary area keeps the live text", () => {
    const h = streaming();
    h.showCaptureOutcome("https://vimeo.com/9", {
      status: "duplicate",
      tone: "notice",
      sentence: "Already captured",
      areaText: "This video is already in the archive.",
    });
    // The placeholder that says "nothing was captured" must not land on a card
    // that is capturing something.
    expect(h.summaryText()).not.toBe("This video is already in the archive.");
    expect(h.bannerText()).toBe("Already captured");
  });

  test("with NO live stream it still repaints, which is the whole point of the card", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "error",
      sentence: "Vimeo says this video is not public",
      areaText: "Nothing was captured.",
    });
    expect(h.badgeHtml()).toContain("Error");
    expect(h.summaryText()).toBe("Nothing was captured.");
  });

  test("a job that already finished is not live, so its card may be repainted", () => {
    const h = streaming();
    h.sse().complete!({ data: "" });
    h.showCaptureOutcome("https://vimeo.com/1", { status: "error", sentence: "Nope" });
    expect(h.badgeHtml()).toContain("Error");
  });

  test("showCaptureOutcome titles the card with the route's title when it repaints", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1223358361", {
      status: "pending",
      jobId: "job-9",
      title: "E2E held talk",
    });
    expect(h.titleHtml()).toContain("E2E held talk");
  });
});

describe("sum-job-card: the banner's lifecycle", () => {
  test("a completed capture does not sit under 'Already being captured'", () => {
    const h = harness();
    h.showJob("job-1", "T", "https://vimeo.com/1223358361", "vimeo");
    h.connectSSE("job-1", "vimeo");
    h.showCaptureOutcome("https://vimeo.com/1223358361", {
      status: "pending",
      tone: "notice",
      jobId: "job-1",
      sentence: "Already being captured",
    });
    expect(h.bannerClasses()).toContain("visible");

    h.sse().complete!({ data: "" });
    expect(h.bannerText()).toBe("");
    expect(h.bannerClasses()).not.toContain("visible");
    expect(h.bannerClasses()).not.toContain("notice");
  });

  test("showJob drops BOTH tones, not just `visible`", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "duplicate",
      tone: "notice",
      sentence: "Already captured",
    });
    expect(h.bannerClasses()).toContain("notice");

    h.showJob("job-2", "T", "https://vimeo.com/2", "vimeo");
    // A leftover `notice` repaints the next REFUSAL in the calm blue tone.
    expect(h.bannerClasses()).not.toContain("notice");
    expect(h.bannerClasses()).not.toContain("visible");
    expect(h.bannerText()).toBe("");
  });
});

describe("sum-job-card: the card title only links an http(s) address", () => {
  /**
   * `showCaptureOutcome` passes the reader's own paste as the card's url, and
   * `esc` escapes the attribute without touching the scheme — so a pasted
   * `javascript:` url was a live href on an operator page.
   */
  test("a javascript: url renders as TEXT, with no anchor", () => {
    const h = harness();
    h.showJob("job-1", "javascript:alert(1)", "javascript:alert(1)", "vimeo");
    expect(h.titleHtml()).toBe("");
    expect(h.titleText()).toBe("javascript:alert(1)");
  });

  test("so does a data: url", () => {
    const h = harness();
    h.showJob("job-1", "t", "data:text/html,<script>x</script>", "vimeo");
    expect(h.titleHtml()).toBe("");
    expect(h.titleText()).toBe("t");
  });

  test("an ordinary https url is still an anchor", () => {
    const h = harness();
    h.showJob("job-1", "T", "https://vimeo.com/1223358361", "vimeo");
    expect(h.titleHtml()).toContain('href="https://vimeo.com/1223358361"');
  });
});
