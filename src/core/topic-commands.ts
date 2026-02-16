import type { Thread } from "../db/threads.ts";
import { switchThread, listThreads, getActiveThread, deleteThread, getThreadMessageCount } from "../db/threads.ts";
import { getLog } from "../logging.ts";

const log = getLog("core", "topics");

type Reply = (text: string) => Promise<void>;

/** Handle /topic [name] — show current topic or switch. Returns true if handled. */
export async function handleTopicCommand(
  userId: string, botName: string, arg: string, reply: Reply,
): Promise<void> {
  if (!arg) {
    const active = await getActiveThread(userId, botName);
    const threads = await listThreads(userId, botName);

    if (threads.length === 0) {
      await reply("No topics yet. Messages go to the *main* topic by default.\n\nUse `/topic name` to create and switch.");
      return;
    }

    const current = active?.name ?? "main";
    await reply(
      `Current topic: *${current}*\n\n${formatThreadList(threads)}\n\nSwitch: \`/topic name\``,
    );
    return;
  }

  const thread = await switchThread(userId, botName, arg);
  const count = await getThreadMessageCount(thread.id);

  log.info("User {userId} switched to topic \"{topic}\" ({count} msgs)", { userId, topic: thread.name, count });
  await reply(
    count === 0
      ? `Created and switched to topic: *${thread.name}*\nStarting fresh conversation.`
      : `Switched to topic: *${thread.name}*\n${count} messages in this thread.`,
  );
}

/** Handle /topics — list all topics. */
export async function handleTopicsCommand(
  userId: string, botName: string, reply: Reply,
): Promise<void> {
  const threads = await listThreads(userId, botName);

  if (threads.length === 0) {
    await reply("No topics yet. Use `/topic name` to create one.");
    return;
  }

  await reply(formatThreadList(threads));
}

/** Handle /deltopic <name> — delete a topic. */
export async function handleDelTopicCommand(
  userId: string, botName: string, arg: string, reply: Reply,
): Promise<void> {
  if (!arg) {
    await reply("Usage: `/deltopic name`");
    return;
  }

  if (arg.toLowerCase() === "main") {
    await reply("Cannot delete the *main* topic.");
    return;
  }

  const deleted = await deleteThread(userId, botName, arg);
  if (deleted) {
    log.info("User {userId} deleted topic \"{topic}\"", { userId, topic: arg });
    await reply(`Deleted topic: *${arg}*\nSwitched back to *main*.`);
  } else {
    await reply(`Topic not found: \`${arg}\``);
  }
}

export function formatThreadList(threads: Thread[]): string {
  return threads.map((t) => {
    const marker = t.isActive ? "\u25B6\uFE0F" : "\u25CB";
    const count = t.messageCount ?? 0;
    const ago = formatTimeAgo(t.updatedAt);
    return `${marker} *${escName(t.name)}* — ${count} msgs, ${ago}`;
  }).join("\n");
}

/** Escape markdown-sensitive chars in thread names so *bold* and `code` formatting isn't broken. */
function escName(s: string): string {
  return s.replace(/\*/g, "⁎").replace(/`/g, "ʼ");
}

export function formatTimeAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
