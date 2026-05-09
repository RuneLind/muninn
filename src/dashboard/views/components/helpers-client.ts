import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const helpersClientScript = makeBundledClientScript("helpers-browser.ts", import.meta.dir);
