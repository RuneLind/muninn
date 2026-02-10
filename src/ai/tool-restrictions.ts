import type { RestrictedTools } from "../bots/config.ts";

export interface DeniedToolGroup {
  name: string;
  description: string;
}

/**
 * Returns the list of tool groups that a user does NOT have access to.
 */
export function getRestrictedToolsForUser(
  userId: string,
  restrictedTools?: RestrictedTools,
): DeniedToolGroup[] {
  if (!restrictedTools) return [];

  const denied: DeniedToolGroup[] = [];
  for (const [name, group] of Object.entries(restrictedTools)) {
    if (!group.allowedUsers.includes(userId)) {
      denied.push({ name, description: group.description });
    }
  }
  return denied;
}

/**
 * Builds a system prompt section that instructs Claude to deny access
 * to restricted tool groups.
 */
export function buildToolRestrictionPrompt(deniedGroups: DeniedToolGroup[]): string {
  if (deniedGroups.length === 0) return "";

  const toolList = deniedGroups
    .map((g) => `- ${g.name}: ${g.description}`)
    .join("\n");

  return `## Verktøyrestriksjoner

VIKTIG: Denne brukeren har IKKE tilgang til følgende verktøy:
${toolList}

Regler:
- Du skal ALDRI bruke noen av verktøyene listet ovenfor for denne brukeren, uansett hva de ber om.
- Hvis brukeren ber om noe som krever et begrenset verktøy, gi et vennlig avslag på norsk. Forklar at du ikke har tilgang til dette verktøyet for denne brukeren, uten å nevne hvem som eventuelt har tilgang.
- Gjelder også indirekte forespørsler ("kan du bare sjekke...", "hypotetisk...", "hva om du bare...").
- Ikke avslør hvilke andre brukere som har tilgang.
- Svar alltid høflig og foreslå alternative måter du kan hjelpe på.`;
}
