import type { App } from "@slack/bolt";
import { getLog } from "../logging.ts";

const log = getLog("slack", "registry");

/** Global registry of Slack apps by bot name — used by watcher runner for proactive posting */
const slackApps = new Map<string, App>();

export function registerSlackApp(botName: string, app: App): void {
  slackApps.set(botName, app);
  log.info("Registered Slack app for \"{botName}\"", { botName });
}

export function getSlackApp(botName: string): App | undefined {
  return slackApps.get(botName);
}

export function unregisterSlackApp(botName: string): void {
  slackApps.delete(botName);
}

export function getAllSlackApps(): App[] {
  return [...slackApps.values()];
}
