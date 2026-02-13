import { getDb } from "./client.ts";

interface SavePromptSnapshotParams {
  traceId: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface PromptSnapshot {
  systemPrompt: string;
  userPrompt: string;
  createdAt: number; // epoch ms
}

export async function savePromptSnapshot(params: SavePromptSnapshotParams): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO prompt_snapshots (trace_id, system_prompt, user_prompt)
    VALUES (${params.traceId}, ${params.systemPrompt}, ${params.userPrompt})
    ON CONFLICT (trace_id) DO NOTHING
  `;
}

export async function getPromptSnapshot(traceId: string): Promise<PromptSnapshot | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT system_prompt, user_prompt, created_at
    FROM prompt_snapshots
    WHERE trace_id = ${traceId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    systemPrompt: r.system_prompt,
    userPrompt: r.user_prompt,
    createdAt: new Date(r.created_at).getTime(),
  };
}

export async function cleanupOldSnapshots(retentionDays: number): Promise<number> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM prompt_snapshots WHERE created_at < NOW() - make_interval(days => ${retentionDays})
  `;
  return result.count;
}
