/**
 * "What does `postgres()` need to be handed, given the URL nais injected?"
 *
 * On nais, a Cloud SQL instance created after 2024-04-18 has a **private IP and
 * no proxy sidecar** — the app connects straight to the instance over TLS with a
 * client certificate. The platform therefore hands the pod a URL of this shape
 * (`DB_URL`, per the manifest's `envVarPrefix: DB`):
 *
 *     postgresql://user:pass@10.1.2.3:5432/db
 *       ?sslcert=%2Fvar%2Frun%2Fsecrets%2F…%2Fcert.pem
 *       &sslkey=%2Fvar%2Frun%2Fsecrets%2F…%2Fkey.pem
 *       &sslrootcert=%2Fvar%2Frun%2Fsecrets%2F…%2Froot.pem
 *       &sslmode=verify-ca
 *
 * ⚠️ **`postgres.js` cannot consume that URL.** Measured against a real server
 * (2026-08-27), not reasoned from the docs:
 *
 * - `?sslcert=…&sslkey=…&sslrootcert=…` → `FAIL 42704 unrecognized configuration
 *   parameter "sslcert"`. Its option parser keeps only the names it knows and
 *   forwards **every other query parameter into the startup packet** as a
 *   Postgres GUC (`src/index.js` → `options.connection`, `connection.js` →
 *   `StartupMessage`). So the cert paths do not merely go unused — they abort
 *   the connection before authentication.
 * - `?sslmode=verify-ca` → `FAIL ECONNRESET … before secure TLS connection was
 *   established`. `sslmode` becomes `ssl: "verify-ca"`, which is neither one of
 *   the three strings postgres.js relaxes verification for nor an object it
 *   spreads into `tls.connect` — so the handshake runs with no CA, no client
 *   certificate, and `rejectUnauthorized` left on.
 *
 * The fix is a translation, not a driver change: strip the four SSL parameters
 * out of the URL and hand postgres.js the `ssl` **object** it does understand,
 * built from the files those parameters point at. Everything here is deliberate
 * about failing loudly — a silent fallback to a plaintext connection would be a
 * downgrade attack on ourselves.
 *
 * The three call sites are every place muninn constructs a client:
 * `src/db/client.ts` (the server), `db/migrate.ts` and `db/require-provisioned.ts`
 * (the entrypoint's two CLIs). Its sibling `./database-url.ts` answers *which*
 * variable the URL comes from; this module answers what to do with it.
 */

import postgres from "postgres";
import { readFileSync } from "node:fs";
import type { PeerCertificate } from "node:tls";
import { isIP } from "node:net";

/** libpq's `sslmode` ladder, as far as it is meaningful to us. Anything else is
 *  refused rather than guessed at — see `buildSslOption`. */
export type SslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";

/** The three modes postgres.js implements itself, as a literal string. The
 *  others are either "no TLS" (`disable`) or need the `ssl` OBJECT, which is
 *  what this module builds — postgres.js's own type does not accept them as
 *  strings, which is a useful confirmation rather than a limitation. */
export type PassthroughSslMode = "allow" | "prefer" | "require";

const SSL_MODES: readonly string[] = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
];

export interface ParsedPostgresUrl {
  /** The URL with every SSL parameter removed — safe to hand to `postgres()`. */
  url: string;
  /** `sslmode`, when the URL carried one. */
  sslmode?: SslMode;
  /** Absolute paths, as they appeared in the URL (percent-decoding is done by
   *  `URLSearchParams`, so `%2Fvar%2Frun%2F…` arrives as `/var/run/…`). */
  sslcert?: string;
  sslkey?: string;
  sslrootcert?: string;
  /** True when the host component is a bare IP address. Load-bearing: a Cloud
   *  SQL server certificate is issued for the instance name, never for the
   *  private IP we dial, so hostname verification cannot succeed against one. */
  hostIsIp: boolean;
  /** The host as written in the URL — needed to restore the hostname check
   *  under `verify-full`, which postgres.js otherwise skips (see below). */
  host: string;
  /** `ssl*` parameters removed without being consumed, for the log line. */
  dropped: string[];
}

