# Solver 的所有命令、RTK 与文件操作均在此容器中执行。
FROM ubuntu:24.04

ARG RTK_VERSION=0.44.1

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/ctf-venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        bash binutils build-essential ca-certificates coreutils curl file findutils \
        ffmpeg gdb gdbserver git imagemagick jq libffi-dev libgmp-dev \
        libimage-exiftool-perl libmpc-dev libmpfr-dev libsndfile1 libsox-fmt-all \
        ltrace nasm netcat-openbsd openssl p7zip-full patchelf pkg-config \
        pngcheck python3 python3-dev python3-pip python3-venv ripgrep socat sox sqlite3 \
        steghide strace tar tesseract-ocr unzip wget xxd xz-utils zip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-ctf.txt /tmp/requirements-ctf.txt
RUN python3 -m venv /opt/ctf-venv \
    && python -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && python -m pip install --no-cache-dir -r /tmp/requirements-ctf.txt \
    && rm -f /tmp/requirements-ctf.txt

RUN wget -q \
        "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz" \
        -O /tmp/rtk.tar.gz \
    && tar -xzf /tmp/rtk.tar.gz -C /tmp \
    && install -m 0755 /tmp/rtk /usr/local/bin/rtk \
    && rm -rf /tmp/rtk /tmp/rtk.tar.gz

# Go 官方 tarball（apt 版过旧；新版本才能解析新版 Go 二进制的 pclntab）
ARG GO_VERSION=1.26.5
RUN wget -q \
        "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
        -O /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm -rf /tmp/go /tmp/go.tar.gz

# JDK 8u65（Azul Zulu，2015 年版本，大量历史 CVE；仅提供 zip 格式）
# 刻意选择带历史漏洞的旧补丁版本，便于构造/复现 CVE 利用场景。
# 注意：老版本 cacerts 不含现代 CA，Java HTTPS 连新站点可能失败（curl/wget 不受影响）
ARG JDK8_VERSION=zulu8.10.0.1-ca-jdk8.0.65-linux_x64
RUN mkdir -p /opt/jdks \
    && wget -q \
        "https://cdn.azul.com/zulu/bin/${JDK8_VERSION}.zip" \
        -O /tmp/jdk8.zip \
    && unzip -q /tmp/jdk8.zip -d /opt/jdks \
    && ln -sf "$(ls -d /opt/jdks/zulu* | head -1)" /opt/jdks/8 \
    && rm -f /tmp/jdk8.zip

# JDK 17.0.2（Temurin，2022 年早期版本，覆盖 2022-2024 常见 CVE）
ARG JDK17_VERSION=17.0.2
ARG JDK17_BUILD=8
RUN mkdir -p /opt/jdks \
    && wget -q \
        "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-${JDK17_VERSION}%2B${JDK17_BUILD}/OpenJDK17U-jdk_x64_linux_hotspot_${JDK17_VERSION}_${JDK17_BUILD}.tar.gz" \
        -O /tmp/jdk17.tar.gz \
    && tar -C /opt/jdks -xzf /tmp/jdk17.tar.gz \
    && ln -sf "/opt/jdks/jdk-${JDK17_VERSION}+${JDK17_BUILD}" /opt/jdks/17 \
    && rm -f /tmp/jdk17.tar.gz

# JDK 21.0.1（Temurin，2023 年早期版本）
ARG JDK21_VERSION=21.0.1
ARG JDK21_BUILD=12
RUN mkdir -p /opt/jdks \
    && wget -q \
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${JDK21_VERSION}%2B${JDK21_BUILD}/OpenJDK21U-jdk_x64_linux_hotspot_${JDK21_VERSION}_${JDK21_BUILD}.tar.gz" \
        -O /tmp/jdk21.tar.gz \
    && tar -C /opt/jdks -xzf /tmp/jdk21.tar.gz \
    && ln -sf "/opt/jdks/jdk-${JDK21_VERSION}+${JDK21_BUILD}" /opt/jdks/21 \
    && rm -f /tmp/jdk21.tar.gz

# CFR Java 反编译器（单 jar + 轻量 wrapper；PATH 无默认 java，wrapper 显式用 JDK 8）
# 用法：cfr <class|jar>，老 jar 兼容性好
ARG CFR_VERSION=0.152
RUN wget -q \
        "https://github.com/leibnitz27/cfr/releases/download/${CFR_VERSION}/cfr-${CFR_VERSION}.jar" \
        -O /opt/cfr.jar \
    && printf '#!/bin/sh\nexec /opt/jdks/8/bin/java -jar /opt/cfr.jar "$@"\n' > /usr/local/bin/cfr \
    && chmod 0755 /usr/local/bin/cfr

# Vineflower Java 反编译器（现代语法/输出质量更好；wrapper 显式用 JDK 21）
# 用法：vineflower <input.jar|class> <output-dir>
ARG VINEFLOWER_VERSION=1.12.0
RUN wget -q \
        "https://github.com/Vineflower/vineflower/releases/download/${VINEFLOWER_VERSION}/vineflower-${VINEFLOWER_VERSION}.jar" \
        -O /opt/vineflower.jar \
    && printf '#!/bin/sh\nexec /opt/jdks/21/bin/java -jar /opt/vineflower.jar "$@"\n' > /usr/local/bin/vineflower \
    && chmod 0755 /usr/local/bin/vineflower

COPY tools.txt /tools.txt
ENV TERM=xterm

WORKDIR /workspace
CMD ["sleep", "infinity"]
