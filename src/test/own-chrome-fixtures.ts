import type { ComponentName } from "../format/markdown-ast.ts";

/**
 * One markdown fixture per component that owns its own fence chrome.
 *
 * ONE map, because there were three: the unit guard's, the e2e own-chrome case's
 * and `withFence` in `code-block-chrome.test.ts`. (The first version of this
 * module said all three were merged while `withFence` was still a copy — which
 * is exactly the drift below, inside the file documenting it.) `COMPONENT_FENCE_CHROME`
 * (`dashboard/views/components/code-block-chrome.ts`) is a `Record` precisely so
 * a new chrome-owning component cannot be forgotten — and hand-listing its
 * fixtures in each test rebuilt the forgettable list one layer up, which is the
 * failure that Record has already had twice.
 *
 * Keyed by `ComponentName`, so the unit guard's coverage assertion — every entry
 * in the Record with a non-null selector has a fixture here — makes a missing one
 * a red test rather than a silently skipped component.
 *
 * ⚠️ `AnnotatedCode` carries `file="…"` deliberately. Without it the renderer
 * emits no `annotated-code-file` header, and that attribute-less fixture is what
 * hid the missing `annotated-code-file` allowlist entry for a whole review round.
 * A fixture that exercises fewer of a component's branches than the component
 * has is a fixture that can pass while the component is broken.
 *
 * Dependency-free apart from the `ComponentName` TYPE, which is erased at build:
 * both a `bun test` and a Playwright spec import this without dragging a renderer
 * or the DOM into the other's process. The key type is not decoration — a typo'd
 * key would otherwise be a silent coverage hole rather than a compile error.
 */
export const OWN_CHROME_FIXTURES: Partial<Record<ComponentName, string>> = {
  CodeTabs: '<CodeTabs>\n<Tab label="a">\n\n```ts\nconst x = 1;\n```\n\n</Tab>\n</CodeTabs>',
  // A <Tab> OUTSIDE a <CodeTabs> renders its own labelled box — the fourth
  // selector in the Record, and the one that had no fixture at all until now.
  Tab: '<Tab label="a">\n\n```ts\nconst x = 1;\n```\n\n</Tab>',
  AnnotatedCode:
    '<AnnotatedCode file="src/index.ts">\n\n```ts\nconst x = 1;\n```\n\nA note.\n\n</AnnotatedCode>',
  FileTree: "<FileTree>\n\n```\nsrc/\n  index.ts\n```\n\n</FileTree>",
};

/**
 * A component that owns NO chrome, as the control: its fence must still GET a
 * bar, so a test asserting "no bar" everywhere cannot pass by having turned the
 * enhancer off. A `<Callout>` holding code is prose around code.
 */
export const NO_OWN_CHROME_FIXTURE = '<Callout tone="info" title="t">\n\n```ts\nconst x = 1;\n```\n\n</Callout>';
