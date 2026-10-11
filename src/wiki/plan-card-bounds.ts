/**
 * The Agent lens's time and queue bounds, in a module the browser bundle can
 * import (`src/wiki/plan-card.ts` reads the filesystem): the route enforces
 * them, and the pane sizes its deadline from them.
 */
import { RUN_PROC_KILL_GRACE_MS, RUN_PROC_POST_KILL_WAIT_MS } from "../utils/run-proc-bounds.ts";

/** The route's bound on one child (D7). plan-card's own worst case is about
 *  12 s: two muninn calls at 3 s and up to three claude-usage hosts at 3 s. */
export const PLAN_CARD_TIMEOUT_MS = 20_000;

/** Argument sets that may wait behind a page's running child; one more is 429. */
export const PLAN_CARD_MAX_WAITING = 2;

/** One child at worst: the timeout, the SIGKILL grace, and the wait for the
 *  exit after it, which is when `runProc` settles and the next run may start. */
export const PLAN_CARD_RUN_MAX_MS = PLAN_CARD_TIMEOUT_MS + RUN_PROC_KILL_GRACE_MS + RUN_PROC_POST_KILL_WAIT_MS;

/** The pane's deadline: a request admitted to the queue waits behind at most
 *  {@link PLAN_CARD_MAX_WAITING} runs (the running one and one other), then
 *  runs its own; 5 s on top for the page lookup and the response. 74 s. */
export const PLAN_CARD_CLIENT_DEADLINE_MS = (PLAN_CARD_MAX_WAITING + 1) * PLAN_CARD_RUN_MAX_MS + 5_000;
