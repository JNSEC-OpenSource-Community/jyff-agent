# Solver 的所有命令、RTK 与文件操作均在此容器中执行。
FROM ubuntu:24.04

ARG RTK_VERSION=0.44.1
ARG SSTV_COMMIT=3e556eee8ad4c4425799cb652bac26ee58f8e113

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/ctf-venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        bash binutils build-essential ca-certificates coreutils curl file findutils \
        ffmpeg gdb gdbserver git imagemagick jq libffi-dev libgmp-dev \
        libimage-exiftool-perl libmpc-dev libmpfr-dev libsndfile1 libsox-fmt-all \
        ltrace multimon-ng nasm netcat-openbsd openssl p7zip-full patchelf pkg-config \
        pngcheck python3 python3-dev python3-pip python3-venv ripgrep socat sox sqlite3 \
        steghide strace tar tesseract-ocr unzip wget xxd xz-utils zip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-ctf.txt /tmp/requirements-ctf.txt
RUN python3 -m venv /opt/ctf-venv \
    && python -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && python -m pip install --no-cache-dir -r /tmp/requirements-ctf.txt \
    && python -m pip install --no-cache-dir --no-deps \
        "git+https://github.com/colaclanth/sstv.git@${SSTV_COMMIT}" \
    && rm -f /tmp/requirements-ctf.txt

# Upstream assumes an interactive TTY; Agent commands run through docker exec pipes.
RUN sed -i 's/from os import get_terminal_size/from shutil import get_terminal_size/' \
        /opt/ctf-venv/lib/python*/site-packages/sstv/common.py

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
