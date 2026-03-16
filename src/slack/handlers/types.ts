import type { Platform, UserIdentity } from "../../types.ts";

export interface HandleSlackMessageParams {
  text: string;
  userId: string;
  username: string;
  /** Enriched user identity from Slack profile (name, display name, title) */
  userIdentity?: UserIdentity;
  say: (message: string) => Promise<any>;
  setStatus: (status: string) => Promise<void>;
  /** If provided, Claude can post messages to Slack channels via <slack-post> directives */
  postToChannel?: (channel: string, message: string) => Promise<void>;
  /** Channel name/context for the current conversation (e.g. "#general") */
  channelContext?: string;
  /** Recent messages from the channel/thread for context (when responding to @mentions) */
  recentChannelMessages?: string[];
  /** Platform identifier for analytics (e.g. 'slack_dm', 'slack_channel', 'slack_assistant') */
  platform?: Platform;
  /** Thread ID for conversation isolation (resolved by caller) */
  threadId?: string;
}

export type SlackMessageHandler = (params: HandleSlackMessageParams) => Promise<void>;
