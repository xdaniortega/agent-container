FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.local/bin:${PATH}"

ARG RGA_VERSION=0.10.10
ARG TYPST_VERSION=0.15.0

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

RUN npm install -g @earendil-works/pi-coding-agent pnpm@11.5.2 \
    && npm cache clean --force

RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh -o /tmp/rtk-install.sh \
    && sh /tmp/rtk-install.sh \
    && rm /tmp/rtk-install.sh \
    && ln -sf /root/.local/bin/rtk /usr/local/bin/rtk \
    && rtk --version \
    && rtk init -g --agent pi --auto-patch \
    && mkdir -p /usr/local/share/pi/extensions \
    && cp /root/.pi/agent/extensions/rtk.ts /usr/local/share/pi/extensions/rtk.ts \
    && rm -rf /root/.pi

# Install Claude Code (native binary, lands at ~/.local/bin/claude, already on PATH)
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && claude --version

COPY entrypoint.sh /usr/local/bin/entrypoint
COPY md2pdf /usr/local/bin/md2pdf
RUN chmod +x /usr/local/bin/entrypoint /usr/local/bin/md2pdf

WORKDIR /workspace

ENTRYPOINT ["entrypoint"]
CMD []
