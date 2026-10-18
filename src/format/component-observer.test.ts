import { describe, expect, test } from "bun:test";
import { observeComponentScope, observeComponentTags, reportComponentTag, withoutComponentTags, type ObservedComponentTag } from "./component-observer.ts";

const pill = (rawAttrs: string): ObservedComponentTag => ({ name: "Pill", rawAttrs, inline: true });
const names = (seen: ObservedComponentTag[]) => seen.map((t) => t.rawAttrs);

describe("observeComponentScope", () => {
  test("a component that re-renders its body reports each tag once", () => {
    const seen: ObservedComponentTag[] = [];
    observeComponentTags((t) => seen.push(t), () =>
      observeComponentScope(
        () => (reportComponentTag(pill(' tone="a"')), "x"),
        () => reportComponentTag(pill(' tone="a"')),
      ),
    );
    expect(names(seen)).toEqual([' tone="a"']);
  });

  test("two identical tags in one render stay two, and a tag only the component reads is kept", () => {
    const seen: ObservedComponentTag[] = [];
    observeComponentTags((t) => seen.push(t), () =>
      observeComponentScope(
        () => (reportComponentTag(pill(' tone="a"')), reportComponentTag(pill(' tone="a"')), "x"),
        () => (reportComponentTag(pill(' tone="a"')), reportComponentTag(pill(' tone="b"'))),
      ),
    );
    expect(names(seen)).toEqual([' tone="a"', ' tone="a"', ' tone="b"']);
  });

  test("the component gets the walked body", () => {
    expect(observeComponentScope(() => "body", (r) => `<${r}>`)).toBe("<body>");
  });
});

describe("withoutComponentTags", () => {
  test("a probe reports nothing, and the observer comes back after it", () => {
    const seen: ObservedComponentTag[] = [];
    observeComponentTags((t) => seen.push(t), () => {
      withoutComponentTags(() => reportComponentTag(pill(' tone="probe"')));
      reportComponentTag(pill(' tone="emitted"'));
    });
    expect(names(seen)).toEqual([' tone="emitted"']);
  });
});
