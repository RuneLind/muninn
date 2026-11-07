/**
 * The /wiki reader's shared state: the lets that two or more modules write
 * (the shell `wiki-browser.ts` and a controller). Each has this module as its
 * one owner: a getter and a setter, the `setCurrentRelPath` discipline. A let
 * one module writes stays in that module (`src/dashboard/CLAUDE.md`).
 * Importing this module runs nothing.
 */
import type { IndexWork } from "../../../wiki/work-focus.ts";

/** Set by every page navigation that lands (the shell), cleared by the first
 *  `renderList` that has a listing to draw (the rail): that render scrolls the
 *  open page's row into view. Normally set and consumed in the same render; it
 *  waits only when the boot listing failed and a later refetch heals it. */
let revealOnRender = false;

export function getRevealOnRender(): boolean {
  return revealOnRender;
}

export function setRevealOnRender(on: boolean): void {
  revealOnRender = on;
}

/** The open page's name: assigned from the page response, cleared with it. */
let currentName: string | null = null;

export function getCurrentName(): string | null {
  return currentName;
}

export function setCurrentName(name: string | null): void {
  currentName = name;
}

/** The listing's `workMap.runAt` — set on a wiki with a work map, which
 *  shows the Your work card instead of What's new (`wiki-start-cards.ts`). */
let workMapRunAt: number | null = null;

export function getWorkMapRunAt(): number | null {
  return workMapRunAt;
}

export function setWorkMapRunAt(runAt: number | null): void {
  workMapRunAt = runAt;
}

/** The work threads off the last listing (`work`), or null. The value is the
 *  shell's (one writer); the type lives here because the rail and the ⋯ menus
 *  read it through their ports. */
export type WorkFacts = (Pick<IndexWork, "threads"> & Partial<Pick<IndexWork, "asOfMs" | "evidence">>) | null;
