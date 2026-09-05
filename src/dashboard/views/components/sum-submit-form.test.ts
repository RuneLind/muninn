import { describe, expect, test } from "bun:test";
import { captureUrlFormHtml, sumSubmitFormHtml, sumSubmitFormScript } from "./sum-submit-form.ts";

/**
 * Harness for the INJECTED half of the two capture entries — the
 * `jira-entry.test.ts` precedent: the DOM is stubbed rather than emulated, and
 * the REAL `sumSubmitFormScript()` source is what runs, so a change to it that
 * breaks a seam fails here with no browser involved.
 *
 * What only this tier can see:
 *
 *   1. The bare-link alert text, BYTE for byte. It is the sentence that tells a
 *      reader to use the Chrome extension, and it must not drift when the same
 *      branch grows a forwarding case beside it.
 *   2. Which paste is forwarded to `/api/vimeo/summarize` and which is not — a
 *      YouTube link in the article box must still alert and POST NOTHING, and a
 *      Vimeo one must POST without alerting.
 *   3. The clear/keep rule on the URL field: an answer that started or adopted a
 *      capture clears it; a refusal leaves the text where it can be fixed.
 */

/** The alert a bare non-Vimeo link gets. Spelled out here on purpose: this test
 *  is the pin, so the string is compared against a literal rather than against
 *  something derived from the source it is checking. */
/** The picker as the page renders it with no per-bot kinds. */
const PICKER = {
  kinds: [
    { id: "standard", label: "Standard" },
    { id: "deep", label: "Deep (opus, full thinking)" },
    { id: "talk-notes", label: "Talk notes (timeline)" },
  ],
  langs: [
    { id: "talk", label: "Talk's language" },
    { id: "nb", label: "Norsk (bokmål)" },
    { id: "en", label: "English" },
  ],
};

const BARE_LINK_ALERT =
  "This looks like a bare link. YouTube and X posts are captured with the Muninn Chrome extension — open the page and click the extension. This form wants the pasted article text itself.";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface Outcome {
  url: string;
  opts: Record<string, unknown>;
}

interface Harness {
  fetchCalls: FetchCall[];
  alerts: string[];
  outcomes: Outcome[];
  shownJobs: { jobId: string; title: string; url: string; source: string }[];
  connected: { jobId: string; source: string }[];
  replacedUrls: string[];
  /** Current value of the one-line URL field. */
  urlValue: () => string;
  /** Current value of the article textarea. */
  articleValue: () => string;
  setUrl: (v: string) => void;
  setArticle: (v: string) => void;
  /** Live-ness of the job card's stream, as the script sees it. */
  setStreamLive: (live: boolean) => void;
  /** How many times the script cleared the card's banner. */
  bannerClears: () => number;
  /** The disabled flag + label of one submit button, right now. */
  button: (id: string) => { disabled: boolean; label: string };
  /** The label a button carried while a submit was in flight. */
  labelDuring: (id: string) => string | undefined;
  /** Overwrite a button's label after init, the way an in-flight submit does. */
  setTransientLabel: (id: string, label: string) => void;
  /** Pick an option on a select the way a reader does — value + change event. */
  select: (id: string, value: string) => void;
  /** A select's current value. */
  selected: (id: string) => string;
  /** Tick/untick a checkbox and fire its change listeners. */
  check: (id: string, checked: boolean) => void;
  checked: (id: string) => boolean;
  /** What the fake localStorage holds now. */
  stored: () => Record<string, string>;
  submitCaptureUrlFromInput: () => Promise<void>;
  submitArticle: () => Promise<void>;
  detectCaptureProvider: (url: unknown) => string | null;
}

/** What the harness lets a case set up BEFORE the script runs. */
interface HarnessSetup {
  /** The options each select offers, as the server rendered them. */
  selects?: Record<string, string[]>;
  /** Element ids rendered `disabled` (the Slides checkbox on a connector without file access). */
  disabled?: string[];
  /** What `localStorage` holds at script init; `throws` makes the accessor throw. */
  storage?: Record<string, string> | { throws: true };
}

