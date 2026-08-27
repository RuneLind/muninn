/**
 * The nais URL translation. Every case here is about a shape the platform can
 * actually inject — the failure this module exists for is that postgres.js
 * forwards an SSL query parameter into the Postgres startup packet, which
 * aborts the connection with `unrecognized configuration parameter "sslcert"`.
 *
 * The end-to-end half (a real TLS server, a real client certificate) is
 * `scripts/smoke-nais-db-tls.ts` — it needs docker and openssl, so it is a
 * runnable smoke rather than a suite member.
 */
import { describe, expect, test } from "bun:test";
import {
  parsePostgresUrl,
  buildSslOption,
  resolvePostgresConnection,
} from "./postgres-connection.ts";

/** The shape nais injects for a private-IP Cloud SQL instance, verbatim modulo
 *  the credentials and the secret path. */
const NAIS_URL =
  "postgresql://muninn:hunter2@10.11.12.13:5432/muninn" +
  "?sslcert=%2Fvar%2Frun%2Fsecrets%2Fcert.pem" +
  "&sslkey=%2Fvar%2Frun%2Fsecrets%2Fkey.pem" +
  "&sslrootcert=%2Fvar%2Frun%2Fsecrets%2Froot.pem" +
  "&sslmode=verify-ca";

const files: Record<string, string> = {
  "/var/run/secrets/cert.pem": "CERT",
  "/var/run/secrets/key.pem": "KEY",
  "/var/run/secrets/root.pem": "ROOT",
};
const readFake = (path: string): string => {
  const found = files[path];
  if (found === undefined) throw new Error("ENOENT");
  return found;
};

describe("parsePostgresUrl", () => {
  test("strips every ssl parameter and percent-decodes the paths", () => {
    const parsed = parsePostgresUrl(NAIS_URL);
    expect(parsed.url).toBe("postgresql://muninn:hunter2@10.11.12.13:5432/muninn");
    expect(parsed.sslmode).toBe("verify-ca");
    expect(parsed.sslcert).toBe("/var/run/secrets/cert.pem");
    expect(parsed.sslkey).toBe("/var/run/secrets/key.pem");
    expect(parsed.sslrootcert).toBe("/var/run/secrets/root.pem");
    expect(parsed.hostIsIp).toBe(true);
  });

  test("repairs the double question mark nais has been observed to inject", () => {
    const parsed = parsePostgresUrl(
      "postgresql://u:p@10.0.0.1:5432/db??sslcert=%2Fc.pem&sslmode=verify-ca",
    );
    expect(parsed.url).toBe("postgresql://u:p@10.0.0.1:5432/db");
    expect(parsed.sslcert).toBe("/c.pem");
    expect(parsed.sslmode).toBe("verify-ca");
  });

  test("drops unconsumed ssl-family parameters but keeps real startup ones", () => {
    // `sslkey_pk8` is the JDBC copy of the key; `options` is a genuine startup
    // parameter and postgres.js forwarding it is correct.
    const parsed = parsePostgresUrl(
      "postgresql://u:p@h:5432/db?sslkey_pk8=%2Fk.pk8&options=-c%20statement_timeout%3D5s",
    );
    expect(parsed.dropped).toEqual(["sslkey_pk8"]);
    expect(new URL(parsed.url).searchParams.get("options")).toBe("-c statement_timeout=5s");
  });

  test("keeps sslnegotiation, which postgres.js reads itself", () => {
    const parsed = parsePostgresUrl("postgresql://u:p@h:5432/db?sslnegotiation=direct");
    expect(parsed.dropped).toEqual([]);
    expect(new URL(parsed.url).searchParams.get("sslnegotiation")).toBe("direct");
  });

  test("a hostname is not an IP", () => {
    expect(parsePostgresUrl("postgresql://u:p@db.example:5432/x").hostIsIp).toBe(false);
    expect(parsePostgresUrl("postgresql://u:p@[::1]:5432/x").hostIsIp).toBe(true);
  });

  test("an unknown sslmode is refused rather than guessed at", () => {
    expect(() => parsePostgresUrl("postgresql://u:p@h/db?sslmode=maybe")).toThrow(/Unsupported sslmode/);
  });
});