/**
 * Split a connection URL into "the part postgres.js should see" and "the SSL
 * material it cannot read for itself". Pure — no filesystem access.
 *
 * The `??` repair is not hypothetical: nais has been observed to inject
 * `…/db??sslcert=…`, and `new URL()` then parses the first `?` as the start of
 * a query whose first key is the empty string `""`. postgres.js would forward
 * that empty-named parameter into the startup packet exactly like the others.
 * We normalise it here so both halves of the fix live in one place.
 *
 * Every OTHER `ssl*` parameter is dropped too, and that breadth is the point:
 * the failure being fixed is "postgres.js forwards a parameter it does not know
 * into the startup packet", so leaving one behind would reproduce it. nais
 * injects a PK8 copy of the key for JDBC (`sslkey_pk8`), and node's `tls` wants
 * the PEM one that `sslkey` names — so if it ever appears in the URL it must go.
 * `sslnegotiation` is the one exception: postgres.js reads it itself.
 * Non-`ssl` parameters are left alone — `options`, `application_name` and
 * friends are startup parameters the server really does understand.
 */
export function parsePostgresUrl(raw: string): ParsedPostgresUrl {
  const url = new URL(repairDoubleQuestionMark(raw));

  // ONE ordered pass over the entries, and both properties of it are load-bearing.
  //
  // Case-insensitive, because `URLSearchParams` is not: an `SSLMODE=` would
  // survive the sweep and land in the startup packet — the exact failure this
  // module exists to prevent.
  //
  // Last-wins, because libpq is: `?sslmode=disable&sslmode=verify-ca` must read
  // as `verify-ca`, or it is a silent downgrade to plaintext. It has to be a
  // single pass in DOCUMENT order to be true — an earlier version grouped by
  // key spelling first, and `?SSLMODE=verify-ca&sslmode=disable&SSLMODE=require`
  // then answered `disable`, losing the interleaving between spellings.
  const consumed: Record<string, string | undefined> = {};
  const dropped: string[] = [];
  const remove: string[] = [];
  for (const [name, value] of url.searchParams) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("ssl")) continue;

    if (lower === "sslmode" || lower === "sslcert" || lower === "sslkey" || lower === "sslrootcert") {
      consumed[lower] = value.length > 0 ? value : undefined;
      remove.push(name);
      continue;
    }
    if (name === "sslnegotiation") {
      // Kept: postgres.js reads this one itself — but ONLY at this exact
      // spelling (`index.js` defaults). Any other casing is a parameter nothing
      // consumes, so it falls through to the drop below rather than being
      // forwarded as a GUC the server will reject.
      continue;
    }
    remove.push(name);
    if (!dropped.includes(lower)) dropped.push(lower);
  }
  for (const name of remove) url.searchParams.delete(name);

  // An empty-named parameter, which a stray `?` produces. Dropping it is always
  // right: there is no Postgres GUC named "".
  url.searchParams.delete("");

  const rawMode = consumed.sslmode;
  const mode = rawMode?.toLowerCase();
  if (mode !== undefined && !SSL_MODES.includes(mode)) {
    throw new Error(
      `Unsupported sslmode="${rawMode}" in the database URL. Expected one of ${SSL_MODES.join(", ")}.`,
    );
  }

  return {
    url: url.toString(),
    sslmode: mode as SslMode | undefined,
    sslcert: consumed.sslcert,
    sslkey: consumed.sslkey,
    sslrootcert: consumed.sslrootcert,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    hostIsIp: isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0,
    dropped,
  };
}

/**
 * Repair the `??` nais has been observed to inject between the path and the
 * query — and ONLY that one, at the position where it happens.
 *
 * A blanket `replace(/\?\?/g, "?")` corrupts a parameter whose *value*
 * contains `??`, and the un-anchored single replace this started as could eat a
 * `?` from anywhere in the URL. So: find the first `?` (the query delimiter)
 * and drop a second one immediately after it. Everything to the right is left
 * exactly as written.
 */
function repairDoubleQuestionMark(raw: string): string {
  const q = raw.indexOf("?");
  if (q === -1 || raw[q + 1] !== "?") return raw;
  return raw.slice(0, q + 1) + raw.slice(q + 2);
}

/** The subset of node's TLS options postgres.js spreads into `tls.connect`.
 *  Typed structurally rather than importing `postgres`'s own option type, which
 *  models `ssl` as `boolean | string | object` and would erase every field. */
export interface PostgresSslOption {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized: boolean;
  checkServerIdentity?: (servername: string, cert: PeerCertificate) => Error | undefined;
}

export interface SslBuildResult {
  /** What to pass as `postgres(url, { ssl })`. `undefined` ⇒ no TLS at all,
   *  which is `sslmode=disable` or a URL that carried no SSL parameters. */
  ssl?: PostgresSslOption | PassthroughSslMode;
  /** One line per decision, for the boot log. An operator debugging a refused
   *  connection needs to know which files were read and whether the hostname
   *  check was waived, and neither is visible from the URL afterwards. */
  notes: string[];
}