function harness(
  response: { status: number; body: unknown } | { throws: true },
  setup: HarnessSetup = {},
): Harness {
  const fetchCalls: FetchCall[] = [];
  const alerts: string[] = [];
  const outcomes: Outcome[] = [];
  const shownJobs: Harness["shownJobs"] = [];
  const connected: Harness["connected"] = [];
  const replacedUrls: string[] = [];

  const values: Record<string, string> = {
    articleText: "",
    articleTitle: "",
    articleUrl: "",
    captureUrl: "",
  };

  const changeListeners: Record<string, Array<() => void>> = {};
  const element = (id: string) => ({
    get value() {
      return values[id] ?? "";
    },
    set value(v: string) {
      values[id] = v;
    },
    disabled: setup.disabled?.includes(id) ?? false,
    checked: false,
    textContent: "Summarize",
    // A select's options, as the server rendered them; a text field has none.
    options: (setup.selects?.[id] ?? []).map((value) => ({ value })),
    addEventListener(type: string, fn: () => void) {
      if (type === "change") (changeListeners[id] ??= []).push(fn);
    },
  });
  // A select with options starts on its FIRST one, like a real <select>.
  for (const [id, options] of Object.entries(setup.selects ?? {})) {
    if (options.length > 0) values[id] = options[0]!;
  }
  const stored: Record<string, string> = "throws" in (setup.storage ?? {}) ? {} : { ...(setup.storage as Record<string, string> | undefined) };
  const storageThrows = "throws" in (setup.storage ?? {});
  const fakeStorage = {
    getItem(key: string) {
      if (storageThrows) throw new Error("storage blocked");
      return key in stored ? stored[key]! : null;
    },
    setItem(key: string, value: string) {
      if (storageThrows) throw new Error("storage blocked");
      stored[key] = value;
    },
  };
  let streamLive = false;
  let bannerClears = 0;
  const labelDuring: Record<string, string> = {};
  const nodes: Record<string, ReturnType<typeof element>> = {};
  const doc = {
    getElementById(id: string) {
      return (nodes[id] ??= element(id));
    },
  };

  const ctx = {
    document: doc,
    localStorage: fakeStorage,
    alert: (message: string) => alerts.push(message),
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      fetchCalls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      // Sampled WHILE the request is in flight — the only moment the "Starting…"
      // label and the disabled flag are observable.
      for (const id of ["captureUrlBtn", "submitBtn"]) {
        const el = nodes[id];
        if (el) labelDuring[id] = el.textContent;
      }
      if ("throws" in response) throw new Error("network down");
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body,
      };
    },
    history: { replaceState: (_s: unknown, _t: string, u: string) => replacedUrls.push(u) },
    location: { hash: "" },
    showJob: (jobId: string, title: string, url: string, source: string) =>
      shownJobs.push({ jobId, title, url, source }),
    connectSSE: (jobId: string, source: string) => connected.push({ jobId, source }),
    showCaptureOutcome: (url: string, opts: Record<string, unknown>) => outcomes.push({ url, opts }),
    // The job card owns the sentence map; here it only has to be callable.
    vimeoSentence: (code: string) => (code ? `sentence:${code}` : null),
    // The job card owns the banner and the stream; the form only asks.
    clearCaptureBanner: () => { bannerClears += 1; },
    captureStreamIsLive: () => streamLive,
    showDuplicateBanner: () => {},
    openSummaryDoc: () => {},
  };

  const prelude = [
    "var document = ctx.document;",
    "var localStorage = ctx.localStorage;",
    "var alert = ctx.alert;",
    "var fetch = ctx.fetch;",
    "var history = ctx.history;",
    "var location = ctx.location;",
    "var showJob = ctx.showJob;",
    "var connectSSE = ctx.connectSSE;",
    "var showCaptureOutcome = ctx.showCaptureOutcome;",
    "var vimeoSentence = ctx.vimeoSentence;",
    "var clearCaptureBanner = ctx.clearCaptureBanner;",
    "var captureStreamIsLive = ctx.captureStreamIsLive;",
    "var showDuplicateBanner = ctx.showDuplicateBanner;",
    "var openSummaryDoc = ctx.openSummaryDoc;",
  ].join("\n");

  const made = new Function(
    "ctx",
    `${prelude}\n${sumSubmitFormScript()}\n` +
      "return { submitCaptureUrlFromInput: submitCaptureUrlFromInput, submitArticle: submitArticle," +
      " detectCaptureProvider: detectCaptureProvider };",
  )(ctx) as Pick<
    Harness,
    "submitCaptureUrlFromInput" | "submitArticle" | "detectCaptureProvider"
  >;

  return {
    fetchCalls,
    alerts,
    outcomes,
    shownJobs,
    connected,
    replacedUrls,
    urlValue: () => values.captureUrl ?? "",
    articleValue: () => values.articleText ?? "",
    setUrl: (v: string) => {
      values.captureUrl = v;
    },
    setArticle: (v: string) => {
      values.articleText = v;
    },
    setStreamLive: (live: boolean) => {
      streamLive = live;
    },
    bannerClears: () => bannerClears,
    button: (id: string) => ({
      disabled: nodes[id]?.disabled ?? false,
      label: nodes[id]?.textContent ?? "",
    }),
    labelDuring: (id: string) => labelDuring[id],
    // `doc.getElementById`, not a `nodes[id]` read: the node is created lazily,
    // so a bare lookup is a silent no-op on any script that has not touched this
    // button yet — which is exactly the script this test exists to fail against.
    setTransientLabel: (id: string, label: string) => {
      doc.getElementById(id).textContent = label;
    },
    select: (id: string, value: string) => {
      values[id] = value;
      for (const fn of changeListeners[id] ?? []) fn();
    },
    selected: (id: string) => values[id] ?? "",
    check: (id: string, checked: boolean) => {
      doc.getElementById(id).checked = checked;
      for (const fn of changeListeners[id] ?? []) fn();
    },
    checked: (id: string) => doc.getElementById(id).checked,
    stored: () => ({ ...stored }),
    ...made,
  };
}