describe("buildSslOption", () => {
  test("verify-ca reads all three files and waives the hostname check", () => {
    const { ssl, notes } = buildSslOption(parsePostgresUrl(NAIS_URL), readFake);
    expect(ssl).toMatchObject({ ca: "ROOT", cert: "CERT", key: "KEY", rejectUnauthorized: true });
    // The hostname check MUST be waived: a Cloud SQL certificate names the
    // instance, the URL dials the private IP, and node would otherwise refuse
    // with ERR_TLS_CERT_ALTNAME_INVALID on a chain that is perfectly valid.
    expect(typeof (ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBe("function");
    expect(notes.join(" ")).toContain("hostname check waived");
  });

  test("verify-full is REFUSED against a bare IP rather than downgraded", () => {
    // The driver performs no identity check without a servername, and sets none
    // for an IP host — so honouring verify-full there is impossible and
    // pretending to would be worse than saying so. See the module comment.
    const parsed = parsePostgresUrl(NAIS_URL.replace("verify-ca", "verify-full"));
    expect(() => buildSslOption(parsed, readFake)).toThrow(/cannot be honoured against the bare IP/);
  });

  test("verify-full against a hostname keeps the runtime's own check", () => {
    const parsed = parsePostgresUrl(
      NAIS_URL.replace("verify-ca", "verify-full").replace("10.11.12.13", "db.internal"),
    );
    const { ssl, notes } = buildSslOption(parsed, readFake);
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    expect((ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBeUndefined();
    expect(notes.join(" ")).toContain("hostname verified against db.internal");
  });

  test("a plain URL is left entirely alone — the compose and laptop path", () => {
    const { ssl, notes } = buildSslOption(
      parsePostgresUrl("postgresql://muninn:muninn@127.0.0.1:5435/muninn"),
      readFake,
    );
    expect(ssl).toBeUndefined();
    expect(notes).toEqual([]);
  });

  test("sslmode=disable connects without TLS even if material is present", () => {
    const parsed = parsePostgresUrl(NAIS_URL.replace("verify-ca", "disable"));
    expect(buildSslOption(parsed, readFake).ssl).toBeUndefined();
  });

  test("sslmode=require with no material hands postgres.js its own string", () => {
    const parsed = parsePostgresUrl("postgresql://u:p@h:5432/db?sslmode=require");
    expect(buildSslOption(parsed, readFake).ssl).toBe("require");
  });

  test("sslmode=require WITH a client certificate still presents it", () => {
    const parsed = parsePostgresUrl(NAIS_URL.replace("verify-ca", "require"));
    const { ssl } = buildSslOption(parsed, readFake);
    expect(ssl).toMatchObject({ cert: "CERT", key: "KEY", rejectUnauthorized: false });
  });

  test("an unreadable certificate file fails loudly rather than downgrading", () => {
    const parsed = parsePostgresUrl(NAIS_URL);
    expect(() => buildSslOption(parsed, () => { throw new Error("EACCES"); })).toThrow(
      /Cannot read the sslrootcert/,
    );
  });

  test("verify-ca with no CA is refused — it cannot verify anything", () => {
    const parsed = parsePostgresUrl(
      "postgresql://u:p@10.0.0.1:5432/db?sslcert=%2Fc.pem&sslmode=verify-ca",
    );
    expect(() => buildSslOption(parsed, () => "X")).toThrow(/requires a CA certificate/);
  });
});

describe("resolvePostgresConnection", () => {
  test("names the parameters it dropped", () => {
    const { notes } = resolvePostgresConnection(
      "postgresql://u:p@h:5432/db?sslkey_pk8=%2Fk.pk8",
      readFake,
    );
    expect(notes[0]).toContain("sslkey_pk8");
  });
});

describe("call sites", () => {
  /**
   * The pin that keeps this fix from going inert. A fourth `postgres(` written
   * next year would compile, pass every test, work on a laptop and fail only in
   * the pod — which is the exact failure mode this module was added for.
   *
   * Walked in JS rather than shelled out to `grep`: the first version of this
   * test ran `grep -rn --include=*.ts …` through Bun's shell, which refused the
   * unquoted glob, and `.nothrow()` turned the refusal into an empty result —
   * i.e. the pin passed for finding nothing, on a tree that had eleven matches.
   */
  const EXEMPT = new Set([
    // The one legitimate construction, and this file's prose about it.
    "db/postgres-connection.ts",
    "db/postgres-connection.test.ts",
    // Provisions the local test database from `src/test/test-db-url.ts`, whose
    // URLs are plain by construction — no nais URL ever reaches it.
    "db/setup-test-db.ts",
  ]);

  test("nothing constructs a postgres client except openPostgres", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, relative } = await import("node:path");

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };

    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of [...walk(join(root, "src")), ...walk(join(root, "db"))]) {
      const rel = relative(root, file);
      // Tests dial the local test database directly and legitimately.
      if (EXEMPT.has(rel) || rel.endsWith(".test.ts")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
        if (/(^|[^.\w])postgres\(/.test(line)) offenders.push(`${rel}:${i + 1}: ${code}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
