import type { BotConfig, ChannelListeningConfig } from "../bots/config.ts";
import { spawnHaiku } from "../scheduler/executor.ts";

interface RelevanceResult {
  relevant: boolean;
  confidence?: "low" | "medium" | "high";
  reason?: string;
  skippedReason?: string;
}

const CHANNEL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class RelevanceFilter {
  /** channel → activation timestamp */
  private activeChannels = new Map<string, number>();
  /** channel → last response timestamp (cooldown) */
  private lastResponseTime = new Map<string, number>();
  /** timestamps of recent responses (rate limiting) */
  private responseTimestamps: number[] = [];

  private config: Required<Omit<ChannelListeningConfig, "topicHints">> & { topicHints: string[] };
  private botConfig: BotConfig;

  constructor(botConfig: BotConfig) {
    this.botConfig = botConfig;
    const cl = botConfig.channelListening ?? { enabled: false };
    this.config = {
      enabled: cl.enabled,
      cooldownMs: cl.cooldownMs ?? 120_000,
      maxResponsesPerHour: cl.maxResponsesPerHour ?? 10,
      relevanceThreshold: cl.relevanceThreshold ?? "medium",
      contextMessages: cl.contextMessages ?? 10,
      topicHints: cl.topicHints ?? [],
    };
  }

  activateChannel(channelId: string): void {
    this.activeChannels.set(channelId, Date.now());
    // Prune expired channels
    if (this.activeChannels.size > 100) {
      const cutoff = Date.now() - CHANNEL_TTL_MS;
      for (const [id, ts] of this.activeChannels) {
        if (ts < cutoff) this.activeChannels.delete(id);
      }
    }
  }

  isChannelActive(channelId: string): boolean {
    const ts = this.activeChannels.get(channelId);
    if (!ts) return false;
    if (Date.now() - ts > CHANNEL_TTL_MS) {
      this.activeChannels.delete(channelId);
      return false;
    }
    return true;
  }

  recordResponse(channelId: string): void {
    this.lastResponseTime.set(channelId, Date.now());
    this.responseTimestamps.push(Date.now());
  }

  async checkRelevance(
    text: string,
    username: string,
    channelId: string,
    recentMessages: string[],
  ): Promise<RelevanceResult> {
    // Heuristic pre-filters
    const heuristic = this.heuristicCheck(text);
    if (heuristic) return { relevant: false, skippedReason: heuristic };

    // Rate limiting
    const rateCheck = this.rateLimitCheck(channelId);
    if (rateCheck) return { relevant: false, skippedReason: rateCheck };

    // Haiku relevance check
    return this.haikuRelevanceCheck(text, username, recentMessages);
  }

  private heuristicCheck(text: string): string | null {
    if (text.length < 10) return "too short";

    // Only URL(s)
    const stripped = text.replace(/https?:\/\/\S+/g, "").trim();
    if (!stripped) return "only URLs";

    // Only emoji (unicode emoji or Slack :emoji: syntax)
    const noEmoji = text
      .replace(/:[a-z0-9_+-]+:/g, "")
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
      .trim();
    if (!noEmoji) return "only emoji";

    return null;
  }

  private rateLimitCheck(channelId: string): string | null {
    // Per-channel cooldown
    const lastResponse = this.lastResponseTime.get(channelId);
    if (lastResponse && Date.now() - lastResponse < this.config.cooldownMs) {
      return "cooldown";
    }

    // Global hourly rate limit
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.responseTimestamps = this.responseTimestamps.filter((ts) => ts > oneHourAgo);
    if (this.responseTimestamps.length >= this.config.maxResponsesPerHour) {
      return "rate limit";
    }

    return null;
  }

  private async haikuRelevanceCheck(
    text: string,
    username: string,
    recentMessages: string[],
  ): Promise<RelevanceResult> {
    // Build a summary of persona for the prompt (first 500 chars)
    const personaSummary = this.botConfig.persona.slice(0, 500);

    const topicHintsLine = this.config.topicHints.length > 0
      ? `\nDomain keywords: ${this.config.topicHints.join(", ")}`
      : "";

    const contextBlock = recentMessages.length > 0
      ? recentMessages.join("\n")
      : "(no recent messages)";

    const prompt = `You are a relevance classifier for a Slack bot named ${this.botConfig.name}.
The bot's domain: ${personaSummary}${topicHintsLine}

The bot has been invited to participate in this channel. Below is the recent
conversation context followed by the latest message. Decide if the bot should
respond to the LATEST message.

RESPOND when: The message asks a question, raises a topic, or starts a discussion
that matches the bot's expertise. The bot can add genuine value.
DON'T RESPOND when: Greetings, small talk, lunch/logistics, messages that are
clearly a private exchange between people, topics outside the bot's domain.

Relevance threshold: ${this.config.relevanceThreshold}
${this.config.relevanceThreshold === "low" ? "Be generous — respond to anything vaguely related." : ""}
${this.config.relevanceThreshold === "high" ? "Be strict — only respond to clearly relevant questions." : ""}

Recent channel context:
${contextBlock}

Latest message from ${username}:
"${text}"

Respond with ONLY valid JSON:
{"relevant": false}
or
{"relevant": true, "confidence": "high", "reason": "Brief reason"}`;

    try {
      const { result } = await spawnHaiku(prompt, "relevance", "javrvis-relevance", this.botConfig.dir, this.botConfig.name);

      // Parse JSON from the response — handle potential markdown wrapping
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn(`[${this.botConfig.name}/relevance] Could not parse Haiku response: ${result.slice(0, 200)}`);
        return { relevant: false, skippedReason: "parse error" };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.relevant) {
        return {
          relevant: true,
          confidence: parsed.confidence ?? "medium",
          reason: parsed.reason ?? "relevant",
        };
      }
      return { relevant: false, skippedReason: "not relevant" };
    } catch (err) {
      console.error(`[${this.botConfig.name}/relevance] Haiku error:`, err);
      return { relevant: false, skippedReason: "haiku error" };
    }
  }
}