describe("sum-submit-form: the bare-link alert", () => {
  test("is byte-identical in the rendered script", () => {
    expect(sumSubmitFormScript()).toContain(BARE_LINK_ALERT);
  });

  test("is what a bare non-Vimeo link gets, with no POST", async () => {
    const h = harness({ status: 200, body: {} });
    h.setArticle("https://youtube.com/watch?v=abc");
    await h.submitArticle();
    expect(h.alerts).toEqual([BARE_LINK_ALERT]);
    expect(h.fetchCalls).toEqual([]);
  });
});

describe("sum-submit-form: detectCaptureProvider", () => {
  const h = harness({ status: 200, body: {} });

  test("answers vimeo for the three hosts, whatever the path", () => {
    expect(h.detectCaptureProvider("https://vimeo.com/1223358361")).toBe("vimeo");
    expect(h.detectCaptureProvider("https://www.vimeo.com/1223358361/abc123")).toBe("vimeo");
    expect(h.detectCaptureProvider("http://player.vimeo.com/video/1223358361")).toBe("vimeo");
    // Not a video URL at all — the SERVER is the authority on that and answers
    // 400; the hint only says which box may forward it.
    expect(h.detectCaptureProvider("https://vimeo.com/channels/staffpicks")).toBe("vimeo");
  });

  test("answers null for anything else", () => {
    expect(h.detectCaptureProvider("https://youtube.com/watch?v=abc")).toBeNull();
    expect(h.detectCaptureProvider("https://notvimeo.com/1")).toBeNull();
    // A host that merely ENDS in vimeo.com is a different site.
    expect(h.detectCaptureProvider("https://evilvimeo.com/1")).toBeNull();
    expect(h.detectCaptureProvider("javascript:alert(1)")).toBeNull();
    expect(h.detectCaptureProvider("not a url")).toBeNull();
  });
});

