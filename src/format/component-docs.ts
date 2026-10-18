/**
 * What the component vocabulary means to a writer: a one-line description per
 * component and attribute, where each is taught (`wiki` — the wiki-authoring
 * reference; `chat` — `COMPONENT_VOCABULARY_RULES` in `src/research/answer.ts`),
 * and hints that map an off-vocabulary value to an accepted one.
 *
 * Kept out of `component-spec.ts` so none of these strings reach the browser
 * bundle: only the wiki linter and the reference generator import this file.
 */

import type { ComponentAttrName, ComponentName } from "./component-spec.ts";

export type TeachTarget = "wiki" | "chat";

export interface AttrDoc {
  doc?: string;
  /** Where this attribute is taught; absent means where its component is. */
  teach?: readonly TeachTarget[];
  /** An off-vocabulary value → the accepted value it most likely meant. */
  suggest?: Readonly<Record<string, string>>;
  /** An off-vocabulary value with no accepted counterpart → what to write instead. */
  hint?: Readonly<Record<string, string>>;
}

export interface ComponentDoc<A extends string = string> {
  doc: string;
  teach: readonly TeachTarget[];
  attrs?: { readonly [K in A]?: AttrDoc };
  /** A wrong attribute name → the attribute it most likely meant. */
  attrAliases?: Readonly<Record<string, A>>;
}

const WIKI = ["wiki"] as const;
const BOTH = ["wiki", "chat"] as const;

export const COMPONENT_DOCS: { readonly [K in ComponentName]: ComponentDoc<ComponentAttrName<K>> } = {
  Callout: {
    doc: "Boxed aside. At most about 3 per section; never the page summary.",
    teach: BOTH,
    attrs: {
      tone: {
        suggest: { success: "good", ok: "good", pass: "good", caution: "warn", warning: "warn", note: "info", tip: "info" },
      },
      title: { doc: "Bold lead line" },
      resolved: { teach: WIKI, doc: "ISO date; collapses the callout into a ✓ row" },
    },
    attrAliases: { type: "tone" },
  },
  Verdict: {
    doc: "A direct yes/no judgment chip.",
    teach: BOTH,
    attrs: { value: { hint: { maybe: "Verdict has no middle value; use a warn Callout" } } },
  },
  Pill: { doc: "Small status or tag chip.", teach: BOTH },
  Figure: { doc: "A captioned block.", teach: BOTH },
  FileRef: { doc: "A file-path reference.", teach: BOTH },
  ComparisonTable: { doc: "Wraps a pipe table that compares options side by side.", teach: BOTH },
  Meter: {
    doc: "A score bar; the body is its label.",
    teach: WIKI,
    attrs: { value: { doc: "Number, clamped into 0..max" }, max: { doc: "Positive number" } },
  },
  Diff: { doc: "Wraps one fenced unified diff.", teach: WIKI },
  FileTree: { doc: "Wraps one fenced directory tree.", teach: WIKI },
  Checklist: { doc: "Wraps a `- [ ]` / `- [x]` list.", teach: WIKI },
  AnnotatedCode: { doc: "Wraps one fence with numbered notes after it.", teach: WIKI },
  CodeTabs: { doc: "Groups `Tab` blocks into one tabbed code view.", teach: WIKI },
  Tab: { doc: "One tab of a `CodeTabs`.", teach: WIKI },
  Fact: { doc: "Fact-check mark on a passage; written by the fact-check pipeline.", teach: [] },
  FactCheck: { doc: "Fact-check appendix; written by the fact-check pipeline.", teach: [] },
  Embed: { doc: "Embeds a standalone .html explainer beside the page.", teach: WIKI },
  Fold: { doc: "Collapsible section; `open=\"true\"` starts it expanded.", teach: WIKI },
  Historic: { doc: "Marks sections the page keeps as history.", teach: WIKI },
  NextMoves: { doc: "Who has the next move; holds `Lane` blocks.", teach: WIKI },
  Lane: {
    doc: "One lane of a `NextMoves`; its body is a list of open steps.",
    teach: WIKI,
    attrs: {
      kind: { suggest: { next: "waiting" } },
      since: { doc: "ISO or DD.MM.YYYY date; the reader shows its age" },
    },
  },
  Query: { doc: "One prod query with its SQL, CSV result and answer.", teach: WIKI },
  CaseBoard: { doc: "Tracked cases from a YAML file beside the page.", teach: WIKI },
  DeltaTable: { doc: "Run-to-run numbers with a computed delta column.", teach: WIKI },
  Tldr: { doc: "The page's lead box over a short list.", teach: WIKI },
  Timeline: { doc: "A dated list of events.", teach: WIKI },
  DecisionLog: { doc: "A list of decisions, each with an id and status.", teach: WIKI },
  RunChecklist: { doc: "Steps to run, with their checked state.", teach: WIKI },
  Question: { doc: "An open question as an answer card.", teach: WIKI },
  More: { doc: "The closed rest of a `Tldr`.", teach: WIKI },
  StatusRows: { doc: "A list of `**Label:** value` status rows.", teach: WIKI },
};

/** Where an attribute is taught: its own `teach`, else its component's. */
export function attrTeach(name: ComponentName, attr: string): readonly TeachTarget[] {
  const doc = COMPONENT_DOCS[name] as ComponentDoc;
  return doc.attrs?.[attr]?.teach ?? doc.teach;
}
