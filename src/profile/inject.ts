/**
 * Interest-profile prompt injection (anti-filter-bubble guard).
 *
 * The watcher gate/capture prompts carry a hardcoded BASELINE of topics (e.g.
 * "a senior AI engineer who lives in Claude Code…"). This helper APPENDS a
 * clearly-delimited section describing the user's own current interests so the
 * gate can also weight those — but the wording is explicit that the profile
 * AUGMENTS and never narrows the baseline: the baseline topics always qualify
 * on their own. Pure function, no deps — unit-testable in isolation.
 *
 * With no profile (null/blank) the base prompt is returned verbatim, so a bot
 * with no interest profile yet behaves exactly as it did before this feature.
 *
 * The base prompts END with an output-format contract ("Return ONLY a JSON
 * array…", "respond with exactly: SKIP"); appending prose after it would leave
 * augmentation text as the last thing the model reads. The trailing
 * re-assertion line keeps the format contract binding.
 */
export function withInterestProfile(basePrompt: string, profile: string | null | undefined): string {
  if (!profile || !profile.trim()) return basePrompt;
  return `${basePrompt}

---
Additionally, this user's current interests (from their goals + memories). AUGMENT the criteria above with these — do NOT narrow them: every baseline topic still qualifies on its own, and an item matching the baseline must never be dropped for failing to match the interests below. Treat these as extra signals that can RAISE relevance, not filters that lower it:
${profile.trim()}

The output-format instructions above still apply exactly — respond in that format only.`;
}
