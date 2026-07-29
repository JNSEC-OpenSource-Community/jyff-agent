# Solver 的所有命令、RTK 与文件操作均在此容器中执行。
FROM alpine:3.21

ARG RTK_VERSION=0.44.1

RUN apk add --no-cache \
    bash binutils coreutils file findutils git python3 py3-pip ripgrep curl wget tar xz \
    && wget -q "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz" -O /tmp/rtk.tar.gz \
    && tar -xzf /tmp/rtk.tar.gz -C /tmp \
    && install -m 0755 /tmp/rtk /usr/local/bin/rtk \
    && rm -rf /tmp/rtk /tmp/rtk.tar.gz

WORKDIR /workspace
CMD ["sleep", "infinity"]
