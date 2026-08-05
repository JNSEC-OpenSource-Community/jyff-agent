# Agent 的所有命令、RTK 与文件操作均在此容器中执行。
ARG RIZIN_VERSION=0.9.1
ARG RIZIN_SOURCE_SHA256=7ac1cd7daca7afdda742e15478b1f747fc1f813e496fee71839d1e109e543dca
ARG RZ_GHIDRA_VERSION=0.9.0
ARG RZ_GHIDRA_SHA256=6e1027bb4901d866280881592b03f070f61aead77e9fd9a9661be3082fdf80f3
ARG PYCDC_COMMIT=b4289760970dbc399684f1e155ec6d1ea1cc787e
ARG PYCDC_SHA256=d7d8c53d37a1a586097145b532fca02535db2f2f0999b3b1e910133c9941bf31

# rz-ghidra 必须与 Rizin 的动态 C API 匹配；编译链只存在于此阶段。
FROM ubuntu:24.04 AS re-builder

ARG RIZIN_VERSION
ARG RIZIN_SOURCE_SHA256
ARG RZ_GHIDRA_VERSION
ARG RZ_GHIDRA_SHA256
ARG PYCDC_COMMIT
ARG PYCDC_SHA256

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --no-install-recommends -y ca-certificates \
    && sed -i \
    -e 's|http://archive.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' \
    -e 's|http://security.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' \
    /etc/apt/sources.list.d/ubuntu.sources \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --no-install-recommends -y \
    build-essential cmake meson ninja-build pkg-config \
    python3 python3-yaml wget xz-utils zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q --tries=5 \
    "https://github.com/rizinorg/rizin/releases/download/v${RIZIN_VERSION}/rizin-src-v${RIZIN_VERSION}.tar.xz" \
    -O /tmp/rizin.tar.xz \
    && echo "${RIZIN_SOURCE_SHA256}  /tmp/rizin.tar.xz" | sha256sum -c - \
    && mkdir -p /tmp/rizin \
    && tar -xJf /tmp/rizin.tar.xz -C /tmp/rizin --strip-components=1 \
    && meson setup /tmp/rizin/build /tmp/rizin \
    --prefix=/opt/rizin \
    --buildtype=release \
    -Ddefault_library=shared \
    -Dlocal=enabled \
    -Denable_tests=false \
    -Denable_rz_test=false \
    -Denable_benchmarks=false \
    -Dinstall_sigdb=false \
    && meson compile -C /tmp/rizin/build -j 4 \
    && meson install -C /tmp/rizin/build \
    && rm -rf /tmp/rizin /tmp/rizin.tar.xz

RUN wget -q --tries=5 \
    "https://github.com/rizinorg/rz-ghidra/releases/download/v${RZ_GHIDRA_VERSION}/rz-ghidra-src-v${RZ_GHIDRA_VERSION}.tar.gz" \
    -O /tmp/rz-ghidra.tar.gz \
    && echo "${RZ_GHIDRA_SHA256}  /tmp/rz-ghidra.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/rz-ghidra \
    && tar -xzf /tmp/rz-ghidra.tar.gz -C /tmp/rz-ghidra --strip-components=1 \
    && cmake -S /tmp/rz-ghidra -B /tmp/rz-ghidra/build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH=/opt/rizin \
    -DCMAKE_INSTALL_PREFIX=/opt/rizin \
    -DBUILD_CUTTER_PLUGIN=OFF \
    -DBUILD_DECOMPILE_EXECUTABLE=OFF \
    -DBUILD_DECOMPILE_CLI_EXECUTABLE=OFF \
    -DBUILD_SLASPECS=ON \
    -DBUILD_SLEIGH_PLUGIN=ON \
    && cmake --build /tmp/rz-ghidra/build --parallel 4 \
    && cmake --install /tmp/rz-ghidra/build \
    && rm -rf /tmp/rz-ghidra /tmp/rz-ghidra.tar.gz

