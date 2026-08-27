/**
 * End-to-end proof that `db/postgres-connection.ts` can do what raw
 * `postgres()` cannot: connect to a Postgres server the way nais's Cloud SQL
 * makes us — TLS, a private CA, a client certificate, and a server certificate
 * whose name does not match the address we dial.
 *
 * The unit tests pin the mapping; this pins the thing the mapping is FOR. It is
 * a script rather than a suite member because it needs docker and openssl, and
 * because a 20-second container spin-up on every `bun run test` would buy a
 * fact that changes about once a year.
 *
 *     bun scripts/smoke-nais-db-tls.ts
 *
 * What it builds: a throwaway CA; a server certificate issued for the name
 * `muninn-smoke-instance` (NOT for 127.0.0.1, which is what we connect to —
 * exactly the Cloud SQL situation, where the certificate names the instance and
 * the URL carries a private IP); a client certificate whose CN is the database
 * role, since the server is configured to demand one. Then it asserts:
 *
 *   1. the nais-shaped URL through `openPostgres` CONNECTS,
 *   2. the same URL through raw `postgres()` fails with the startup-packet
 *      error (`unrecognized configuration parameter "sslcert"`),
 *   3. the URL with only `sslmode=verify-ca` through raw `postgres()` fails in
 *      the TLS handshake,
 *   4. `sslmode=verify-full` through `openPostgres` REFUSES — the hostname
 *      really is being checked when the mode asks for it, so case 1 is not
 *      passing because verification was turned off wholesale.
 */
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { openPostgres } from "../db/postgres-connection.ts";

// Names carry the pid: two runs of this script overlapped once, and the second
// `docker rm -f` took the first's container out from under it — the kept certs
// no longer matched the running server, producing a false RED. A false GREEN is
// equally reachable that way.
const RUN_ID = String(process.pid);
const CONTAINER = `muninn-smoke-nais-tls-${RUN_ID}`;
const PLAIN_CONTAINER = `muninn-smoke-nais-plain-${RUN_ID}`;
const IMAGE = `muninn-smoke-nais-tls:${RUN_ID}`;
/** Host ports are assigned by DOCKER, not chosen here. Fixed constants made the
 *  per-run naming above only half a protection: two overlapping runs got unique
 *  containers and then collided on `Bind for 0.0.0.0:55432`. Read back with
 *  `docker port` after start. */
let PORT = 0;
/** A second, ordinary server. The startup-packet failure can only be shown
 *  where a plaintext connection is admitted — and admitting one on the TLS
 *  server would gut the assertion above it. */
let PLAIN_PORT = 0;