/**
 * Turn parsed SSL parameters into postgres.js's `ssl` option, reading the
 * certificate files from disk.
 *
 * `readFile` is injected so the mapping can be tested without a filesystem —
 * the decisions worth pinning (which mode waives which check, what happens when
 * a path is present but unreadable) are all above the read.
 */
export function buildSslOption(
  parsed: ParsedPostgresUrl,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SslBuildResult {
  const notes: string[] = [];
  const mode = parsed.sslmode;

  if (mode === "disable") {
    notes.push("sslmode=disable — connecting without TLS");
    return { notes };
  }

  const hasMaterial = Boolean(parsed.sslrootcert || parsed.sslcert || parsed.sslkey);
  if (mode === undefined && !hasMaterial) {
    // The docker-compose / laptop shape: a plain URL, and postgres.js's own
    // default (`ssl: false`) is the right answer. Returning `undefined` keeps
    // this path byte-identical to what it was before this module existed.
    return { notes };
  }

  // `require`/`allow`/`prefer` all mean "encrypt, but do not verify who you are
  // talking to", and postgres.js accepts each as a literal string — so hand one
  // back rather than reimplementing the relaxation in an object. Collapsing
  // them onto `"require"` is NOT equivalent: `prefer` is libpq's default and
  // falls back to plaintext when the server refuses TLS, and `require` does not
  // — measured, that substitution broke a plain local server that had worked.
  //
  // `allow` is the one that does not survive the translation intact. libpq's
  // `allow` is "plaintext first, TLS only if the server insists"; postgres.js
  // has no such mode and treats the literal `'allow'` exactly like `require`
  // (only `'prefer'` triggers its fallback — `connection.js`, measured). Passed
  // through, a URL libpq connects with fails here. So it is mapped to `prefer`:
  // the preference order is inverted, which nothing about `allow` promises, and
  // the connection succeeds either way, which is the whole point of the mode.
  if ((mode === "require" || mode === "allow" || mode === "prefer") && !hasMaterial) {
    const passthrough: PassthroughSslMode = mode === "allow" ? "prefer" : mode;
    notes.push(
      mode === "allow"
        ? "sslmode=allow — mapped to prefer (this driver has no plaintext-first mode)"
        : `sslmode=${mode} — TLS without certificate verification`,
    );
    return { ssl: passthrough, notes };
  }

  const read = (path: string, what: string): string => {
    try {
      return readFile(path);
    } catch (err) {
      // Fail here rather than dropping the material and connecting anyway: on
      // nais these files come from a mounted secret, and a missing one means
      // the mount is wrong, not that plaintext is acceptable.
      throw new Error(
        `Cannot read the ${what} named by the database URL (${path}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const option: PostgresSslOption = { rejectUnauthorized: true };

  // `system` is libpq 16's sentinel for the platform CA bundle, not a path —
  // postgres.js knows it too. Reading it as a filename turns a URL that worked
  // (any managed Postgres fronted by a public CA) into a boot failure with an
  // ENOENT on a file called "system".
  const useSystemRoots = parsed.sslrootcert?.toLowerCase() === "system";
  if (useSystemRoots) {
    notes.push("sslrootcert=system — verifying against the platform CA bundle");
  } else if (parsed.sslrootcert) {
    option.ca = read(parsed.sslrootcert, "sslrootcert");
    notes.push(`sslrootcert=${parsed.sslrootcert}`);
  }
  if (parsed.sslcert) {
    option.cert = read(parsed.sslcert, "sslcert");
    notes.push(`sslcert=${parsed.sslcert}`);
  }
  if (parsed.sslkey) {
    option.key = read(parsed.sslkey, "sslkey");
    notes.push(`sslkey=${parsed.sslkey}`);
  }

  if (mode === "require" || mode === "allow" || mode === "prefer") {
    // Material was supplied AND the mode says not to verify. Present the client
    // certificate (the server may require it) but do not check the server's.
    option.rejectUnauthorized = false;
    notes.push(`sslmode=${mode} — server certificate not verified`);
    if (mode !== "require") {
      // An object cannot carry postgres.js's plaintext fallback, which only the
      // literal `"prefer"` triggers. Presenting the client certificate is the
      // more useful half of the two, so it wins — but the trade is stated.
      notes.push(`⚠️ sslmode=${mode} with a client certificate: no plaintext fallback if TLS is refused`);
    }
    return { ssl: option, notes };
  }

  if (option.ca === undefined && !useSystemRoots) {
    throw new Error(
      `sslmode=${mode ?? "verify-ca"} requires a CA certificate, but the database URL carries no ` +
        `sslrootcert. Either add one or lower sslmode to require.`,
    );
  }

  // verify-ca (nais's own value) verifies the chain but NOT the hostname —
  // which is the only thing that can work here: a Cloud SQL server certificate
  // is issued for the instance name while the URL dials a private IP, so
  // node's default identity check fails with ERR_TLS_CERT_ALTNAME_INVALID even
  // though the chain is perfectly good. verify-full keeps the check.
  if (mode === "verify-full") {
    // verify-full against a BARE IP cannot be honoured by this driver, so it is
    // refused rather than silently downgraded. Measured twice
    // (`scripts/smoke-nais-db-tls.ts`, and a direct `tls.connect` probe):
    // postgres.js passes `servername: net.isIP(host) ? undefined : host`, and
    // with no servername the runtime performs NO identity check and never calls
    // a `checkServerIdentity` callback either — so verify-full quietly became
    // verify-ca, connecting happily to a server whose certificate named
    // something else. A first repair that supplied the callback was inert for
    // exactly that reason; refusing is the only answer that cannot lie.
    //
    // Nothing on nais asks for this: Cloud SQL injects `sslmode=verify-ca`
    // precisely because its certificate names the instance, not the private IP.
    if (parsed.hostIsIp) {
      throw new Error(
        `sslmode=verify-full cannot be honoured against the bare IP ${parsed.host}: the driver ` +
          `performs no hostname check without a servername, and a certificate issued for an ` +
          `instance name would pass anyway. Use sslmode=verify-ca (what nais injects), or connect ` +
          `by hostname.`,
      );
    }
    // Against a hostname postgres.js DOES set the servername, so the runtime's
    // own identity check applies — leaving `rejectUnauthorized` on is the whole
    // implementation.
    notes.push(`sslmode=verify-full — chain and hostname verified against ${parsed.host}`);
    return { ssl: option, notes };
  }

  option.checkServerIdentity = () => undefined;
  notes.push(
    mode === undefined
      ? "no sslmode, but certificates were supplied — verifying the chain, hostname check waived"
      : "sslmode=verify-ca — chain verified, hostname check waived",
  );
  return { ssl: option, notes };
}

export interface PostgresConnection {
  /** The URL to hand `postgres()`, stripped of SSL parameters. */
  url: string;
  /** The `ssl` option, or `undefined` when the URL asked for none. */
  ssl?: PostgresSslOption | PassthroughSslMode;
  notes: string[];
}

/**
 * The one call every `postgres()` site makes: URL in, `{ url, ssl }` out.
 *
 * Deliberately throws rather than degrading. A connection string we cannot
 * interpret is an operator error worth a boot failure — the alternative is a
 * pod that comes up, connects in plaintext or not at all, and reports the
 * difference several layers down as a query error.
 */
export function resolvePostgresConnection(
  raw: string,
  readFile?: (path: string) => string,
): PostgresConnection {
  const parsed = parsePostgresUrl(raw);
  const { ssl, notes } = buildSslOption(parsed, readFile);
  if (parsed.dropped.length > 0) {
    // Named rather than swallowed: a parameter we dropped is a parameter the
    // server will not see, and if one of them ever mattered this line is the
    // only place that says so.
    notes.unshift(`dropped unconsumed ssl parameter(s): ${parsed.dropped.join(", ")}`);
  }
  return { url: parsed.url, ssl, notes };
}

/**
 * `postgres()` with the URL translated first — the form every call site should
 * use. Returns the notes rather than logging them, because the three sites log
 * through two different mechanisms (LogTape in the server, `console.log` in the
 * two CLIs) and neither belongs in this module.
 */
export function openPostgres(
  raw: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
  readFile?: (path: string) => string,
): { sql: postgres.Sql; notes: string[] } {
  const { url, ssl, notes } = resolvePostgresConnection(raw, readFile);
  // `ssl` is only spread when there is one: postgres.js reads `"ssl" in options`
  // nowhere, but an explicit `ssl: undefined` would still shadow a future
  // caller-supplied value, and the no-TLS path must stay byte-identical to the
  // pre-translation behaviour.
  return { sql: postgres(url, ssl === undefined ? options : { ...options, ssl }), notes };
}
