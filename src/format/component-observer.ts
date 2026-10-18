/**
 * The seam through which the block parser and the inline scanner report the
 * component tags they read (`markdown-ast.ts`), for the wiki linter's author
 * check (`src/wiki/lint-components.ts`). A module of its own so the generic
 * block walker (`block-renderer.ts`, which `markdown-ast.ts` imports) can scope
 * reports without an import cycle.
 *
 * The contract: one report per tag the EMITTED render reads. Two render shapes
 * would break it, and each has its own rule here:
 *
 *  - a probe render whose output is compared, never emitted (a DecisionLog
 *    split guard), runs under {@link withoutComponentTags};
 *  - a component that re-renders its children instead of emitting the copy the
 *    walker rendered for it (`foldBodyHtml`, the DecisionLog item text) is
 *    scoped by {@link observeComponentScope}: per tag, the larger count of the
 *    two renders is reported, since the component emits one of them.
 */

import type { ComponentName } from "./component-spec.ts";

/**
 * One component tag the parser or the inline scanner actually read: the name,
 * the RAW attribute string before `parseAttrs` drops unlisted attributes, and,
 * on a `Lane`, whether it is a lane of a `NextMoves` block.
 */
export interface ObservedComponentTag {
  name: ComponentName;
  rawAttrs: string;
  inline: boolean;
  inNextMoves?: true;
}

type Observer = (tag: ObservedComponentTag) => void;

/** Set only for the length of one {@link observeComponentTags} call. */
let current: Observer | null = null;

/** True while a caller observes; the report sites test it before they build a tag. */
export function observingComponentTags(): boolean {
  return current !== null;
}

export function reportComponentTag(tag: ObservedComponentTag): void {
  if (current !== null) current(tag);
}

/** Run `fn` with `observer` as the current observer; the previous one comes back in a `finally`. */
function withObserver<T>(observer: Observer | null, fn: () => T): T {
  const prev = current;
  current = observer;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/**
 * Run `fn` with `observer` told about every component tag `tryParseComponent`
 * accepts and every tag `scanInlineComponents` matches. Synchronous, like
 * `formatWebHtml`'s `files` slot. The wiki linter's author check is the caller:
 * the renderer decides which tags count.
 */
export function observeComponentTags<T>(observer: Observer, fn: () => T): T {
  return withObserver(observer, fn);
}

/** Run a probe render (one whose output is compared, not emitted) with no
 *  observer, so the tags it reads in a fragment of the page are not reported. */
export function withoutComponentTags<T>(fn: () => T): T {
  return current === null ? fn() : withObserver(null, fn);
}

const tagKey = (t: ObservedComponentTag) => `${t.name}\u0000${t.inline}\u0000${t.inNextMoves ?? ""}\u0000${t.rawAttrs}`;

/**
 * A component block's render: `children` is the walker's render of its body,
 * `wrap` the component's own, which may emit that string or render the same
 * body again. Each render's reports are buffered, then every tag of the first
 * is reported and, of the second, each tag past the count the first already
 * reported. Two identical tags in one render stay two.
 */
export function observeComponentScope<T>(children: () => string, wrap: (rendered: string) => T): T {
  if (current === null) return wrap(children());
  const outer = current;
  const first: ObservedComponentTag[] = [];
  const second: ObservedComponentTag[] = [];
  const rendered = withObserver((t) => first.push(t), children);
  const out = withObserver((t) => second.push(t), () => wrap(rendered));
  const counts = new Map<string, number>();
  for (const t of first) {
    counts.set(tagKey(t), (counts.get(tagKey(t)) ?? 0) + 1);
    outer(t);
  }
  for (const t of second) {
    const k = tagKey(t);
    const left = counts.get(k) ?? 0;
    if (left > 0) counts.set(k, left - 1);
    else outer(t);
  }
  return out;
}
