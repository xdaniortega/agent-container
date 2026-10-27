FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.local/bin:${PATH}"

ARG RGA_VERSION=0.10.10
ARG TYPST_VERSION=0.15.0
ARG PI_VERSION=0.87.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fd-find \
        ffmpeg \
        git \
        fonts-noto-core \
        jq \
        less \
        openssh-client \
        pandoc \
        poppler-utils \
        python3 \
        python3-venv \
        ripgrep \
        procps \
        tesseract-ocr \
        unzip \
        xz-utils \
        zip \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/bin/rg /usr/local/bin/rg \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rg --version \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) rga_arch="x86_64-unknown-linux-gnu"; typst_arch="x86_64-unknown-linux-musl" ;; \
        arm64) rga_arch="aarch64-unknown-linux-gnu"; typst_arch="aarch64-unknown-linux-musl" ;; \
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
    && rga_dir="ripgrep_all-v${RGA_VERSION}-${rga_arch}" \
    && curl -fsSL "https://github.com/phiresky/ripgrep-all/releases/download/v${RGA_VERSION}/${rga_dir}.tar.gz" \
        | tar -xz -C /usr/local/bin --strip-components=1 "${rga_dir}/rga" "${rga_dir}/rga-preproc" \
    && chmod +x /usr/local/bin/rga /usr/local/bin/rga-preproc \
    && rga --version \
    && typst_dir="typst-${typst_arch}" \
    && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${typst_dir}.tar.xz" \
        | tar -xJ -C /usr/local/bin --strip-components=1 "${typst_dir}/typst" \
    && chmod +x /usr/local/bin/typst \
    && typst --version \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" pnpm@11.5.2 \
    && npm cache clean --force \
    && pi --version

RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh -o /tmp/rtk-install.sh \
    && sh /tmp/rtk-install.sh \
    && rm /tmp/rtk-install.sh \
    && ln -sf /root/.local/bin/rtk /usr/local/bin/rtk \
    && rtk --version \
    && rtk init -g --agent pi --auto-patch \
    && mkdir -p /usr/local/share/pi/extensions \
    && cp /root/.pi/agent/extensions/rtk.ts /usr/local/share/pi/extensions/rtk.ts \
    && rm -rf /root/.pi

# Install Claude Code and expose it outside build-time PATH handling.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version

# Install Herdr CLI so containerized Pi sessions can control the host Herdr
# session through the socket bridge created by pic/pic-proxy.
# To bump HERDR_VERSION, also pass HERDR_SHA256_AARCH64 / HERDR_SHA256_X86_64 build
# args; the checksums are listed at https://herdr.dev/latest.json
# (releases.<version>.sha256). The defaults below belong to the default version.
ARG HERDR_VERSION=0.8.2
ARG HERDR_SHA256_AARCH64=f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d
ARG HERDR_SHA256_X86_64=976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4

RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        arm64) herdr_arch="aarch64"; herdr_sha="${HERDR_SHA256_AARCH64}" ;; \
        amd64) herdr_arch="x86_64"; herdr_sha="${HERDR_SHA256_X86_64}" ;; \
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${herdr_arch}" -o /usr/local/bin/herdr \
    && echo "${herdr_sha}  /usr/local/bin/herdr" | sha256sum -c - \
    && chmod +x /usr/local/bin/herdr \
    && herdr --version

# Bake the crew extension and skill into the image so the crew tool is available
# in every container even when the host ~/.pi did not stage its own copy. The
# entrypoint materializes these into ~/.pi/agent at startup as a fallback.
COPY extensions/crew /usr/local/share/pi/extensions/crew
COPY skills/crew /usr/local/share/pi/skills/crew

COPY entrypoint.sh /usr/local/bin/entrypoint
COPY md2pdf /usr/local/bin/md2pdf
RUN chmod +x /usr/local/bin/entrypoint /usr/local/bin/md2pdf

WORKDIR /workspace

ENTRYPOINT ["entrypoint"]
CMD []
