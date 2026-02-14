FROM oven/bun:1-debian AS base
WORKDIR /app

# System deps (ffmpeg for audio, curl for Claude CLI install)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 javrvis && useradd -u 1001 -g javrvis -m javrvis

# Install Claude CLI as javrvis user
USER javrvis
RUN curl -fsSL https://claude.ai/install.sh | sh
ENV PATH="/home/javrvis/.local/bin:$PATH"

# Switch back to root for dependency install (needs write access to /app)
USER root

# Dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Source
COPY src ./src
COPY db ./db
COPY tsconfig.json ./

# Set ownership and switch to non-root user
RUN chown -R javrvis:javrvis /app
USER javrvis

# bots/ is mounted as volume (not baked in)
# so persona/MCP config can change without rebuild

# Internal container port is always 3000 (docker-compose overrides DASHBOARD_PORT).
# Host port is configurable via DASHBOARD_PORT in .env (default 3010).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/api/stats'); if (!r.ok) process.exit(1);"

CMD ["bun", "run", "start"]
