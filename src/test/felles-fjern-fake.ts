/**
 * A stand-in for `publiser-felles-wiki.ts --fjern --ja` over an in-memory
 * bucket, printing the script's own lines (`fjern()`, muninn-nais): `vil
 * slette`, `sletter`, `slettet` on stdout, `Feil: sletting av … feilet (exit
 * N): <masked last stderr line>` on stderr, the `Oppsummering:` line, exit 3 on
 * any failed object. gcloud's failures are its real texts: «not in the bucket»
 * is `The following URLs matched no objects or files:` with the URL on the
 * next line (gcloud 589 `name_expansion.py`), and a logged-out gcloud's
 * `$ gcloud auth login` hint, which the script swaps for its own sentence.
 * The empirical pass runs the real script's `kjør` against the same fake
 * gcloud and compares the two outputs byte for byte.
 */
export const FAKE_BUCKET = "felles-test";

/** gcloud's stderr for an object the bucket does not hold. */
export const gcloudNotFound = (bucket: string, object: string) =>
  `Removing objects:\nERROR: (gcloud.storage.rm) The following URLs matched no objects or files:\ngs://${bucket}/${object}\n`;

/** gcloud's stderr with no active account. */
export const GCLOUD_LOGGED_OUT =
  "ERROR: (gcloud.storage.rm) You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials.\n";

/** gcloud's stderr when the bucket cannot be reached. */
export const GCLOUD_NETWORK =
  "ERROR: (gcloud.storage.rm) HTTPSConnectionPool(host='storage.googleapis.com', port=443): Max retries exceeded with url: /storage/v1/b/felles-test/o (Caused by NewConnectionError)\n";

/** A fake `gcloud storage rm gs://<bucket>/<object>`: `fail` answers first. */
export function fakeGcloudRm(
  bucket: Set<string>,
  fail?: (object: string) => string | null,
): (object: string) => { exitCode: number; stdout: string; stderr: string } {
  return (object) => {
    const err = fail?.(object) ?? null;
    if (err !== null) return { exitCode: 1, stdout: "", stderr: err };
    if (bucket.delete(object)) return { exitCode: 0, stdout: "", stderr: `Removing objects:\nRemoving gs://${FAKE_BUCKET}/${object}...\n` };
    return { exitCode: 1, stdout: "", stderr: gcloudNotFound(FAKE_BUCKET, object) };
  };
}

/** The script's `maskerGcloud` for a name with no scanner finding. */
function maskLast(stderr: string): string {
  if (/\$ gcloud auth login/.test(stderr)) {
    return "gcloud ber om innlogging: kjør `gcloud auth login`, eller velg riktig konto med `gcloud config set account`, og prøv igjen";
  }
  return stderr.trim().split("\n").at(-1) ?? "";
}

/** What `--fjern --ja -- <objects>` prints and returns, as the route's
 *  `runProc` would hand it back. */
export function fakeFjernRun(
  objects: readonly string[],
  rm: (object: string) => { exitCode: number; stderr: string },
): { exitCode: number; stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  for (const o of objects) out.push(`vil slette gs://${FAKE_BUCKET}/${o}`);
  if (objects.some((o) => /\.mdx?$/i.test(o))) {
    out.push("(datafilene en side viser, slettes ikke med siden — oppgi dem også, ellers blir de liggende i bøtta)");
  }
  let failed = 0;
  for (const o of objects) {
    out.push(`sletter gs://${FAKE_BUCKET}/${o}`);
    const r = rm(o);
    if (r.exitCode === 0) out.push(`slettet gs://${FAKE_BUCKET}/${o}`);
    else {
      failed++;
      err.push(`Feil: sletting av gs://${FAKE_BUCKET}/${o} feilet (exit ${r.exitCode}): ${maskLast(r.stderr)}`);
    }
  }
  out.push(`\nOppsummering: ${objects.length - failed} slettet, ${failed} feilet. Poden fjerner sidene ved neste poll (~2 min).`);
  return { exitCode: failed > 0 ? 3 : 0, stdout: out.join("\n") + "\n", stderr: err.length ? err.join("\n") + "\n" : "" };
}
