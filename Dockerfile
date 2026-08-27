FROM oven/bun:1-debian AS base
WORKDIR /app

# What this image carries, and why it is a build ARG rather than a second
# Dockerfile: docker-compose builds THIS file, and a compose bot that names no
# connector falls back to `claude-cli` (resolveConnector) while the capture
# verticals shell out to ffmpeg — so dropping either unconditionally would break
# the deployment that already works. Default ON keeps that image byte-identical
# in capability; the serving profile builds with both OFF
# (`--build-arg WITH_MEDIA=false --build-arg WITH_CLI=false`), where the media
# verticals and the Haiku CLI fallback are dropped in code as well
# (MUNINN_PROFILE=nais — src/dashboard/routes.ts, src/ai/haiku-direct.ts).
ARG WITH_MEDIA=true
ARG WITH_CLI=true
# Bake the embedding model into the image instead of downloading it at boot.
# Default OFF so the compose build is unchanged and needs no build-time egress;
# the nais build turns it ON. See the RUN after `COPY src` for why it matters.
ARG WITH_EMBEDDINGS=false

# Both args are read as `= "true"` below, so ANY other spelling silently means
# "off" — `--build-arg WITH_CLI=0`, `=False`, a typo — and produces an image
# whose missing binary is discovered at runtime. Refuse the build instead, in
# the one place that can, and echo which branches were taken.
RUN for pair in "WITH_MEDIA=$WITH_MEDIA" "WITH_CLI=$WITH_CLI" "WITH_EMBEDDINGS=$WITH_EMBEDDINGS"; do \
      case "${pair#*=}" in \
        true|false) ;; \
        *) echo "[build] ERROR: $pair — expected true or false" >&2; exit 1 ;; \
      esac; \
    done; \
    echo "[build] WITH_MEDIA=$WITH_MEDIA (ffmpeg) WITH_CLI=$WITH_CLI (claude) WITH_EMBEDDINGS=$WITH_EMBEDDINGS (MiniLM)"

# System deps. curl + ca-certificates are unconditional (small, and the Claude
# CLI installer needs them); ffmpeg is the audio/keyframe half of the capture
# verticals and is what WITH_MEDIA gates.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && if [ "$WITH_MEDIA" = "true" ]; then apt-get install -y --no-install-recommends ffmpeg; fi \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 muninn && useradd -u 1001 -g muninn -m muninn

# Install Claude CLI as muninn user. PATH is set either way so a runtime that
# mounts its own CLI still finds it.
#
# ⚠️ Piped to `bash`, not `sh`. This line was `| sh` and the image had not been
# rebuilt in a while: the installer is a bash script now, and debian's /bin/sh
# is dash, so it dies with `Syntax error: "(" unexpected` at its own line 9 —
# a pre-existing breakage of the DEFAULT build, surfaced by measuring it here.
USER muninn
RUN if [ "$WITH_CLI" = "true" ]; then curl -fsSL https://claude.ai/install.sh | bash; fi
ENV PATH="/home/muninn/.local/bin:$PATH"

# Switch back to root for dependency install (needs write access to /app)
USER root

# Dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Embedding model, baked.
#
# `warmupEmbeddings()` runs at boot and downloads Xenova/all-MiniLM-L6-v2 on
# first use — but it CATCHES its own failure and logs it, so a pod with no
# egress to the model host looks healthy while every memory search silently
# returns nothing. Baking converts that runtime degradation into a build-time
# fact. nais egress is default-deny, which is exactly where it would have bitten.
#
# Two things about this block are deliberate and easy to "tidy" into a bug:
#
# 1. It runs through `loadEmbeddingModel()`, which is the only entry point in
#    `src/ai/embeddings.ts` that THROWS. The other two swallow — one logs (into
#    an unconfigured LogTape no-op out here), one returns null — so a build
#    driven by either could succeed with an empty cache, preserving the precise
#    silent failure this step exists to remove.
# 2. It sits directly after `bun install`, behind a COPY of the two source files
#    it actually needs, rather than after `COPY src`. Placed there, every commit
#    to any file in src/ re-ran it: a 23 MB fetch, and a hard dependency on
#    huggingface.co being reachable for an urgent rollback build of something
#    unrelated. The narrow COPY keeps the model id and dtype in ONE place —
#    re-stating them in a `pipeline(...)` call here would let a dtype change in
#    embeddings.ts silently invalidate the bake, which is the same bug wearing a
#    different hat.
#
#    The narrow COPY does constrain those two files: a USED import of anything
#    outside node_modules breaks the build here with `Cannot find module`. That
#    is loud, and CI builds with the arg on, so it cannot ship silently — but an
#    UNUSED import compiles away and would not be caught, so the constraint is
#    written down rather than left to be rediscovered.
#
# The weights land in `node_modules/@huggingface/transformers/.cache/` (~23 MB),
# a directory this image builds itself — hence a RUN and not a COPY of a
# checked-in blob, which would put a binary in the public repo's git history.
# ⚠️ This step needs egress to the model host at BUILD time; the saving is a
# runtime one.
ARG WITH_EMBEDDINGS
COPY src/logging.ts ./src/logging.ts
COPY src/ai/embeddings.ts ./src/ai/embeddings.ts
RUN if [ "$WITH_EMBEDDINGS" = "true" ]; then \
      bun -e 'const { loadEmbeddingModel } = await import("./src/ai/embeddings.ts"); \
              await loadEmbeddingModel(); \
              console.log("[build] embedding model baked");'; \
    else \
      echo "[build] embedding model NOT baked — it will be downloaded at first use"; \
    fi

