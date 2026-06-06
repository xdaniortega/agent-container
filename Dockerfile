FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.local/bin:${PATH}"

ARG RGA_VERSION=0.10.10

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fd-find \
        ffmpeg \
        pandoc \
        poppler-utils \
        ripgrep \
        tesseract-ocr \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/bin/rg /usr/local/bin/rg \
    && rg --version \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) rga_arch="x86_64-unknown-linux-gnu" ;; \
        arm64) rga_arch="aarch64-unknown-linux-gnu" ;; \
        *) echo "Unsupported architecture for rga: $arch" >&2; exit 1 ;; \
    esac \
    && rga_dir="ripgrep_all-v${RGA_VERSION}-${rga_arch}" \
    && curl -fsSL "https://github.com/phiresky/ripgrep-all/releases/download/v${RGA_VERSION}/${rga_dir}.tar.gz" \
        | tar -xz -C /usr/local/bin --strip-components=1 "${rga_dir}/rga" "${rga_dir}/rga-preproc" \
    && chmod +x /usr/local/bin/rga /usr/local/bin/rga-preproc \
    && rga --version \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent pnpm \
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

COPY pi-container-entrypoint.sh /usr/local/bin/pi-container-entrypoint
RUN chmod +x /usr/local/bin/pi-container-entrypoint

WORKDIR /workspace

ENTRYPOINT ["pi-container-entrypoint"]
CMD []
