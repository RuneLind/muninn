import { test, expect, afterEach } from "bun:test";
import {
  runTrackedExtraction,
  waitForPendingExtractions,
  extractionTrackerStats,
} from "./extraction-tracker.ts";

// Module state is shared across tests; drain between them so counts don't leak.
afterEach(async () => {
  await waitForPendingExtractions(2000);
  expect(extractionTrackerStats()).toEqual({ active: 0, queued: 0 });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("tracks an in-flight task and drains when it settles", async () => {
  const d = deferred();
  let done = false;
  runTrackedExtraction(async () => {
    await d.promise;
    done = true;
  });

  await Bun.sleep(10);
  expect(extractionTrackerStats().active).toBe(1);
  expect(done).toBe(false);

  d.resolve();
  await waitForPendingExtractions(2000);
  expect(done).toBe(true);
});

test("caps concurrency at the default of 4 and queues the rest", async () => {
  const MAX = 4;
  const deferreds = Array.from({ length: 8 }, () => deferred());
  let running = 0;
  let maxObserved = 0;
  let completed = 0;

  for (const d of deferreds) {
    runTrackedExtraction(async () => {
      running++;
      maxObserved = Math.max(maxObserved, running);
      await d.promise;
      running--;
      completed++;
    });
  }

  await Bun.sleep(10);
  // Only MAX run; the remaining 4 wait in the queue.
  expect(extractionTrackerStats()).toEqual({ active: MAX, queued: 8 - MAX });
  expect(maxObserved).toBe(MAX);

  // Releasing the first batch lets the queued tasks start, never exceeding MAX.
  for (const d of deferreds) d.resolve();
  await waitForPendingExtractions(2000);

  expect(completed).toBe(8);
  expect(maxObserved).toBe(MAX);
});

test("a rejecting task is swallowed and does not block later tasks", async () => {
  let secondRan = false;
  runTrackedExtraction(async () => {
    throw new Error("boom");
  });
  runTrackedExtraction(async () => {
    secondRan = true;
  });

  await waitForPendingExtractions(2000);
  expect(secondRan).toBe(true);
});

test("a synchronous throw before the first await is caught, not propagated", async () => {
  let nextRan = false;
  // Not an async body — throws synchronously when invoked.
  runTrackedExtraction((() => {
    throw new Error("sync boom");
  }) as () => Promise<void>);
  runTrackedExtraction(async () => {
    nextRan = true;
  });

  await waitForPendingExtractions(2000);
  expect(nextRan).toBe(true);
});

test("waitForPendingExtractions resolves immediately when idle", async () => {
  const start = Date.now();
  await waitForPendingExtractions(5000);
  expect(Date.now() - start).toBeLessThan(200);
});