describe("sum-submit-form: the URL field", () => {
  test("a fresh job shows the card, connects the stream and clears the field", async () => {
    const h = harness({ status: 200, body: { job_id: "job-1", dashboard_url: "/summaries?x" } });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.fetchCalls).toEqual([
      { url: "/api/vimeo/summarize", method: "POST", body: { url: "https://vimeo.com/1223358361", frames: false } },
    ]);
    expect(h.shownJobs).toEqual([
      {
        jobId: "job-1",
        title: "https://vimeo.com/1223358361",
        url: "https://vimeo.com/1223358361",
        source: "vimeo",
      },
    ]);
    expect(h.connected).toEqual([{ jobId: "job-1", source: "vimeo" }]);
    expect(h.replacedUrls).toEqual(["/summaries?source=vimeo&job=job-1"]);
    expect(h.urlValue()).toBe("");
  });

  test("an in-flight answer attaches to the running job and clears the field", async () => {
    const h = harness({ status: 200, body: { in_flight: true, job_id: "job-9" } });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.shownJobs).toEqual([]);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]!.opts).toMatchObject({
      status: "pending",
      tone: "notice",
      jobId: "job-9",
      sentence: "sentence:in_flight",
    });
    expect(h.connected).toEqual([{ jobId: "job-9", source: "vimeo" }]);
    expect(h.urlValue()).toBe("");
  });

  test("a duplicate links to the stored document and starts nothing", async () => {
    const h = harness({
      status: 200,
      body: { duplicate: true, document_id: "ai/general/T.md", dashboard_url: "/summaries?doc=T" },
    });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.connected).toEqual([]);
    expect(h.outcomes[0]!.opts).toMatchObject({
      status: "duplicate",
      tone: "notice",
      sentence: "sentence:duplicate",
      link: "/summaries?doc=T",
    });
    expect(h.urlValue()).toBe("");
  });

  test("a 400 is named by its STATUS (the route sends no code) and keeps the text", async () => {
    const h = harness({ status: 400, body: { error: "Not a Vimeo video URL: nope" } });
    h.setUrl("nope");
    await h.submitCaptureUrlFromInput();

    expect(h.outcomes[0]!.opts).toMatchObject({ status: "error", sentence: "sentence:bad_url" });
    expect(h.connected).toEqual([]);
    expect(h.urlValue()).toBe("nope");
  });

  test("a coded refusal is named by its code and keeps the text", async () => {
    const h = harness({ status: 422, body: { error: "not_public", status: 404 } });
    h.setUrl("https://vimeo.com/1");
    await h.submitCaptureUrlFromInput();

    expect(h.outcomes[0]!.opts).toMatchObject({ status: "error", sentence: "sentence:not_public" });
    expect(h.urlValue()).toBe("https://vimeo.com/1");
  });

  test("a network failure is a sentence on the card, not a silent no-op", async () => {
    const h = harness({ throws: true });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.outcomes).toHaveLength(1);
    expect(String(h.outcomes[0]!.opts.sentence)).toContain("Request failed");
    expect(h.urlValue()).toBe("https://vimeo.com/1223358361");
  });

  test("an empty field posts nothing", async () => {
    const h = harness({ status: 200, body: { job_id: "x" } });
    await h.submitCaptureUrlFromInput();
    expect(h.fetchCalls).toEqual([]);
  });
});

describe("sum-submit-form: a Vimeo link in the ARTICLE box", () => {
  test("is forwarded to the same submit, with no alert, and clears the textarea", async () => {
    const h = harness({ status: 200, body: { job_id: "job-2" } });
    h.setArticle("https://vimeo.com/1223358361");
    await h.submitArticle();

    expect(h.alerts).toEqual([]);
    expect(h.fetchCalls).toEqual([
      { url: "/api/vimeo/summarize", method: "POST", body: { url: "https://vimeo.com/1223358361", frames: false } },
    ]);
    expect(h.connected).toEqual([{ jobId: "job-2", source: "vimeo" }]);
    expect(h.articleValue()).toBe("");
  });

  test("real pasted article text still goes to the article route", async () => {
    const h = harness({ status: 200, body: { job_id: "job-3" } });
    h.setArticle("Some pasted prose about vimeo.com and other things.");
    await h.submitArticle();

    expect(h.alerts).toEqual([]);
    expect(h.fetchCalls[0]!.url).toBe("/api/articles/summarize");
  });
});

