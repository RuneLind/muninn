#!/usr/bin/env bash
#
# Does nais' wonderwall sidecar set `Authorization` on a WebSocket UPGRADE?
#
# PR D's socket design rests on that, and the NAV-login plan refuses to build on
# "very likely" — Go's `httputil.ReverseProxy` has handled upgrades since 1.12
# and wonderwall runs its `Rewrite` on the outbound request, so it *ought* to be
# fine, but the deferred Entra half would be the first thing to find out
# otherwise, in production. This stands the two containers up locally and asks.
#
# It is NOT part of any test suite: it needs Docker, pulls two images and takes
# ~30 s. Run it by hand when the answer needs re-confirming against a newer
# wonderwall.
#
#   ./scripts/wonderwall-ws-harness.sh
#
# MEASURED 2026-08-26, wonderwall `2026-08-21-123251-1e1066a` (go1.26.7),
# mock-oauth2-server 2.1.10, on macOS/Docker Desktop:
#
#   1. A WebSocket upgrade through wonderwall reaches the upstream carrying
#      `Authorization: Bearer <access_token>`, and the 101 is proxied back.
#   2. The session cookie is sent as `SameSite=Lax` — verified from the actual
#      `Set-Cookie` header, not from the config dump. That is what
#      `src/auth/CLAUDE.md` leans on when it says the origin check's real targets
#      are the side-effecting GET and the browser running ON the muninn host,
#      not the ordinary cross-site POST.
#   3. With `--auto-login`, an upgrade carrying no session is refused 401 by
#      wonderwall and never reaches the upstream at all. That is the sidecar
#      behaving as documented — it does NOT remove muninn's own upgrade check,
#      which exists for the LAN/tailnet instance that has no sidecar in front of
#      it.
#
# None of this is exercised by muninn today: `MUNINN_AUTH=entra` refuses to boot
# until the zone model lands. The value is that the deferred half inherits a
# measurement instead of an assumption.
set -euo pipefail

MOCK_PORT=8085          # published AND the container's own port, so the issuer
                        # URL in the discovery document is reachable from the host
PROXY_PORT=8000
UPSTREAM_PORT=7788
NET=ww-harness-net
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f ww-harness-mock ww-harness-proxy >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [[ -n "${UPSTREAM_PID:-}" ]]; then
    kill "$UPSTREAM_PID" 2>/dev/null || true
    wait "$UPSTREAM_PID" 2>/dev/null || true   # else bash prints its own "Terminated" line
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── the "muninn": reports what arrived on the upgrade ────────────────────────
cat > "$WORK/upstream.ts" <<'EOF'
const seen: unknown[] = [];
Bun.serve({
  port: Number(process.env.UPSTREAM_PORT), hostname: "0.0.0.0",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/report") return Response.json(seen);
    const auth = req.headers.get("authorization");
    if (url.pathname === "/chat/ws") {
      seen.push({
        path: url.pathname,
        upgrade: req.headers.get("upgrade"),
        hasAuthorization: !!auth,
        authorizationPrefix: auth ? auth.slice(0, 16) + "…" : null,
      });
      if (srv.upgrade(req)) return undefined;
      return new Response("no upgrade", { status: 500 });
    }
    seen.push({ path: url.pathname, hasAuthorization: !!auth });
    return new Response("upstream ok: " + url.pathname);
  },
  websocket: { open(ws) { ws.send("hello"); }, message() {} },
});
EOF

# ── a raw handshake, so the STATUS LINE is observable ────────────────────────
cat > "$WORK/handshake.ts" <<'EOF'
const cookie = process.argv[2] ?? "";
const port = Number(process.env.PROXY_PORT);
const raw = await new Promise<string>((resolve) => {
  let buf = "";
  Bun.connect({ hostname: "127.0.0.1", port, socket: {
    open(s) {
      s.write(
        `GET /chat/ws HTTP/1.1\r\nHost: localhost:${port}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
        `Cookie: ${cookie}\r\nOrigin: http://localhost:${port}\r\n\r\n`,
      );
    },
    data(s, d) { buf += new TextDecoder().decode(d); if (buf.includes("\r\n\r\n")) { s.end(); resolve(buf); } },
    close() { resolve(buf); },
  }});
});
console.log(raw.split("\r\n")[0]);
EOF

