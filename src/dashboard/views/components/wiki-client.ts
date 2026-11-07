import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const wikiClientScript = makeBundledClientScript("wiki-shell-client.ts", import.meta.dir);