describe("sum-submit-form: markup", () => {
  test("the URL field and its button carry the ids the script wires", () => {
    const html = captureUrlFormHtml(PICKER);
    expect(html).toContain('id="captureUrl"');
    expect(html).toContain('id="captureUrlBtn"');
    expect(html).toContain('type="url"');
    // The paste form is a separate, collapsed affordance and keeps its own ids.
    expect(sumSubmitFormHtml()).toContain('id="articleText"');
  });

  test("the picker renders one select per axis, in the order given, labels escaped", () => {
    const html = captureUrlFormHtml({
      kinds: [
        { id: "standard", label: "Standard" },
        { id: "talk-notes", label: 'Notes <"ours" & more>' },
      ],
      langs: PICKER.langs,
    });
    expect(html).toContain('<select id="captureKind" aria-label="Summary kind"');
    expect(html).toContain('<select id="captureLang" aria-label="Output language"');
    expect(html).toContain('<option value="standard">Standard</option><option value="talk-notes">Notes &lt;&quot;ours&quot; &amp; more&gt;</option>');
    expect(html).toContain('<option value="talk">Talk\'s language</option>');
    expect(html.indexOf('id="captureUrl"')).toBeLessThan(html.indexOf('id="captureKind"'));
    expect(html.indexOf('id="captureKind"')).toBeLessThan(html.indexOf('id="captureLang"'));
    expect(html.indexOf('id="captureLang"')).toBeLessThan(html.indexOf('id="captureUrlBtn"'));
    // No `selected` attribute anywhere: the browser's memory of the picker is
    // the script's, from localStorage — a server-picked option would win over it.
    expect(html).not.toContain("selected");
  });
});

describe("sum-submit-form: the kind + language picker", () => {
  const SELECTS = { captureKind: ["standard", "deep", "talk-notes"], captureLang: ["talk", "nb", "en"] };

  test("the picker's values ride on the capture POST, from the URL field and from the article-box forward", async () => {
    const h = harness({ status: 200, body: { job_id: "j1", title: "T" } }, { selects: SELECTS });
    h.select("captureKind", "talk-notes");
    h.select("captureLang", "nb");
    h.setUrl("https://vimeo.com/1223642971");
    await h.submitCaptureUrlFromInput();
    expect(h.fetchCalls[0]!.body).toEqual({ url: "https://vimeo.com/1223642971", kind: "talk-notes", lang: "nb", frames: false });

    h.setArticle("https://vimeo.com/1223642972");
    await h.submitArticle();
    expect(h.fetchCalls[1]!.body).toEqual({ url: "https://vimeo.com/1223642972", kind: "talk-notes", lang: "nb", frames: false });
  });

  test("with nothing stored the selects stay on their first option — the server's defaults", async () => {
    const h = harness({ status: 200, body: { job_id: "j1", title: "T" } }, { selects: SELECTS });
    expect(h.selected("captureKind")).toBe("standard");
    expect(h.selected("captureLang")).toBe("talk");
    h.setUrl("https://vimeo.com/1223642971");
    await h.submitCaptureUrlFromInput();
    expect(h.fetchCalls[0]!.body).toEqual({ url: "https://vimeo.com/1223642971", kind: "standard", lang: "talk", frames: false });
  });

  test("a change is remembered under the versioned key, and restored on the next init", () => {
    const h = harness({ status: 200, body: {} }, { selects: SELECTS });
    h.select("captureKind", "deep");
    h.select("captureLang", "en");
    expect(h.stored()).toEqual({ "muninn.summaries.capture.v1": JSON.stringify({ kind: "deep", lang: "en", frames: false }) });

    const again = harness({ status: 200, body: {} }, { selects: SELECTS, storage: h.stored() });
    expect(again.selected("captureKind")).toBe("deep");
    expect(again.selected("captureLang")).toBe("en");
  });

  test("EACH select persists on its own change — a reader who only changes the kind keeps it", () => {
    const kindOnly = harness({ status: 200, body: {} }, { selects: SELECTS });
    kindOnly.select("captureKind", "deep");
    expect(kindOnly.stored()).toEqual({ "muninn.summaries.capture.v1": JSON.stringify({ kind: "deep", lang: "talk", frames: false }) });
    const langOnly = harness({ status: 200, body: {} }, { selects: SELECTS });
    langOnly.select("captureLang", "en");
    expect(langOnly.stored()).toEqual({ "muninn.summaries.capture.v1": JSON.stringify({ kind: "standard", lang: "en", frames: false }) });
  });

  test("a stored value the server no longer offers is ignored, per axis", () => {
    const h = harness(
      { status: 200, body: {} },
      { selects: SELECTS, storage: { "muninn.summaries.capture.v1": JSON.stringify({ kind: "should-i-watch", lang: "nb" }) } },
    );
    expect(h.selected("captureKind")).toBe("standard");
    expect(h.selected("captureLang")).toBe("nb");
  });

  test("garbage in storage, or storage that throws, leaves the defaults and never breaks the script", async () => {
    const garbage = harness({ status: 200, body: { job_id: "j" } }, { selects: SELECTS, storage: { "muninn.summaries.capture.v1": "{not json" } });
    expect(garbage.selected("captureKind")).toBe("standard");
    const blocked = harness({ status: 200, body: { job_id: "j" } }, { selects: SELECTS, storage: { throws: true } });
    expect(blocked.selected("captureLang")).toBe("talk");
    // A change with blocked storage still changes the select and still posts.
    blocked.select("captureLang", "en");
    blocked.setUrl("https://vimeo.com/1223642971");
    await blocked.submitCaptureUrlFromInput();
    expect(blocked.fetchCalls[0]!.body).toMatchObject({ lang: "en" });
  });

  test("a 400 that names a refused kind or language is that sentence, not the URL one", async () => {
    const h = harness({ status: 400, body: { error: "Unknown summary kind: x", code: "bad_kind", kind: "x" } }, { selects: SELECTS });
    h.setUrl("https://vimeo.com/1223642971");
    await h.submitCaptureUrlFromInput();
    expect(h.outcomes[0]!.opts).toMatchObject({ status: "error", sentence: "sentence:bad_kind" });
    // The field keeps the url: nothing was started.
    expect(h.urlValue()).toBe("https://vimeo.com/1223642971");
  });
});

