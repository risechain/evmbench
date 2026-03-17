FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1
ENV UV_TOOL_BIN_DIR=/usr/local/bin

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project

WORKDIR /app

COPY pyproject.toml uv.lock alembic.ini ./

COPY api api
COPY instancer instancer
COPY migrations migrations
COPY oai_proxy oai_proxy
COPY prunner prunner
COPY secretsvc secretsvc
COPY resultsvc resultsvc

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked

# Install codex CLI for device-auth flow
ARG CODEX_VERSION=rust-v0.104.0
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) CODEX_ARCH="x86_64" ;; \
      arm64) CODEX_ARCH="aarch64" ;; \
      *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    CODEX_URL="https://github.com/openai/codex/releases/download/${CODEX_VERSION}/codex-${CODEX_ARCH}-unknown-linux-gnu.tar.gz"; \
    mkdir -p /usr/local/src/codex; cd /usr/local/src/codex; \
    curl -L -o codex.tgz "$CODEX_URL"; \
    ENTRY="$(tar -tzf codex.tgz | grep -v '/$' | head -n1)"; \
    test -n "$ENTRY"; \
    tar -xzf codex.tgz -O "$ENTRY" > /usr/local/bin/codex; \
    chmod 0755 /usr/local/bin/codex; \
    cd /; rm -rf /usr/local/src/codex; \
    codex --version

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app"
ENTRYPOINT []
