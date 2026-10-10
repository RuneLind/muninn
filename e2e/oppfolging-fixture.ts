/**
 * The «Oppfølging» page the role-lane specs share (reader lenses PR 3): a
 * Norwegian wiki with `roleKeys`, a `you` lane for utvikler, a waiting lane for
 * fag naming two `<Question>` cards (written below a line of prose, so they
 * leave one merged stub), a who-only lane and a blocked lane.
 * Synthetic text only.
 */

export const ROLE_REL = "plans/oppfolging.mdx";

export const ROLE_READER_CONFIG = JSON.stringify({ language: "no", roleKeys: ["fag", "utvikler"], include: ["plans/**"] });

export const ROLE_PAGE = [
  "---",
  "title: Oppfølgingsside",
  'questions_to: ["fag"]',
  "---",
  "",
  "# Oppfølgingsside",
  "",
  "<NextMoves>",
  "",
  '<Lane kind="you" role="utvikler">',
  "",
  "1. **Send melding 3 til fag.** Den retter en feil i melding 1.",
  "2. **Opprett oppgave 2.**",
  "",
  "</Lane>",
  "",
  '<Lane kind="waiting" role="fag" since="07.10.2026">',
  "",
  "- **S1** — alternativ A eller B for brevet?",
  "- **S2** — hvilket brev gjelder det?",
  "",
  "</Lane>",
  "",
  '<Lane kind="waiting" who="Venter på jus">',
  "",
  "- Ingen svar ennå.",
  "",
  "</Lane>",
  "",
  '<Lane kind="blocked" role="utvikler">',
  "",
  "- Person 1404 venter på oppgave 3.",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  // Prose between the block and the cards: they leave one merged line (D39).
  "Bakgrunnen for spørsmålene står her.",
  "",
  '<Question id="S1" choices="A|B" to="fag">',
  "",
  "Alternativ A eller B?",
  "",
  "</Question>",
  "",
  '<Question id="S2" to="fag">',
  "",
  "Hvilket brev?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **S1** — åpent spørsmål om alternativ.",
  "- **S2** — åpent spørsmål om brev.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

/** The authored lane order, as `data-role` (or `-` for the who-only lane). */
export const AUTHORED_ROLES = ["utvikler", "fag", "-", "utvikler"];