describe("sum-submit-form: an answer that lands while a capture is STREAMING", () => {
  /**
   * The `in_flight` answer names the job the card is ALREADY streaming. The page
   * used to reconnect to it: the working EventSource was closed and a second one
   * opened on the same url, which received the state replay and then not one
   * live event — measured twice in a browser, the badge stuck on `Summarizing`
   * with 2969 of 9560 characters on screen.
   */
  test("does not re-open the stream of the job already running", async () => {
    const h = harness({ status: 200, body: { in_flight: true, job_id: "job-9" } });
    h.setStreamLive(true);
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.connected).toEqual([]);
    // …and the address bar is not rewritten either: the card still belongs to
    // the running job, so the `?job=` it carries is already right.
    expect(h.replacedUrls).toEqual([]);
    // The reader still gets told what happened.
    expect(h.outcomes[0]!.opts).toMatchObject({ tone: "notice", sentence: "sentence:in_flight" });
  });

  test("with nothing streaming it DOES attach, which is the reload path", async () => {
    const h = harness({ status: 200, body: { in_flight: true, job_id: "job-9" } });
    h.setStreamLive(false);
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.connected).toEqual([{ jobId: "job-9", source: "vimeo" }]);
    expect(h.replacedUrls).toEqual(["/summaries?source=vimeo&job=job-9"]);
  });
});

describe("sum-submit-form: a 200 whose shape is not an answer", () => {
  /**
   * The URL was rewritten and the stream opened BEFORE `job_id` was looked at,
   * so a 200 carrying neither `duplicate` nor `job_id` put `?job=undefined` in
   * the address bar and opened `/api/vimeo/stream/undefined`.
   */
  test("is a refusal sentence, and rewrites nothing", async () => {
    const h = harness({ status: 200, body: {} });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.replacedUrls).toEqual([]);
    expect(h.connected).toEqual([]);
    expect(h.shownJobs).toEqual([]);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]!.opts.status).toBe("error");
    expect(String(h.outcomes[0]!.opts.sentence)).toContain("cannot read");
    // Nothing was started, so the text stays where it can be fixed.
    expect(h.urlValue()).toBe("https://vimeo.com/1223358361");
  });

  test("a job_id that is not a string is refused the same way", async () => {
    const h = harness({ status: 200, body: { job_id: 42 } });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();
    expect(h.replacedUrls).toEqual([]);
    expect(h.connected).toEqual([]);
  });
});