RUN wget -q --tries=5 \
    "https://github.com/zrax/pycdc/archive/${PYCDC_COMMIT}.tar.gz" \
    -O /tmp/pycdc.tar.gz \
    && echo "${PYCDC_SHA256}  /tmp/pycdc.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/pycdc \
    && tar -xzf /tmp/pycdc.tar.gz -C /tmp/pycdc --strip-components=1 \
    && cmake -S /tmp/pycdc -B /tmp/pycdc/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/pycdc/build --parallel 4 \
    && install -D -m 0755 /tmp/pycdc/build/pycdc /opt/re-tools/bin/pycdc \
    && install -D -m 0755 /tmp/pycdc/build/pycdas /opt/re-tools/bin/pycdas \
    && strip /opt/re-tools/bin/pycdc /opt/re-tools/bin/pycdas \
    && rm -rf /tmp/pycdc /tmp/pycdc.tar.gz \
    && rm -rf /opt/rizin/include /opt/rizin/lib/pkgconfig /opt/rizin/lib/cmake \
    && find /opt/rizin/lib -type f -name '*.a' -delete

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/ctf-venv/bin:/opt/re-venv/bin:/opt/rizin/bin:/opt/re-tools/bin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/rizin/lib:/opt/rizin/lib/x86_64-linux-gnu"

# Ubuntu 基础镜像默认使用 HTTP 源；先引导 CA，再切换镜像源以降低大批量下载的断连率。
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --no-install-recommends -y ca-certificates \
    && sed -i \
    -e 's|http://archive.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' \
    -e 's|http://security.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' \
    /etc/apt/sources.list.d/ubuntu.sources \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --no-install-recommends -y \
    afl++ bash basez bc binutils binutils-aarch64-linux-gnu binutils-arm-linux-gnueabihf \
    binutils-mipsel-linux-gnu binutils-multiarch binutils-riscv64-linux-gnu binwalk bison \
    build-essential busybox-static cabextract checksec cmake coreutils cpio curl \
    device-tree-compiler dwarves elfutils ent file findutils flex ffmpeg foremost \
    g++-13-multilib gcc-13-multilib gifsicle \
    gcc-aarch64-linux-gnu gcc-arm-linux-gnueabihf gcc-mipsel-linux-gnu \
    gcc-riscv64-linux-gnu gdb gdb-multiarch gdbserver git imagemagick jq libelf-dev \
    libarchive-tools libffi-dev libgmp-dev libc6-dbg libc6-dev-i386 \
    libimage-exiftool-perl libmpc-dev libmpfr-dev libseccomp-dev libsndfile1 \
    libsox-fmt-all linux-tools-generic ltrace lz4 musl-tools nasm netcat-openbsd \
    openssl optipng outguess p7zip-full patchelf pkg-config pngcheck pngcrush \
    python3 python3-dev python3-pip python3-venv qemu-system-arm qemu-system-mips \
    qemu-system-misc qemu-system-x86 qemu-user qrencode ripgrep ruby ruby-dev socat \
    sox sqlite3 squashfs-tools steghide stegseek stegsnow strace tar tesseract-ocr \
    unzip valgrind wabt webp wget xxd xz-utils yara zbar-tools zip zstd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=re-builder /opt/rizin /opt/rizin
COPY --from=re-builder /opt/re-tools /opt/re-tools

COPY requirements-ctf.txt /tmp/requirements-ctf.txt
RUN python3 -m venv /opt/ctf-venv \
    && python -m pip install --no-cache-dir --upgrade pip setuptools==80.10.2 wheel \
    && python -m pip install --no-cache-dir -r /tmp/requirements-ctf.txt \
    && rm -f /tmp/requirements-ctf.txt

# angr/Frida 对底层依赖有严格约束，独立环境避免影响 pwntools 的 Python 依赖。
COPY requirements-re.txt /tmp/requirements-re.txt
RUN python3 -m venv /opt/re-venv \
    && /opt/re-venv/bin/python -m pip install --no-cache-dir --upgrade pip setuptools==80.10.2 wheel \
    && /opt/re-venv/bin/python -m pip install --no-cache-dir -r /tmp/requirements-re.txt \
    && printf '#!/bin/sh\nexec /opt/re-venv/bin/python "$@"\n' > /usr/local/bin/angr-python \
    && chmod 0755 /usr/local/bin/angr-python \
    && rm -f /tmp/requirements-re.txt

