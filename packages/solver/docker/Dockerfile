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

COPY tools.txt /tools.txt
ENV TERM=xterm

WORKDIR /workspace
CMD ["sleep", "infinity"]