describe("sum-submit-form: the card's title comes from the route", () => {
  test("a fresh job is titled with the video's name, not the pasted address", async () => {
    const h = harness({ status: 200, body: { job_id: "job-1", title: "Trust, but verify" } });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();

    expect(h.shownJobs).toEqual([
      {
        jobId: "job-1",
        title: "Trust, but verify",
        url: "https://vimeo.com/1223358361",
        source: "vimeo",
      },
    ]);
  });

  test("an answer with no title still shows the url, rather than nothing", async () => {
    const h = harness({ status: 200, body: { job_id: "job-1" } });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();
    expect(h.shownJobs[0]!.title).toBe("https://vimeo.com/1223358361");
  });

  test("an in-flight attach carries the running job's title too", async () => {
    const h = harness({ status: 200, body: { in_flight: true, job_id: "job-9", title: "The talk" } });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();
    expect(h.outcomes[0]!.opts).toMatchObject({ title: "The talk" });
  });
});

describe("sum-submit-form: the button the reader actually pressed", () => {
  test("a Vimeo link in the ARTICLE box gives ITS button the feedback", async () => {
    const h = harness({ status: 200, body: { job_id: "job-2" } });
    h.setArticle("https://vimeo.com/1223358361");
    await h.submitArticle();

    expect(h.labelDuring("submitBtn")).toBe("Starting...");
    // The URL field's button is on the other side of the page and was not
    // pressed — disabling and relabelling it was feedback nobody was looking at.
    expect(h.labelDuring("captureUrlBtn")).toBe("Summarize");
    expect(h.button("submitBtn")).toEqual({ disabled: false, label: "Summarize" });
  });

  test("the URL field's own submit still drives the URL field's button", async () => {
    const h = harness({ status: 200, body: { job_id: "job-1" } });
    h.setUrl("https://vimeo.com/1223358361");
    await h.submitCaptureUrlFromInput();
    expect(h.labelDuring("captureUrlBtn")).toBe("Starting...");
    expect(h.button("captureUrlBtn")).toEqual({ disabled: false, label: "Summarize" });
  });

  test("a label captured at INIT is what gets restored, never a transient one", async () => {
    const h = harness({ status: 200, body: { job_id: "job-1" } });
    // What a second submit sees when one is already in flight. Read at call time,
    // this is what the finally block restored — permanently.
    h.setUrl("https://vimeo.com/1223358361");
    h.setTransientLabel("captureUrlBtn", "Starting...");
    // The instrument really applied — a lazily-created stub node made this a
    // silent no-op once, and the test passed against the code it should fail on.
    expect(h.button("captureUrlBtn").label).toBe("Starting...");
    await h.submitCaptureUrlFromInput();
    expect(h.button("captureUrlBtn").label).toBe("Summarize");
  });
});

describe("sum-submit-form: the banner does not outlive the request it belongs to", () => {
  test("a submit STARTS by clearing whatever the last answer left there", async () => {
    const h = harness({ status: 422, body: { error: "not_public" } });
    h.setUrl("https://vimeo.com/1");
    await h.submitCaptureUrlFromInput();
    expect(h.bannerClears()).toBe(1);

    await h.submitCaptureUrlFromInput();
    // Cleared again the moment the second request went out — the stale refusal
    // used to stay on screen for the whole of it.
    expect(h.bannerClears()).toBe(2);
  });

  test("the forward from the article box clears it too", async () => {
    const h = harness({ status: 200, body: { job_id: "job-2" } });
    h.setArticle("https://vimeo.com/1223358361");
    await h.submitArticle();
    expect(h.bannerClears()).toBe(1);
  });
});

describe("sum-submit-form: markup, accessibility", () => {
  test("the URL field has an accessible name", () => {
    expect(captureUrlFormHtml(PICKER)).toContain('aria-label="Vimeo URL"');
  });
});