# Pwndbg portable 自带匹配的 GDB/Python，支持直接以 --batch/-ex 方式调用。
ARG PWNDBG_VERSION=2026.07.29
ARG PWNDBG_SHA256=63c38b76bf8baeb44b4bc018c73ea0b05b872c2aba205ed5680892f2d65adb03
RUN wget -q \
    "https://github.com/pwndbg/pwndbg/releases/download/${PWNDBG_VERSION}/pwndbg_${PWNDBG_VERSION}_x86_64-portable.tar.xz" \
    -O /tmp/pwndbg.tar.xz \
    && echo "${PWNDBG_SHA256}  /tmp/pwndbg.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/pwndbg.tar.xz -C /opt \
    && ln -s /opt/pwndbg/bin/pwndbg /usr/local/bin/pwndbg \
    && rm -f /tmp/pwndbg.tar.xz

ARG PWNINIT_VERSION=3.3.3
ARG PWNINIT_SHA256=f124b6645b01b0fc4adacabe61438fe73eef517dc3e4696a08e1250a8f47eec3
RUN wget -q \
    "https://github.com/io12/pwninit/releases/download/${PWNINIT_VERSION}/pwninit" \
    -O /tmp/pwninit \
    && echo "${PWNINIT_SHA256}  /tmp/pwninit" | sha256sum -c - \
    && install -m 0755 /tmp/pwninit /usr/local/bin/pwninit \
    && rm -f /tmp/pwninit

# capa/FLOSS 都提供稳定的无交互 JSON 模式，适合作为自动预分析的能力与字符串提取器。
ARG CAPA_VERSION=9.4.0
ARG CAPA_SHA256=07800a1d20a21eb18fc98716e2ae81b668e0c9a04defd588c8aa17ea3d3281e4
ARG FLOSS_VERSION=3.1.1
ARG FLOSS_SHA256=40c05a869f34f7e2417b17ca290cc54bd3671ee1f0a2d9bd5103284c01a54666
RUN wget -q --tries=5 \
    "https://github.com/mandiant/capa/releases/download/v${CAPA_VERSION}/capa-v${CAPA_VERSION}-linux.zip" \
    -O /tmp/capa.zip \
    && wget -q --tries=5 \
    "https://github.com/mandiant/flare-floss/releases/download/v${FLOSS_VERSION}/floss-v${FLOSS_VERSION}-linux.zip" \
    -O /tmp/floss.zip \
    && echo "${CAPA_SHA256}  /tmp/capa.zip" | sha256sum -c - \
    && echo "${FLOSS_SHA256}  /tmp/floss.zip" | sha256sum -c - \
    && unzip -q /tmp/capa.zip -d /tmp/capa \
    && unzip -q /tmp/floss.zip -d /tmp/floss \
    && install -m 0755 /tmp/capa/capa /usr/local/bin/capa \
    && install -m 0755 /tmp/floss/floss /usr/local/bin/floss \
    && rm -rf /tmp/capa /tmp/floss /tmp/capa.zip /tmp/floss.zip

ARG UPX_VERSION=5.2.0
ARG UPX_SHA256=3db5d3294707439db97866feab8d75d800f028f48481a40547411824da4288a1
RUN wget -q \
    "https://github.com/upx/upx/releases/download/v${UPX_VERSION}/upx-${UPX_VERSION}-amd64_linux.tar.xz" \
    -O /tmp/upx.tar.xz \
    && echo "${UPX_SHA256}  /tmp/upx.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/upx.tar.xz -C /tmp \
    && install -m 0755 "/tmp/upx-${UPX_VERSION}-amd64_linux/upx" /usr/local/bin/upx \
    && rm -rf "/tmp/upx-${UPX_VERSION}-amd64_linux" /tmp/upx.tar.xz

