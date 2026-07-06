import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const wikiClientScript = makeBundledClientScript("wiki-browser.ts", import.meta.dir);