describe("sum-submit-form: the Slides checkbox (v2 PR 4)", () => {
  const SELECTS = { captureKind: ["standard", "deep", "talk-notes"], captureLang: ["talk", "nb", "en"] };
  const OK = { status: 200, body: { job_id: "j1", title: "T" } };

  test("renders between the language select and the button; disabled with the reason when unsupported", () => {
    const live = captureUrlFormHtml({ ...PICKER, framesSupported: true });
    expect(live).toContain('<input type="checkbox" id="captureFrames" />');
    expect(live).not.toContain("disabled");
    expect(live.indexOf('id="captureLang"')).toBeLessThan(live.indexOf('id="captureFrames"'));
    expect(live.indexOf('id="captureFrames"')).toBeLessThan(live.indexOf('id="captureUrlBtn"'));
    expect(live).toContain("off by default; remembered");

    const dead = captureUrlFormHtml({ ...PICKER, framesSupported: false });
    expect(dead).toContain('<input type="checkbox" id="captureFrames" disabled />');
    expect(dead).toContain("cannot read frame files");
    // Default (no bot in hand) is the live control.
    expect(captureUrlFormHtml(PICKER)).not.toContain("disabled");
    // Never pre-checked by the server: the browser's memory decides.
    expect(live).not.toContain("checked");
  });

  test("off by default, on the wire as a boolean, and ticking it rides on the POST", async () => {
    const h = harness(OK, { selects: SELECTS });
    expect(h.checked("captureFrames")).toBe(false);
    h.setUrl("https://vimeo.com/1223642971");
    await h.submitCaptureUrlFromInput();
    expect(h.fetchCalls[0]!.body).toEqual({ url: "https://vimeo.com/1223642971", kind: "standard", lang: "talk", frames: false });

    h.check("captureFrames", true);
    h.setUrl("https://vimeo.com/1223642972");
    await h.submitCaptureUrlFromInput();
    expect(h.fetchCalls[1]!.body).toEqual({ url: "https://vimeo.com/1223642972", kind: "standard", lang: "talk", frames: true });
  });

  test("the tick is remembered under the same versioned key and restored on the next init", () => {
    const h = harness(OK, { selects: SELECTS });
    h.check("captureFrames", true);
    expect(h.stored()).toEqual({ "muninn.summaries.capture.v1": JSON.stringify({ kind: "standard", lang: "talk", frames: true }) });
    const again = harness(OK, { selects: SELECTS, storage: h.stored() });
    expect(again.checked("captureFrames")).toBe(true);
    // Unticking is remembered too (not just "ever ticked").
    again.check("captureFrames", false);
    expect(JSON.parse(again.stored()["muninn.summaries.capture.v1"]!).frames).toBe(false);
    // Only a real boolean true restores: a stored string is off.
    const stringy = harness(OK, {
      selects: SELECTS,
      storage: { "muninn.summaries.capture.v1": JSON.stringify({ kind: "standard", lang: "talk", frames: "true" }) },
    });
    expect(stringy.checked("captureFrames")).toBe(false);
  });

  test("a DISABLED checkbox posts false whatever storage remembers — a tick from another instance never 503s here", async () => {
    const h = harness(OK, {
      selects: SELECTS,
      disabled: ["captureFrames"],
      storage: { "muninn.summaries.capture.v1": JSON.stringify({ kind: "standard", lang: "talk", frames: true }) },
    });
    expect(h.checked("captureFrames")).toBe(false);
    h.setUrl("https://vimeo.com/1223642971");
    await h.submitCaptureUrlFromInput();
    expect((h.fetchCalls[0]!.body as { frames: boolean }).frames).toBe(false);
    // The stored tick SURVIVES a disabled instance: changing the kind here
    // must not rewrite storage with frames:false and erase the laptop's choice.
    h.select("captureKind", "deep");
    expect(JSON.parse(h.stored()["muninn.summaries.capture.v1"]!)).toEqual({ kind: "deep", lang: "talk", frames: true });
    // Defence in depth: even a disabled box that somehow READS checked (a stale
    // DOM, devtools) posts false — the read site checks `disabled` itself.
    h.check("captureFrames", true);
    h.setUrl("https://vimeo.com/1223642972"); // the first submit cleared the field
    await h.submitCaptureUrlFromInput();
    expect((h.fetchCalls[1]!.body as { frames: boolean }).frames).toBe(false);
  });

  test("a 503 frames_unsupported is the card's sentence for that code, and keeps the text", async () => {
    const h = harness({ status: 503, body: { error: "frames_unsupported", code: "frames_unsupported", detail: "x" } }, { selects: SELECTS });
    h.check("captureFrames", true);
    h.setUrl("https://vimeo.com/1223642971");
    await h.submitCaptureUrlFromInput();
    expect(h.outcomes[0]!.opts.sentence).toBe("sentence:frames_unsupported");
    expect(h.urlValue()).toBe("https://vimeo.com/1223642971");
  });
});