ARG ONE_GADGET_VERSION=1.10.0
ARG ONE_GADGET_SHA256=4bc784a6023f69c24b7b3d78ca2460bbaaea0d2cbb3f67f3c7615cc7f785107c
ARG SECCOMP_TOOLS_VERSION=1.7.0
ARG SECCOMP_TOOLS_SHA256=e2803f69c032b5413785c847ec2fbe90a5ef44a15dca14643c84fdc49594bd92
ARG BINDATA_VERSION=2.5.1
ARG BINDATA_SHA256=53186a1ec2da943d4cb413583d680644eb810aacbf8902497aac8f191fad9e58
ARG ELFTOOLS_VERSION=1.3.1
ARG ELFTOOLS_SHA256=9d46fca49a7d5e821b9c80127b19d59e8ce578bfaa17b99c8ff259222686aaf8
ARG OS_GEM_VERSION=1.1.4
ARG OS_GEM_SHA256=57816d6a334e7bd6aed048f4b0308226c5fb027433b67d90a9ab435f35108d3f
ARG RACC_VERSION=1.8.1
ARG RACC_SHA256=4a7f6929691dbec8b5209a0b373bc2614882b55fc5d2e447a21aaa691303d62f
RUN wget -q \
    "https://rubygems.org/downloads/one_gadget-${ONE_GADGET_VERSION}.gem" \
    -O /tmp/one_gadget.gem \
    && wget -q \
    "https://rubygems.org/downloads/seccomp-tools-${SECCOMP_TOOLS_VERSION}.gem" \
    -O /tmp/seccomp-tools.gem \
    && wget -q "https://rubygems.org/downloads/bindata-${BINDATA_VERSION}.gem" -O /tmp/bindata.gem \
    && wget -q "https://rubygems.org/downloads/elftools-${ELFTOOLS_VERSION}.gem" -O /tmp/elftools.gem \
    && wget -q "https://rubygems.org/downloads/os-${OS_GEM_VERSION}.gem" -O /tmp/os.gem \
    && wget -q "https://rubygems.org/downloads/racc-${RACC_VERSION}.gem" -O /tmp/racc.gem \
    && echo "${ONE_GADGET_SHA256}  /tmp/one_gadget.gem" | sha256sum -c - \
    && echo "${SECCOMP_TOOLS_SHA256}  /tmp/seccomp-tools.gem" | sha256sum -c - \
    && echo "${BINDATA_SHA256}  /tmp/bindata.gem" | sha256sum -c - \
    && echo "${ELFTOOLS_SHA256}  /tmp/elftools.gem" | sha256sum -c - \
    && echo "${OS_GEM_SHA256}  /tmp/os.gem" | sha256sum -c - \
    && echo "${RACC_SHA256}  /tmp/racc.gem" | sha256sum -c - \
    && gem install --local --no-document \
    /tmp/bindata.gem /tmp/elftools.gem /tmp/os.gem /tmp/racc.gem \
    /tmp/one_gadget.gem /tmp/seccomp-tools.gem \
    && rm -f /tmp/*.gem

ARG RTK_VERSION=0.44.1
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

# no-install-recommends 会省略交叉 libc sysroot；显式补齐后 GCC 才能完成链接。
# Ubuntu 的 bpftool 启动器依赖宿主内核版本，复制实际二进制以保持容器内调用稳定。
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --no-install-recommends -y \
    libc6-dev-arm64-cross libc6-dev-armhf-cross libc6-dev-mipsel-cross \
    libc6-dev-riscv64-cross \
    && install -m 0755 \
    "$(find -L /usr/lib/linux-tools -type f -name bpftool | sort -V | tail -n 1)" \
    /usr/local/bin/bpftool \
    && rm -rf /var/lib/apt/lists/*

# Misc/隐写 Python CLI 复用主 CTF 环境，但独立成末端层，避免小工具变更重建重型依赖。
COPY requirements-misc.txt /tmp/requirements-misc.txt
RUN python -m pip install --no-cache-dir -r /tmp/requirements-misc.txt \
    && rm -f /tmp/requirements-misc.txt

COPY re-preflight.py /usr/local/bin/ctf-re-preflight
RUN chmod 0755 /usr/local/bin/ctf-re-preflight
COPY tools.txt /tools.txt
ENV TERM=xterm

WORKDIR /workspace
CMD ["sleep", "infinity"]
