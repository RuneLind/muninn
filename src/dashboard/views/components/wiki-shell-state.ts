/**
 * The /wiki reader's shared state: the lets more than one part of the reader
 * writes, or that the left pane (`wiki-rail-controller.ts`) reads while the shell
 * (`wiki-browser.ts`) writes them. Each has this module as its one owner: a getter
 * and a setter, the `setCurrentRelPath` discipline. Importing this module runs
 * nothing.
 */
import type { IndexWork } from "../../../wiki/work-focus.ts";

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

/** The listing's `workMap.kind === "themes"`: View options then says theme. */
let workMapThemes = false;

export function getWorkMapThemes(): boolean {
  return workMapThemes;
}

export function setWorkMapThemes(themes: boolean): void {
  workMapThemes = themes;
}

/** The work threads off the last listing (`work`), or null: an older server, a
 *  cold sessions memo, or a wiki with no sessions — no section (D11). Not the
 *  "keep the last known value" degrade: stale threads would lift pages the
 *  listing on screen no longer works on. */
export type WorkFacts = (Pick<IndexWork, "threads"> & Partial<Pick<IndexWork, "asOfMs" | "evidence">>) | null;
let workFacts: WorkFacts = null;

export function getWorkFacts(): WorkFacts {
  return workFacts;
}

export function setWorkFacts(facts: WorkFacts): void {
  workFacts = facts;
}
