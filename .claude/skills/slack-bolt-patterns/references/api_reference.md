# Slack Message API Reference

## chat.postMessage

Post a message to a channel, DM, or thread.

```ts
await client.chat.postMessage({
  channel: string,       // Channel ID (C..., D..., G...)
  text: string,          // Message text (mrkdwn)
  thread_ts?: string,    // Reply in thread
  reply_broadcast?: boolean, // Also show in channel
  unfurl_links?: boolean,
  unfurl_media?: boolean,
});
```

- Triggers notifications in channels/threads
- Use `thread_ts` to reply in a thread
- DM channel IDs start with "D"
- Requires `chat:write` scope (+`chat:write.public` for non-member public channels)

## chat.update

Update a message the bot previously posted.

```ts
await client.chat.update({
  channel: string,  // Channel containing the message
  ts: string,       // Timestamp of message to update
  text: string,     // New message text
});
```

- No `thread_ts` needed — message stays in its thread
- Works identically in DMs and channels
- Bot can only update its **own** messages
- Requires `chat:write` scope
- Cannot update ephemeral messages

## chat.delete

Delete a message the bot previously posted.

```ts
await client.chat.delete({
  channel: string,  // Channel containing the message
  ts: string,       // Timestamp of message to delete
});
```

## chat.postEphemeral

Post a temporary message visible only to one user.

```ts
await client.chat.postEphemeral({
  channel: string,      // Channel ID
  user: string,         // Target user ID
  text: string,         // Message text
  thread_ts?: string,   // Post in thread
});
```

- No push notification
- **Cannot** be updated or deleted via API
- Disappears on reload/app restart
- User must be active in Slack and a member of the channel

## assistant.threads.setStatus

Show native typing/thinking indicator in a thread.

```ts
await client.assistant.threads.setStatus({
  channel_id: string,          // Channel ID (works with C... AND D... channels)
  thread_ts: string,           // Thread timestamp
  status: string,              // Status text (e.g. "thinking...")
  loading_messages?: string[], // Rotating status messages
});
```

- Requires **"Agent or Assistant"** enabled in Slack app settings
- Auto-clears when bot posts a reply in the thread
- Clear manually with `status: ""`
- Display format: `<App Name> <status>`
- No notification triggered

## assistant.threads.setSuggestedPrompts

Show suggested prompts in an assistant thread.

```ts
await client.assistant.threads.setSuggestedPrompts({
  channel_id: string,
  thread_ts: string,
  title?: string,
  prompts: Array<{ title: string, message: string }>,
});
```

## assistant.threads.setTitle

Set the title of an assistant thread.

```ts
await client.assistant.threads.setTitle({
  channel_id: string,
  thread_ts: string,
  title: string,
});
```

## reactions.add / reactions.remove

Add or remove emoji reactions on messages.

```ts
await client.reactions.add({
  channel: string,
  timestamp: string,  // Message ts
  name: string,       // Emoji name without colons
});
```

- Adding same reaction twice is idempotent (no error)
- Does not trigger notifications
