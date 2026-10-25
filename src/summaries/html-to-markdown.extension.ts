/**
 * The X extension's entry for the shared walk: `bun run build:extension`
 * bundles this as an IIFE into `extensions/x-article/html-to-markdown.js`,
 * which the manifest loads before `content.js`.
 *
 * A wrapper, because Bun's IIFE format does not export to the global and the
 * server-side module stays free of side effects.
 */

import { htmlToMarkdown } from "./html-to-markdown.ts";

(globalThis as { muninnHtmlToMarkdown?: typeof htmlToMarkdown }).muninnHtmlToMarkdown = htmlToMarkdown;
