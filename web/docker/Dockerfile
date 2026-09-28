# Build context is the REPO ROOT (the docs live outside web/); see compose.*.yaml and
# Dockerfile.dockerignore, which lets in only what the site renders.
FROM node:22

# varlock (glibc build: the ghcr.io/dmno-dev/varlock image ships a musl binary that
# can't run on Debian images). Exact version.
ARG TARGETARCH
ARG VARLOCK_VERSION=1.21.0
RUN arch=$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo arm64) \
  && curl -fsSL "https://github.com/dmno-dev/varlock/releases/download/varlock%40${VARLOCK_VERSION}/varlock-linux-${arch}.tar.gz" \
     | tar -xz -C /usr/local/bin ./varlock

WORKDIR /usr/app
COPY web/.env.schema web/.env.dev web/.env.prod ./

# The markdown the docs are made of. In dev the whole repo is mounted over this, read-only.
COPY README.md /usr/app/repo/README.md
COPY docs /usr/app/repo/docs
COPY plugin/skills /usr/app/repo/plugin/skills

WORKDIR /usr/app/app
COPY web/app/package*.json ./
RUN npm install
COPY web/app .

COPY web/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /usr/app
ENTRYPOINT ["varlock", "run", "--", "/entrypoint.sh"]
