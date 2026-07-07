import type { Context } from "grammy";
import type { ReactionType } from "grammy/types";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { getMessageByTelegramId } from "../db/messages.ts";
import { upsertFeedback, deleteFeedback } from "../db/message-feedback.ts";
import { getLog } from "../logging.ts";

const log = getLog("bot", "reaction");

// Positive / negative emoji sets. ❤ is included both with and without the
// U+FE0F variation selector because Telegram may send either form.
const POSITIVE = new Set(["👍", "❤️", "❤", "🔥", "👏", "💯"]);
const NEGATIVE = new Set(["👎", "💩", "🤮"]);

/** Map a reaction emoji to a feedback value. Returns null for any emoji outside
 *  the known positive/negative sets (no value 0 exists). */
export function mapReactionEmojiToValue(emoji: string): 1 | -1 | null {
  if (POSITIVE.has(emoji)) return 1;
  if (NEGATIVE.has(emoji)) return -1;
  return null;
}

/** First MAPPABLE plain-emoji reaction in a reaction list — e.g. [🎉, 👍] must
 *  yield 👍/+1, not stop at the unmapped 🎉. Returns null when the list has no
 *  classifiable emoji at all (only unknown emojis and/or custom/paid reactions). */
export function firstMappableReaction(reactions: ReactionType[]): { emoji: string; value: 1 | -1 } | null {
  for (const r of reactions) {
    if (r.type !== "emoji") continue;
    const value = mapReactionEmojiToValue(r.emoji);
    if (value !== null) return { emoji: r.emoji, value };
  }
  return null;
}

/**
 * Telegram `message_reaction` handler. Resolves the reacted-to Telegram message
 * back to the assistant DB row we stamped when sending it, maps the reaction to a
 * +1/-1 signal, and upserts feedback. When the new reaction list carries NO
 * mappable signal — empty (retraction) or only unknown/custom emojis (the user
 * changed 👍 to 🎉) — any previously recorded vote is stale, so the row is
 * deleted rather than left standing.
 *
 * Auth is handled upstream by createAuthMiddleware (bot.use) — only allowed user
 * ids reach this handler.
 */
export function createReactionHandler(_config: Config, botConfig: BotConfig) {
  return async (ctx: Context) => {
    const reaction = ctx.messageReaction;
    if (!reaction) return;
    if (!ctx.from?.id) return; // anonymous reactions carry no user to attribute

    const chatId = reaction.chat.id;
    const telegramMessageId = reaction.message_id;

    const owner = await getMessageByTelegramId(chatId, telegramMessageId);
    if (!owner) {
      // Reaction on an untracked message (the user's own message, or a reply we
      // never stamped). Nothing to attribute.
      log.debug("Reaction on untracked message {chatId}/{messageId}", {
        botName: botConfig.name, chatId, messageId: telegramMessageId,
      });
      return;
    }

    const userId = String(ctx.from.id);
    const newReactions = reaction.new_reaction ?? [];

    const mapped = firstMappableReaction(newReactions);
    if (!mapped) {
      // Retraction (empty list) or a switch to only-unmappable reactions —
      // either way the current reaction carries no vote, so clear any prior one.
      await deleteFeedback(owner.id, userId, "telegram_reaction");
      log.debug("Feedback cleared for message {messageId} ({count} unmappable reactions)", {
        botName: botConfig.name, messageId: owner.id, count: newReactions.length,
      });
      return;
    }

    await upsertFeedback({
      messageId: owner.id,
      userId,
      botName: botConfig.name,
      platform: "telegram",
      source: "telegram_reaction",
      value: mapped.value,
      raw: mapped.emoji,
    });
    log.info("Reaction feedback {value} ({emoji}) on message {messageId}", {
      botName: botConfig.name, value: mapped.value, emoji: mapped.emoji, messageId: owner.id,
    });
  };
}
