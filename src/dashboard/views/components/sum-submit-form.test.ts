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
  submitCaptureUrlFromInput: () => Promise<void>;
  submitArticle: () => Promise<void>;
  detectCaptureProvider: (url: unknown) => string | null;
}

function harness(response: { status: number; body: unknown } | { throws: true }): Harness {
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

  const element = (id: string) => ({
    get value() {
      return values[id] ?? "";
    },
    set value(v: string) {
      values[id] = v;
    },
    disabled: false,
    textContent: "Summarize",
    addEventListener() {},
  });
  const nodes: Record<string, ReturnType<typeof element>> = {};
  const doc = {
    getElementById(id: string) {
      return (nodes[id] ??= element(id));
    },
  };

  const ctx = {
    document: doc,
    alert: (message: string) => alerts.push(message),
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      fetchCalls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
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
    showDuplicateBanner: () => {},
    openSummaryDoc: () => {},
  };

  const prelude = [
    "var document = ctx.document;",
    "var alert = ctx.alert;",
    "var fetch = ctx.fetch;",
    "var history = ctx.history;",
    "var location = ctx.location;",
    "var showJob = ctx.showJob;",
    "var connectSSE = ctx.connectSSE;",
    "var showCaptureOutcome = ctx.showCaptureOutcome;",
    "var vimeoSentence = ctx.vimeoSentence;",
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
      { url: "/api/vimeo/summarize", method: "POST", body: { url: "https://vimeo.com/1223358361" } },
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
      { url: "/api/vimeo/summarize", method: "POST", body: { url: "https://vimeo.com/1223358361" } },
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
    const html = captureUrlFormHtml();
    expect(html).toContain('id="captureUrl"');
    expect(html).toContain('id="captureUrlBtn"');
    expect(html).toContain('type="url"');
    // The paste form is a separate, collapsed affordance and keeps its own ids.
    expect(sumSubmitFormHtml()).toContain('id="articleText"');
  });
});
