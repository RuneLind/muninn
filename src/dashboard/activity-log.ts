import type { ActivityEvent, ActivityEventType } from "../types.ts";

type Subscriber = (event: ActivityEvent) => void;

const MAX_EVENTS = 500;

class ActivityLog {
  private events: ActivityEvent[] = [];
  private subscribers = new Set<Subscriber>();

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

  get stats() {
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayEvents = this.events.filter((e) => e.timestamp >= todayStart);

    const messagesToday = todayEvents.filter(
      (e) => e.type === "message_in",
    ).length;

    const responses = this.events.filter(
      (e) => e.type === "message_out" && e.durationMs,
    );
    const avgResponseTime =
      responses.length > 0
        ? responses.reduce((sum, e) => sum + (e.durationMs || 0), 0) /
          responses.length
        : 0;

    const totalCost = this.events.reduce(
      (sum, e) => sum + (e.costUsd || 0),
      0,
    );

    return { messagesToday, avgResponseTime, totalCost, totalEvents: this.events.length };
  }
}

export const activityLog = new ActivityLog();
