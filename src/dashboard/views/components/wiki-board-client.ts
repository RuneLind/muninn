import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const boardClientScript = makeBundledClientScript("wiki-board-browser.ts", import.meta.dir);
