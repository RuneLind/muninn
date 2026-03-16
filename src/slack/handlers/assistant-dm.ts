import { type App, Assistant } from "@slack/bolt";
import type { BotConfig } from "../../bots/config.ts";
import type { SlackMessageHandler } from "./types.ts";
import { resolveSlackUser, makePostToChannel } from "../cache.ts";
import { getActiveThreadId } from "../../db/threads.ts";
import { getLog } from "../../logging.ts";

const log = getLog("slack", "assistant-dm");

/** Create the Slack Assistant API handler (DM sidebar) */
export function createAssistantHandler(app: App, botConfig: BotConfig, handleMessage: SlackMessageHandler): Assistant {
  const bn = botConfig.name;

  return new Assistant({
    threadStarted: async ({ event, say, setSuggestedPrompts }) => {
      const threadEvent = event as { assistant_thread?: { user_id?: string } };
      const startUserId = threadEvent.assistant_thread?.user_id;
      const userName = startUserId
        ? (await resolveSlackUser(app, startUserId)).name
        : undefined;
      const greeting = userName
        ? `Hi ${userName}! How can I help you?`
        : `Hi! How can I help you?`;
      await say(greeting);
      await setSuggestedPrompts({
        prompts: [
          { title: "What can you help me with?", message: "What can you help me with?" },
          { title: "Search for recent Jira issues about authentication", message: "Search for recent Jira issues about authentication" },
          { title: "Summarize the project architecture", message: "Summarize the project architecture" }
        ],
      });
    },

    userMessage: async ({ message, say, setStatus }) => {
      const text = "text" in message ? (message.text ?? "") : "";
      const userId = "user" in message ? (message.user ?? "unknown") : "unknown";

      // Show thinking indicator immediately (before resolving user, building prompt, etc.)
      await setStatus("Tenker...").catch(() => {});

      const userInfo = await resolveSlackUser(app, userId);

      log.info("Assistant message from {username} ({userId}): \"{preview}\"", { botName: bn, username: userInfo.name, userId, preview: text.slice(0, 80) + (text.length > 80 ? "..." : "") });

      const threadId = await getActiveThreadId(userId, botConfig.name);

      await handleMessage({
        text,
        userId,
        username: userInfo.name,
        userIdentity: userInfo,
        say: async (msg: string) => { await say(msg); },
        setStatus: async (status: string) => { await setStatus(status); },
        postToChannel: makePostToChannel(app.client, botConfig.name),
        platform: "slack_assistant",
        threadId,
      });
    },
  });
}