/** The host port docker actually bound for a container's 5432. */
async function hostPort(container: string): Promise<number> {
  const out = (await $`docker port ${container} 5432/tcp`.text()).trim();
  // e.g. "0.0.0.0:55123" or two lines (v4 + v6); the port is after the last ":".
  const first = out.split("\n")[0] ?? "";
  const port = Number(first.slice(first.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not read the host port for ${container} (docker port said: ${out})`);
  }
  return port;
}
const DB = "muninn";
const USER = "muninn";
/** The name on the server certificate. Deliberately not `127.0.0.1`. */
const SERVER_CN = "muninn-smoke-instance";

const dir = mkdtempSync(join(tmpdir(), "muninn-nais-tls-"));
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  // `KEEP=1` leaves the containers and the certificates behind — the only way
  // to read `docker logs` when a server refuses to start.
  if (process.env.KEEP === "1") {
    console.log(`\nKEEP=1 — containers ${CONTAINER}, ${PLAIN_CONTAINER} and ${dir} left in place`);
    return;
  }
  await $`docker rm -f ${CONTAINER}`.nothrow().quiet();
  await $`docker rm -f ${PLAIN_CONTAINER}`.nothrow().quiet();
  // The image too: a fixed tag left a 661 MB layer set behind on every run.
  await $`docker rmi -f ${IMAGE}`.nothrow().quiet();
  rmSync(dir, { recursive: true, force: true });
}

async function main() {
  console.log(`workdir ${dir}`);

  // --- certificates -------------------------------------------------------
  // A private CA, a server certificate for SERVER_CN, and a client certificate
  // whose CN is the database role (Postgres `cert` auth maps CN → role).
  await $`openssl req -new -x509 -nodes -days 1 -subj /CN=muninn-smoke-ca -keyout ${join(dir, "ca.key")} -out ${join(dir, "ca.pem")}`.nothrow().quiet();

  for (const [name, cn] of [["server", SERVER_CN], ["client", USER]] as const) {
    await $`openssl req -new -nodes -subj ${`/CN=${cn}`} -keyout ${join(dir, `${name}.key`)} -out ${join(dir, `${name}.csr`)}`.quiet();
    await $`openssl x509 -req -in ${join(dir, `${name}.csr`)} -days 1 -CA ${join(dir, "ca.pem")} -CAkey ${join(dir, "ca.key")} -CAcreateserial -out ${join(dir, `${name}.pem`)}`.quiet();
  }

  // --- a server that demands all of it ------------------------------------
  // The certificates are baked into an image rather than bind-mounted: Postgres
  // refuses to start on a key file that is group/world readable, and a mount
  // from macOS does not reliably carry 0600 + postgres ownership.
  // `POSTGRES_HOST_AUTH_METHOD=cert` is NOT usable here: it writes a plain
  // `host … cert` line and Postgres refuses to load the file at all —
  // "cert authentication is only supported on hostssl connections". So the
  // image carries its own pg_hba, pointed at with `-c hba_file`.
  writeFileSync(
    join(dir, "pg_hba.conf"),
    [
      // initdb and pg_isready go over the unix socket.
      "local   all   all                trust",
      // Everything over TCP must present a client certificate — which is what
      // makes case 1 a real assertion rather than "TLS happened to be optional".
      "hostssl all   all   0.0.0.0/0    cert",
      "hostssl all   all   ::/0         cert",
      // NO plaintext line. An earlier version had one, so that the
      // startup-packet case below could reach a startup packet — and it
      // silently negated check 1: a client that never sends SSLRequest matched
      // the trust line and was admitted, so the assertion passed over an
      // unencrypted, un-authenticated session. The plaintext case gets its own
      // server instead (PLAIN_PORT), and check 1 now reads pg_stat_ssl rather
      // than trusting that `select 1` implies TLS.
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "Dockerfile"),
    [
      "FROM postgres:17",
      "COPY server.pem server.key ca.pem pg_hba.conf /certs/",
      "RUN chown postgres:postgres /certs/* && chmod 600 /certs/server.key",
      "",
    ].join("\n"),
  );
  const built = await $`docker build -q -t ${IMAGE} ${dir}`.nothrow().quiet();
  if (built.exitCode !== 0) throw new Error(`docker build failed: ${built.stderr.toString()}`);

  await $`docker rm -f ${CONTAINER}`.nothrow().quiet();
  // One line: Bun's shell treats a newline inside the template as a command
  // separator, so a "readable" multi-line docker invocation runs as several
  // broken commands.
  const run = await $`docker run -d --name ${CONTAINER} -P -e POSTGRES_USER=${USER} -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=${DB} ${IMAGE} -c hba_file=/certs/pg_hba.conf -c ssl=on -c ssl_cert_file=/certs/server.pem -c ssl_key_file=/certs/server.key -c ssl_ca_file=/certs/ca.pem`.nothrow().quiet();
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);

  await $`docker rm -f ${PLAIN_CONTAINER}`.nothrow().quiet();
  const plain = await $`docker run -d --name ${PLAIN_CONTAINER} -P -e POSTGRES_USER=${USER} -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=${DB} -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17`.nothrow().quiet();
  if (plain.exitCode !== 0) throw new Error(`docker run (plain) failed: ${plain.stderr.toString()}`);

  PORT = await hostPort(CONTAINER);
  PLAIN_PORT = await hostPort(PLAIN_CONTAINER);
  console.log(`tls server on :${PORT}, plaintext server on :${PLAIN_PORT}`);

  // Wait for readiness. `pg_isready` runs inside the container over the unix
  // socket, so it is unaffected by the TLS rules we are here to test.
  const deadline = Date.now() + 60_000;
  for (const name of [CONTAINER, PLAIN_CONTAINER]) {
    for (;;) {
      const r = await $`docker exec ${name} pg_isready -U ${USER}`.nothrow().quiet();
      if (r.exitCode === 0) break;
      if (Date.now() > deadline) throw new Error(`${name} did not become ready in 60s`);
      await Bun.sleep(500);
    }
  }

  // --- the URLs nais would hand us ----------------------------------------
  const enc = (p: string) => encodeURIComponent(join(dir, p));
  const base = `postgresql://${USER}:smoke@127.0.0.1:${PORT}/${DB}`;
  const naisUrl =
    `${base}?sslcert=${enc("client.pem")}&sslkey=${enc("client.key")}` +
    `&sslrootcert=${enc("ca.pem")}&sslmode=verify-ca`;

  /**
   * Asks the SERVER what kind of session this is, rather than inferring it from
   * a successful `select 1`. That inference is what let a plaintext connection
   * pass check 1 for a whole review round: the query worked, so the TLS was
   * assumed. `pg_stat_ssl` cannot be fooled that way.
   */
  const tryQuery = async (sql: postgres.Sql, requireTls = false): Promise<string> => {
    try {
      const [row] = await sql`
        SELECT ssl, version, client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid()
      `;
      if (requireTls) {
        if (!row?.ssl) return `connected WITHOUT TLS (pg_stat_ssl.ssl = ${row?.ssl})`;
        if (!row?.client_dn) return `connected over ${row.version} but presented NO client certificate`;
        console.log(`    · server sees: ${row.version}, client_dn=${row.client_dn}`);
      }
      return "";
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return `${e.code ?? ""} ${e.message ?? String(err)}`.trim();
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  };

  console.log("\nthe fix:");
  const { sql, notes } = openPostgres(naisUrl, { max: 1, onnotice: () => {} });
  for (const n of notes) console.log(`    · ${n}`);
  const okErr = await tryQuery(sql, true);
  check(
    "openPostgres connects over TLS, presenting the client certificate",
    okErr === "",
    okErr,
  );

  console.log("\nwhat it replaces (all three must fail):");
  const rawErr = await tryQuery(postgres(naisUrl, { max: 1, onnotice: () => {} }));
  // Note WHICH failure: with `sslmode` in the URL the TLS handshake is attempted
  // and dies first (SELF_SIGNED_CERT_IN_CHAIN — postgres.js builds no CA from
  // `sslrootcert`), so the startup-packet error never gets a chance. Both are
  // the same defect seen from two sides; the case below isolates the other one.
  check("raw postgres() cannot use the nais URL at all", rawErr !== "", rawErr || "it connected");

  // Against the PLAINTEXT server: the startup packet is only reached where a
  // plaintext connection is admitted at all.
  const plainBase = `postgresql://${USER}:smoke@127.0.0.1:${PLAIN_PORT}/${DB}`;
  const certOnlyErr = await tryQuery(
    postgres(`${plainBase}?sslcert=${enc("client.pem")}`, { max: 1, onnotice: () => {} }),
  );
  check(
    "raw postgres() forwards sslcert into the startup packet",
    /unrecognized configuration parameter/.test(certOnlyErr),
    certOnlyErr,
  );

  const modeErr = await tryQuery(
    postgres(`${base}?sslmode=verify-ca`, { max: 1, onnotice: () => {} }),
  );
  check(
    "raw postgres() with sslmode alone fails the handshake",
    modeErr !== "",
    modeErr || "connected, which it should not have",
  );

  console.log("\nverify-full is refused rather than silently downgraded:");
  let fullErr = "";
  try {
    openPostgres(naisUrl.replace("sslmode=verify-ca", "sslmode=verify-full"), { max: 1 });
  } catch (err) {
    fullErr = err instanceof Error ? err.message : String(err);
  }
  check(
    "verify-full against a bare IP throws before a connection is opened",
    /cannot be honoured against the bare IP/.test(fullErr),
    fullErr || "it built a client, which would connect without any hostname check",
  );
}

try {
  await main();
} catch (err) {
  failures++;
  console.error(`\nsmoke aborted: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await cleanup();
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