# Source
COPY src ./src
COPY db ./db
# The entrypoint is committed 100755 and COPY preserves the mode, so no chmod
# layer.
COPY scripts/docker-entrypoint.sh ./scripts/
COPY tsconfig.json ./

# Bot folders, if the build context has any.
#
# ⚠️ The bracket goes inside the NAME — `bot[s]`, not `bots[/]`. Both look like
# the same "optional path" trick and only the first one works: measured on
# Docker 29.6.2, `bots[/]` copies ZERO files even when bots/ IS present in the
# context, silently producing an image with no personas at all.
#
# The public repo's .dockerignore excludes bots/ (they are gitignored, and one
# of them carries NAV config), so a build FROM THIS REPO always copies nothing —
# which is why the COPY must tolerate an empty match and why the RUN below
# reports which of the two happened instead of leaving it to be discovered at
# runtime. docker-compose mounts ./bots read-only over this path; the internal
# deploy repo ships its own dockerignore that lets them through.
COPY bot[s] ./bots/
RUN if [ -d ./bots ] && [ -n "$(ls -A ./bots 2>/dev/null)" ]; then \
      echo "[build] bots/ baked into the image: $(ls ./bots | tr '\n' ' ')"; \
    else \
      echo "[build] no bots/ in the build context (excluded by .dockerignore in this repo) — expecting a mounted volume at /app/bots"; \
    fi

# Set ownership and switch to non-root user
RUN chown -R muninn:muninn /app
USER muninn

# The internal container port is 3000, and the IMAGE is what pins it: the app's
# own default is 3010 (`optionalEnvInt("DASHBOARD_PORT", 3010)`), so without this
# line a bare `docker run` served 3010 while EXPOSE, the compose mapping and the
# HEALTHCHECK below all said 3000 — measured, the container was permanently
# unhealthy. Host port stays configurable via DASHBOARD_PORT in .env (3010).
ENV DASHBOARD_PORT=3000
# 0.0.0.0, not the app's 127.0.0.1 default: inside a container loopback is the
# container, so the process would answer its OWN healthcheck (which runs in the
# same namespace) while kubelet probes and Service traffic got connection
# refused. compose already sets this; the image now does too, so a plain
# `docker run -p` works. The loopback default remains right for a bare host.
ENV DASHBOARD_HOST=0.0.0.0
EXPOSE 3000

# Liveness, not /api/stats: `/api/live` is the dependency-free open-zone probe
# (src/auth/zones.ts), so it answers on an authenticating instance with no
# credential, while /api/stats is an admin-zone DB read that would report a
# healthy process as unhealthy the moment MUNINN_AUTH is on.
#
# The port is read from the ENVIRONMENT inside bun rather than expanded by the
# Dockerfile: HEALTHCHECK is not one of the instructions BuildKit substitutes
# build-time variables into, so an `${DASHBOARD_PORT:-3000}` written here would
# have to survive as a literal into the runtime shell. Reading process.env in
# the probe itself needs no shell at all — measured below in CI.
# `--start-period=120s`: the entrypoint's connect budget ALONE is 30s, and the
# migrations run after it — 40s could fail the container for still starting.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD bun -e "const p = process.env.DASHBOARD_PORT || 3000; const r = await fetch('http://127.0.0.1:' + p + '/api/live'); if (!r.ok) process.exit(1);"

# Adopt DB_URL, refuse an unprovisioned database, migrate, then `exec "$@"` —
# i.e. the CMD below, which a `docker run <image> <cmd>` or a compose `command:`
# can still replace. Use `--entrypoint` to inspect the image without booting it.
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