echo "› starting the upstream on :$UPSTREAM_PORT"
UPSTREAM_PORT="$UPSTREAM_PORT" bun "$WORK/upstream.ts" >"$WORK/upstream.log" 2>&1 &
UPSTREAM_PID=$!
sleep 1

docker network create "$NET" >/dev/null 2>&1 || true

echo "› starting mock-oauth2-server on :$MOCK_PORT"
# `interactiveLogin:false` is REQUIRED: the default serves a login FORM, and the
# curl-driven flow below then stops at a 200 on /authorize with no callback ever
# firing — which reads as "login succeeded" because curl's last hop was a 200.
docker run -d --rm --name ww-harness-mock --network "$NET" \
  -p "$MOCK_PORT:$MOCK_PORT" -e "SERVER_PORT=$MOCK_PORT" \
  -e 'JSON_CONFIG={"interactiveLogin":false}' \
  ghcr.io/navikt/mock-oauth2-server:2.1.10 >/dev/null
sleep 5

echo "› starting wonderwall on :$PROXY_PORT"
docker run -d --rm --name ww-harness-proxy --network "$NET" \
  -p "$PROXY_PORT:$PROXY_PORT" --add-host host.docker.internal:host-gateway \
  ghcr.io/nais/wonderwall:latest \
  --bind-address="0.0.0.0:$PROXY_PORT" \
  --ingress="http://localhost:$PROXY_PORT" \
  --upstream-host="host.docker.internal:$UPSTREAM_PORT" \
  --openid.well-known-url="http://ww-harness-mock:$MOCK_PORT/default/.well-known/openid-configuration" \
  --openid.client-id=muninn-harness \
  --openid.client-secret=muninn-harness-secret \
  --encryption-key="$(openssl rand -base64 32)" \
  --cookie.secure=false \
  --auto-login >/dev/null
sleep 4

JAR="$WORK/jar.txt"
echo
echo "─── 1. an UNAUTHENTICATED upgrade ───────────────────────────────────────"
PROXY_PORT="$PROXY_PORT" bun "$WORK/handshake.ts" "nothing=here"
BEFORE=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/report" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')

echo
echo "─── 2. logging in through the sidecar ───────────────────────────────────"
# `--resolve` because the discovery document names the container by its NETWORK
# name, which the host cannot otherwise resolve.
curl -sL -c "$JAR" -b "$JAR" --resolve "ww-harness-mock:$MOCK_PORT:127.0.0.1" \
  -D "$WORK/login-headers.txt" -o /dev/null \
  -w '   login ended at %{url_effective} (%{http_code})\n' \
  "http://localhost:$PROXY_PORT/oauth2/login?redirect=/hello"
echo -n "   session cookie as SENT: "
grep -i "set-cookie: io.nais.wonderwall.session" "$WORK/login-headers.txt" \
  | sed 's/=[A-Za-z0-9_-]\{20,\}/=<redacted>/' | tr -d '\r' || echo "(none — login failed)"

echo
echo "─── 3. the UPGRADE, with a session ──────────────────────────────────────"
COOKIE=$(grep wonderwall.session "$JAR" | awk '{print $6"="$7}')
PROXY_PORT="$PROXY_PORT" bun "$WORK/handshake.ts" "$COOKIE"

echo
echo "─── what the upstream actually received ─────────────────────────────────"
curl -s "http://127.0.0.1:$UPSTREAM_PORT/report" | python3 -m json.tool
echo "   (requests reaching the upstream before login: $BEFORE — an unauthenticated"
echo "    upgrade is refused by the sidecar and never arrives)"
