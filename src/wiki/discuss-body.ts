/**
 * The handoff body Discuss's routes read (`{wiki, relPath, question,
 * selection?, before?, after?, atStart?, atEnd?, edge?, heading?}`), and its
 * parser. Below the routes so the Discuss engine (`discuss-engine.ts`) and
 * both of its entry points share one type (Discuss v2, PR 3).
 */
import {
  HANDOFF_CONTEXT_MAX,
  HANDOFF_HEADING_MAX,
  HANDOFF_QUESTION_MAX,
  HANDOFF_SELECTION_MAX,
} from "./discuss-bounds.ts";

export interface HandoffBody {
  wiki?: string;
  relPath: string;
  question: string;
  selection?: string;
  before?: string;
  after?: string;
  atStart?: boolean;
  atEnd?: boolean;
  edge?: "added" | "reordered";
  heading?: string;
}

/** The body, or the 400 message. The bounds are `discuss-bounds.ts`'s, which
 *  the client and the pack use too; the heading alone is refused at four times
 *  its bound, and the pack cuts it to the bound. */
export function parseHandoffBody(raw: unknown): HandoffBody | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "body must be a JSON object";
  const b = raw as Record<string, unknown>;
  const str = (k: string): string | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" ? v : null;
  };
  const flag = (k: string): boolean | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    return typeof v === "boolean" ? v : null;
  };
  const relPath = str("relPath");
  if (relPath === null) return "relPath must be a string";
  if (!relPath?.trim()) return "relPath is required";
  if (relPath.length > 1024) return "relPath is too long";
  const question = str("question");
  if (question === null) return "question must be a string";
  if (!question?.trim()) return "question is required";
  if (question.length > HANDOFF_QUESTION_MAX) return `question is too long (at most ${HANDOFF_QUESTION_MAX} characters)`;
  const selection = str("selection");
  if (selection === null) return "selection must be a string";
  if (selection !== undefined && !selection.trim()) return "selection is empty (leave it out to ask about the whole page)";
  if (selection !== undefined && selection.trim().length > HANDOFF_SELECTION_MAX) {
    return `selection is too long (at most ${HANDOFF_SELECTION_MAX} characters)`;
  }
  const wiki = str("wiki");
  const heading = str("heading");
  const before = str("before");
  const after = str("after");
  if (wiki === null || heading === null || before === null || after === null) return "wiki, heading, before and after must be strings";
  if ((wiki?.length ?? 0) > 200) return "wiki is too long";
  if ((heading?.length ?? 0) > HANDOFF_HEADING_MAX * 4) return "heading is too long";
  if ((before?.length ?? 0) > HANDOFF_CONTEXT_MAX || (after?.length ?? 0) > HANDOFF_CONTEXT_MAX) {
    return `before and after are at most ${HANDOFF_CONTEXT_MAX} characters`;
  }
  const atStart = flag("atStart");
  const atEnd = flag("atEnd");
  if (atStart === null || atEnd === null) return "atStart and atEnd must be true or false";
  const edge = b.edge;
  if (edge !== undefined && edge !== null && edge !== "added" && edge !== "reordered") return 'edge must be "added" or "reordered"';
  return {
    wiki,
    relPath,
    question,
    selection,
    before,
    after,
    atStart,
    atEnd,
    ...(edge === "added" || edge === "reordered" ? { edge } : {}),
    heading,
  };
}
