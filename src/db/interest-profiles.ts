import { getDb } from "./client.ts";

/** Input counts recorded on refresh — observability into what shaped the profile. */
export interface InterestProfileDerivedFrom {
  goals: number;
  memories: number;
}

export interface InterestProfile {
  userId: string;
  botName: string;
  /** Rendered bullet text injected into watcher gate/capture prompts. */
  profile: string;
  derivedFrom: InterestProfileDerivedFrom;
  updatedAt: number; // epoch ms
}

function mapRow(r: Record<string, any>): InterestProfile {
  return {
    userId: r.user_id,
    botName: r.bot_name,
    profile: r.profile,
    derivedFrom: (r.derived_from ?? {}) as InterestProfileDerivedFrom,
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

/** Fetch the stored interest profile for a (user, bot), or null when none exists. */
export async function getInterestProfile(userId: string, botName: string): Promise<InterestProfile | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT user_id, bot_name, profile, derived_from, updated_at
    FROM interest_profiles
    WHERE user_id = ${userId} AND bot_name = ${botName}
  `;
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

interface UpsertInterestProfileParams {
  userId: string;
  botName: string;
  profile: string;
  derivedFrom: InterestProfileDerivedFrom;
}

/** Insert or replace the (user, bot) profile, bumping updated_at to now(). */
export async function upsertInterestProfile(params: UpsertInterestProfileParams): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO interest_profiles (user_id, bot_name, profile, derived_from, updated_at)
    VALUES (${params.userId}, ${params.botName}, ${params.profile}, ${sql.json(params.derivedFrom as any)}, now())
    ON CONFLICT (user_id, bot_name) DO UPDATE SET
      profile = EXCLUDED.profile,
      derived_from = EXCLUDED.derived_from,
      updated_at = now()
  `;
}

/**
 * True when the (user, bot) profile is missing OR older than `days` days — the
 * scheduler's refresh predicate. A missing row is stale (needs a first build).
 */
export async function isProfileStale(userId: string, botName: string, days = 7): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    SELECT updated_at > now() - ${days + " days"}::interval AS fresh
    FROM interest_profiles
    WHERE user_id = ${userId} AND bot_name = ${botName}
  `;
  if (rows.length === 0) return true; // no profile yet → stale
  return !rows[0]!.fresh;
}
