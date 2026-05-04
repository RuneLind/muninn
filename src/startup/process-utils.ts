import { $ } from "bun";

/**
 * `pgrep -f <pattern>` returning the matching PIDs as numbers, with empty
 * stdout (no matches) yielding an empty array. Shared between the startup
 * adapter audit and the cleanup script so both apply the same matching rules.
 */
export async function pgrep(pattern: string): Promise<number[]> {
  const out = await $`pgrep -f ${pattern}`.nothrow().text();
  return out.trim().split("\n").filter(Boolean).map(Number);
}
