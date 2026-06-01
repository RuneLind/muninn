import type { ActivityEvent, ActivityEventType } from "../types.ts";
import { saveActivity, getRecentActivity } from "../db/activity.ts";
import { getLog } from "../logging.ts";

const log = getLog("observability", "activity");

type Subscriber = (event: ActivityEvent) => void;

const MAX_EVENTS = 500;

export interface ActivityStats {
  messagesToday: number;
  avgResponseTime: number;
  totalCost: number;
  totalEvents: number;
}

/** Pure stats reducer over an event buffer. `totalCost` is scoped to today's
 *  events (not all-time) so the dashboard "cost today" figure doesn't grow
 *  unbounded with the in-memory ring buffer. Extracted for testability. */
export function computeStats(events: ActivityEvent[], todayStart: number): ActivityStats {
  const todayEvents = events.filter((e) => e.timestamp >= todayStart);

  const messagesToday = todayEvents.filter((e) => e.type === "message_in").length;

  const responses = events.filter((e) => e.type === "message_out" && e.durationMs);
  const avgResponseTime =
    responses.length > 0
      ? responses.reduce((sum, e) => sum + (e.durationMs || 0), 0) / responses.length
      : 0;

  const totalCost = todayEvents.reduce((sum, e) => sum + (e.costUsd || 0), 0);

  return { messagesToday, avgResponseTime, totalCost, totalEvents: events.length };
}

class ActivityLog {
  private events: ActivityEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private dbReady = false;

  /** Call after DB is initialized to load persisted events */
  async loadFromDb(): Promise<void> {
    try {
      const persisted = await getRecentActivity(MAX_EVENTS);
      this.events = persisted;
      this.dbReady = true;
    } catch (err) {
      log.error("Failed to load activity from DB: {error}", { error: err instanceof Error ? err.message : String(err) });
      this.dbReady = true; // still allow writes
    }
  }

  push(type: ActivityEventType, text: string, extra?: Partial<ActivityEvent>) {
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      type,
      timestamp: Date.now(),
      text,
      ...extra,
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }

    for (const sub of this.subscribers) {
      sub(event);
    }

    // Write-through to DB (fire and forget)
    if (this.dbReady) {
      saveActivity({
        type: event.type,
        userId: event.userId,
        username: event.username,
        botName: event.botName,
        text: event.text,
        durationMs: event.durationMs,
        costUsd: event.costUsd,
        metadata: event.metadata,
      }).catch((err) => {
        log.error("Failed to persist activity event: {error}", { error: err instanceof Error ? err.message : String(err) });
      });
    }

    return event;
  }

  getRecent(count = 50): ActivityEvent[] {
    return this.events.slice(-count);
  }

  getAll(): ActivityEvent[] {
    return [...this.events];
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get stats(): ActivityStats {
    return computeStats(this.events, new Date().setHours(0, 0, 0, 0));
  }
}

export const activityLog = new ActivityLog();
