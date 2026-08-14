import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { executeDockerCommand, type DockerCommandExecutor } from "@ctf-agent/sandbox"
import { AuditStore, type CodeAuditProject, type CodeAuditRun } from "@ctf-agent/core"
import type { AgentModelConfiguration } from "./model-pool.ts"

const IMAGE = "ctf-agent-audit:latest"
const LITELLM_IMAGE =
  "litellm/litellm@sha256:1aa6227ab85b21b3959b0ce4fc21ddbe64170d12a85b33c726ca5b22dc41e87a"
const BRIDGE_URL = "http://litellm:4000/v1"
const BRIDGE_PROVIDER = "lmstudio"
interface AuditRuntime {
  container: string
  bridgeContainer: string
  bridgeVolume: string
  tokenVolume: string
  runtimeVolume: string
  internalNetwork: string
  egressNetwork: string
  modelName: string
}

/**
 * 一次审计对应一个非特权 Docker 容器：源码仅以只读目录进入容器，结果写入
 * 单独目录。Worker 不拥有 Docker socket，宿主只读取 canonical JSON 结果。
 */
export class CodeAuditRunner {
  private readonly active = new Map<string, AbortController>()
  private readonly runtimes = new Map<string, AuditRuntime>()

  constructor(
    private readonly root: string,
    private readonly storePath: string,
    private readonly models: AgentModelConfiguration,
    private readonly execute: DockerCommandExecutor = executeDockerCommand,
  ) {}

  async preflight(): Promise<void> {
    for (const [image, message] of [
      [IMAGE, "审计镜像未构建；请先运行 vp run build:sandbox"],
      [LITELLM_IMAGE, "Responses bridge 镜像未拉取；请先运行 vp run build:sandbox"],
    ] as const) {
      const result = await this.execute(["image", "inspect", image], { timeoutMs: 10_000 })
      if (result.code !== 0) throw new Error(message)
    }
  }

  async cleanupOrphans(): Promise<void> {
    const containers = await resourceIds(this.execute, [
      "ps",
      "-aq",
      "--filter",
      "label=com.ctf-agent.audit-run",
    ])
    for (const id of containers) await this.execute(["rm", "-f", id]).catch(() => undefined)
    const networks = await resourceIds(this.execute, [
      "network",
      "ls",
      "-q",
      "--filter",
      "label=com.ctf-agent.audit-network",
    ])
    for (const id of networks) await this.execute(["network", "rm", id]).catch(() => undefined)
    const volumes = await resourceIds(this.execute, [
      "volume",
      "ls",
      "-q",
      "--filter",
      "label=com.ctf-agent.audit-volume",
    ])
    for (const id of volumes) await this.execute(["volume", "rm", "-f", id]).catch(() => undefined)
  }

  async run(run: CodeAuditRun, audit: CodeAuditProject): Promise<void> {
    const store = await AuditStore.open(this.storePath)
    const work = join(this.root, "runs", run.id)
    const output = join(work, "output")
    const preservedRuntime = join(work, "runtime")
    const workerLog = join(work, "worker.log")
    const runtime: AuditRuntime = {
      container: containerName(run.id),
      bridgeContainer: bridgeContainerName(run.id),
      bridgeVolume: volumeName(run.id, "bridge"),
      tokenVolume: volumeName(run.id, "token"),
      runtimeVolume: volumeName(run.id, "runtime"),
      internalNetwork: networkName(run.id, "internal"),
      egressNetwork: networkName(run.id, "egress"),
      modelName: bridgeModelName(run.id),
    }
    const sourceVolume = volumeName(run.id, "source")
    const scopeVolume = volumeName(run.id, "scope")
    const outputVolume = volumeName(run.id, "output")
    let volumesCreated = false
    const controller = new AbortController()
    this.active.set(run.id, controller)
    this.runtimes.set(run.id, runtime)
    try {
      const model = await this.models.codexSecurityConfiguration(audit.auditModelId)
      const bridgeToken = `sk-ctf-${randomUUID().replaceAll("-", "")}`
      await mkdir(output, { recursive: true })
      await createVolume(this.execute, sourceVolume, controller.signal)
      await createVolume(this.execute, scopeVolume, controller.signal)
      await createVolume(this.execute, outputVolume, controller.signal)
      await createVolume(this.execute, runtime.bridgeVolume, controller.signal)
      await createVolume(this.execute, runtime.tokenVolume, controller.signal)
      await createVolume(this.execute, runtime.runtimeVolume, controller.signal)
      volumesCreated = true
      await unpackArchive(this.execute, audit.archivePath, sourceVolume, controller.signal)
      await applyScope(
        this.execute,
        sourceVolume,
        scopeVolume,
        audit.includePaths,
        audit.excludePaths,
        controller.signal,
      )
      const prepared = await this.execute(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--security-opt",
          "no-new-privileges",
          "--mount",
          `type=volume,src=${outputVolume},dst=/output`,
          "--mount",
          `type=volume,src=${runtime.runtimeVolume},dst=/runtime`,
          "--user",
          "0:0",
          "ctf-agent-solver:latest",
          "sh",
          "-lc",
          "mkdir -p /runtime/state /runtime/codex-home /runtime/home && chmod 700 /output /runtime /runtime/state /runtime/codex-home /runtime/home && chown -R 10001:10001 /output /runtime",
        ],
        { signal: controller.signal, timeoutMs: 60_000 },
      )
      if (prepared.code !== 0) throw new Error("无法准备审计容器挂载")
      await prepareHostOutput(this.execute, output, controller.signal)
      await prepareHostOutput(this.execute, preservedRuntime, controller.signal)
      if (run.followUpPrompt?.trim()) {
        await writeRuntimePrompt(
          this.execute,
          runtime.runtimeVolume,
          run.followUpPrompt.trim(),
          controller.signal,
        )
      }
      await writeBridgeFiles(
        this.execute,
        runtime.bridgeVolume,
        runtime.tokenVolume,
        model,
        runtime.modelName,
        bridgeToken,
        controller.signal,
      )
      await createNetwork(this.execute, runtime.internalNetwork, true, controller.signal)
      await createNetwork(this.execute, runtime.egressNetwork, false, controller.signal)
      await startBridge(this.execute, runtime, controller.signal)
      store.updateRun(run.id, { status: "running" })
      const result = await this.execute(
        [
          "run",
          "--rm",
          "--init",
          "--name",
          runtime.container,
          "--label",
          `com.ctf-agent.audit-run=${run.id}`,
          "--network",
          runtime.internalNetwork,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--security-opt",
          "seccomp=unconfined",
          "--pids-limit",
          "512",
          "--memory",
          "4g",
          "--cpus",
          "2",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=1g",
          "--mount",
          `type=volume,src=${scopeVolume},dst=/source,readonly`,
          "--mount",
          `type=volume,src=${outputVolume},dst=/output`,
          "--mount",
          `type=volume,src=${runtime.runtimeVolume},dst=/runtime`,
          "--mount",
          `type=volume,src=${runtime.tokenVolume},dst=/bridge,readonly`,
          "-e",
          `CODEX_OSS_BASE_URL=${BRIDGE_URL}`,
          "-e",
          "CODEX_SECURITY_STATE_DIR=/runtime/state",
          "-e",
          "CODEX_HOME=/runtime/codex-home",
          "-e",
          "HOME=/runtime/home",
          "--entrypoint",
          "sh",
          IMAGE,
          "-lc",
          codexBridgeCommand(run.mode, runtime.modelName, Boolean(run.followUpPrompt?.trim())),
        ],
        {
          signal: controller.signal,
          timeoutMs: 6 * 60 * 60 * 1000,
          onStdout: (chunk) => {
            void appendWorkerLog(workerLog, chunk)
            recordWorkerProgress(store, run.id, chunk)
          },
          onStderr: (chunk) => {
            void appendWorkerLog(workerLog, chunk)
            recordWorkerProgress(store, run.id, chunk)
          },
        },
      )
      if (result.code !== 0) {
        const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")
        throw new Error(
          `审计 Worker 退出: ${result.code}${detail ? `: ${detail.slice(0, 2_000)}` : ""}`,
        )
      }
      await exportOutput(this.execute, outputVolume, output, controller.signal)
      await ingestFindings(store, run.id, output)
      const report = await readFile(join(output, "report.md"), "utf8")
      if (report.length > 5 * 1024 * 1024) throw new Error("审计报告超过 5 MiB 限制")
      store.saveReport(run.id, report)
      store.updateRun(run.id, { status: "completed" })
    } catch (error) {
      const detail = safeError(error)
      await preserveFailureArtifacts(this.execute, runtime, outputVolume, output, preservedRuntime)
      await appendWorkerLog(workerLog, `\n[runner] ${detail}\n`)
      await writeFile(
        join(work, "failure.json"),
        JSON.stringify(
          {
            runId: run.id,
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: detail,
            preservedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      ).catch(() => undefined)
      store.updateRun(run.id, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: detail,
      })
    } finally {
      this.active.delete(run.id)
      this.runtimes.delete(run.id)
      await cleanupRuntime(this.execute, runtime)
      if (volumesCreated) {
        await removeVolume(this.execute, sourceVolume)
        await removeVolume(this.execute, scopeVolume)
        await removeVolume(this.execute, outputVolume)
        await removeVolume(this.execute, runtime.bridgeVolume)
        await removeVolume(this.execute, runtime.tokenVolume)
        await removeVolume(this.execute, runtime.runtimeVolume)
      }
      store.close()
    }
  }

  async pause(runId: string): Promise<boolean> {
    if (!this.active.has(runId)) return false
    const result = await this.execute(["pause", containerName(runId)])
    return result.code === 0
  }

  async resume(runId: string): Promise<boolean> {
    if (!this.active.has(runId)) return false
    const result = await this.execute(["unpause", containerName(runId)])
    return result.code === 0
  }

  cancel(runId: string): boolean {
    const controller = this.active.get(runId)
    if (!controller) return false
    controller.abort()
    // Killing the attached `docker run` client alone can leave both containers alive.
    void cleanupRuntime(this.execute, this.runtimes.get(runId)).catch(() => undefined)
    return true
  }
  async cleanup(runId: string): Promise<void> {
    await rm(join(this.root, "runs", runId), { recursive: true, force: true })
  }
}

async function createNetwork(
  execute: DockerCommandExecutor,
  network: string,
  internal: boolean,
  signal: AbortSignal,
): Promise<void> {
  const args = ["network", "create", "--label", `com.ctf-agent.audit-network=${network}`]
  if (internal) args.push("--internal")
  args.push(network)
  const result = await execute(args, { signal, timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error("无法创建审计隔离网络")
}

async function writeBridgeFiles(
  execute: DockerCommandExecutor,
  volume: string,
  tokenVolume: string,
  model: { model: string; baseUrl: string; apiKey: string; providerApi: string },
  modelName: string,
  bridgeToken: string,
  signal: AbortSignal,
): Promise<void> {
  const payload = JSON.stringify({
    config: JSON.stringify(litellmConfig(model, modelName)),
    callback: BRIDGE_CALLBACK,
    upstreamKey: model.apiKey,
    bridgeToken,
  })
  const result = await execute(
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=16m",
      "--mount",
      `type=volume,src=${volume},dst=/bridge`,
      "--mount",
      `type=volume,src=${tokenVolume},dst=/token`,
      "--user",
      "0:0",
      "ctf-agent-solver:latest",
      "python3",
      "-c",
      BRIDGE_FILE_WRITER,
    ],
    { input: payload, signal, timeoutMs: 30_000 },
  )
  if (result.code !== 0) {
    const detail = dockerResultDetail(result)
    throw new Error(`无法写入 Responses bridge 配置${detail ? `: ${detail}` : ""}`)
  }
  const permissions = await execute(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=16m",
      "--mount",
      `type=volume,src=${volume},dst=/bridge`,
      "--mount",
      `type=volume,src=${tokenVolume},dst=/token`,
      "--user",
      "0:0",
      "ctf-agent-solver:latest",
      "sh",
      "-lc",
      "chmod 700 /bridge /token && chmod 600 /bridge/litellm.json /bridge/upstream.key && chmod 400 /token/bridge.key && chown -R 10001:10001 /bridge /token",
    ],
    { signal, timeoutMs: 30_000 },
  )
  if (permissions.code !== 0) {
    const detail = dockerResultDetail(permissions)
    throw new Error(`无法设置 Responses bridge 权限${detail ? `: ${detail}` : ""}`)
  }
}

async function startBridge(
  execute: DockerCommandExecutor,
  runtime: AuditRuntime,
  signal: AbortSignal,
): Promise<void> {
  const result = await execute(
    [
      "run",
      "-d",
      "--name",
      runtime.bridgeContainer,
      "--label",
      `com.ctf-agent.audit-run=${runtime.bridgeContainer}`,
      "--network",
      runtime.egressNetwork,
      "--network-alias",
      "litellm",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "--cpus",
      "1",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--mount",
      `type=volume,src=${runtime.bridgeVolume},dst=/bridge,readonly`,
      "--mount",
      `type=volume,src=${runtime.tokenVolume},dst=/token,readonly`,
      "--user",
      "10001:10001",
      "--entrypoint",
      "sh",
      LITELLM_IMAGE,
      "-lc",
      'set -eu; export PYTHONPATH=/bridge CTF_UPSTREAM_API_KEY="$(cat /bridge/upstream.key)" LITELLM_MASTER_KEY="$(cat /token/bridge.key)"; exec litellm --config /bridge/litellm.json --host 0.0.0.0 --port 4000 --telemetry False',
    ],
    { signal, timeoutMs: 60_000 },
  )
  if (result.code !== 0) {
    const detail = dockerResultDetail(result)
    throw new Error(`无法启动 Responses bridge${detail ? `: ${detail}` : ""}`)
  }
  const connected = await execute(
    ["network", "connect", "--alias", "litellm", runtime.internalNetwork, runtime.bridgeContainer],
    { signal, timeoutMs: 10_000 },
  )
  if (connected.code !== 0) throw new Error("无法连接 Responses bridge 隔离网络")
  await waitForBridge(execute, runtime.bridgeContainer, signal)
}

async function waitForBridge(
  execute: DockerCommandExecutor,
  container: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await execute(
      [
        "exec",
        container,
        "python3",
        "-c",
        "import socket; s=socket.create_connection(('127.0.0.1',4000),1); s.close()",
      ],
      { signal, timeoutMs: 3_000 },
    )
    if (probe.code === 0) return
    const state = await execute(["inspect", "-f", "{{.State.Running}}", container], {
      signal,
      timeoutMs: 3_000,
    })
    if (state.code !== 0 || state.stdout.trim() === "false")
      throw new Error("Responses bridge 启动失败")
    await delay(500, signal)
  }
  throw new Error("Responses bridge 启动超时")
}

async function cleanupRuntime(
  execute: DockerCommandExecutor,
  runtime: AuditRuntime | undefined,
): Promise<void> {
  if (!runtime) return
  await execute(["rm", "-f", runtime.container]).catch(() => undefined)
  await execute(["rm", "-f", runtime.bridgeContainer]).catch(() => undefined)
  await execute(["network", "rm", runtime.internalNetwork]).catch(() => undefined)
  await execute(["network", "rm", runtime.egressNetwork]).catch(() => undefined)
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      callback()
    }
    const timer = setTimeout(() => finish(resolve), milliseconds)
    const abort = () => finish(() => reject(new Error("审计已取消")))
    signal.addEventListener("abort", abort, { once: true })
  })
}

function litellmConfig(
  model: { model: string; baseUrl: string; providerApi: string },
  modelName: string,
): Record<string, unknown> {
  const isAnthropic = model.providerApi === "anthropic-messages"
  const params: Record<string, unknown> = {
    model: isAnthropic ? `anthropic/${model.model}` : `openai/${model.model}`,
    api_base:
      model.providerApi === "anthropic-messages"
        ? model.baseUrl.replace(/\/v1\/?$/i, "")
        : model.baseUrl,
    api_key: "os.environ/CTF_UPSTREAM_API_KEY",
    drop_params: true,
    additional_drop_params: ["web_search_options", "client_metadata"],
  }
  if (model.providerApi === "openai-completions") params.use_chat_completions_api = true
  return {
    model_list: [{ model_name: modelName, litellm_params: params }],
    general_settings: { master_key: "os.environ/LITELLM_MASTER_KEY" },
    litellm_settings: {
      set_verbose: false,
      json_logs: false,
      drop_params: true,
      callbacks: ["custom_callbacks.proxy_handler_instance"],
    },
  }
}

function codexBridgeCommand(
  mode: "standard" | "deep",
  modelName: string,
  hasFollowUpPrompt = false,
): string {
  const args = [
    "codex-security",
    "scan",
    "/source",
    "--mode",
    mode,
    "--output-dir",
    "/output",
    "--headless",
    "--auth",
    "api-key",
    "--model",
    modelName,
    "--effort",
    "medium",
    "--codex",
    `model_provider=${JSON.stringify(BRIDGE_PROVIDER)}`,
    "--codex",
    "features.multi_agent_v2.max_concurrent_threads_per_session=6",
  ]
  if (hasFollowUpPrompt) args.push("--post-scan-prompt-file", "/runtime/follow-up.md")
  return `export OPENAI_API_KEY="$(cat /bridge/bridge.key)"; exec ${args.map(shellPath).join(" ")}`
}

/*
 * Prompts are operator input, not command-line input. Pipe them into a private
 * runtime volume so shell quoting and Docker inspection cannot expose them.
 */
async function writeRuntimePrompt(
  execute: DockerCommandExecutor,
  volume: string,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await execute(
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--mount",
      `type=volume,src=${volume},dst=/runtime`,
      "--user",
      "0:0",
      "ctf-agent-solver:latest",
      "python3",
      "-c",
      "import pathlib, sys; path=pathlib.Path('/runtime/follow-up.md'); path.write_text(sys.stdin.read(), encoding='utf-8'); path.chmod(0o600)",
    ],
    { input: prompt, signal, timeoutMs: 30_000 },
  )
  if (result.code !== 0) throw new Error("无法保存 follow-up prompt")
}

const BRIDGE_FILE_WRITER = `import json, pathlib, sys
payload=json.load(sys.stdin)
root=pathlib.Path('/bridge')
(root/'litellm.json').write_text(payload['config'], encoding='utf-8')
(root/'upstream.key').write_text(payload['upstreamKey'], encoding='utf-8')
(root/'custom_callbacks.py').write_text(payload['callback'], encoding='utf-8')
token=pathlib.Path('/token')
token.mkdir(parents=True, exist_ok=True)
(token/'bridge.key').write_text(payload['bridgeToken'], encoding='utf-8')`

const BRIDGE_CALLBACK = `from collections.abc import Mapping
from litellm.integrations.custom_logger import CustomLogger


def _is_empty_assistant_message(value):
    if not isinstance(value, Mapping) or value.get("role") != "assistant":
        return False
    if value.get("tool_calls"):
        return False
    content = value.get("content")
    if content is None or content == [] or content == "":
        return True
    if isinstance(content, list):
        return all(
            isinstance(part, Mapping)
            and part.get("type") in ("output_text", "text")
            and not str(part.get("text") or "").strip()
            for part in content
        )
    return False


def _remove_empty_assistant_messages(value):
    if not isinstance(value, list):
        return value
    return [item for item in value if not _is_empty_assistant_message(item)]


def _sanitize_tool_call_history(value):
    if not isinstance(value, list):
        return value
    sanitized = []
    pending_tool_calls = set()
    for item in value:
        if not isinstance(item, Mapping):
            sanitized.append(item)
            continue
        role = item.get("role")
        if role == "assistant" and item.get("tool_calls"):
            pending_tool_calls.update(
                call.get("id")
                for call in item["tool_calls"]
                if isinstance(call, Mapping) and isinstance(call.get("id"), str)
            )
            sanitized.append(item)
            continue
        if role == "tool":
            tool_call_id = item.get("tool_call_id")
            if tool_call_id in pending_tool_calls:
                pending_tool_calls.discard(tool_call_id)
                sanitized.append(item)
            continue
        if role == "assistant" and pending_tool_calls:
            # The Responses-to-Chat adapter can emit a new assistant turn before
            # all function outputs. Do not send an invalid partial tool-call turn.
            continue
        sanitized.append(item)
    return sanitized


class ResponsesInputSanitizer(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if isinstance(data, dict):
            if isinstance(data.get("input"), list):
                data["input"] = _remove_empty_assistant_messages(data["input"])
            if isinstance(data.get("messages"), list):
                data["messages"] = _sanitize_tool_call_history(
                    _remove_empty_assistant_messages(data["messages"])
                )
        return data

    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        if isinstance(kwargs, dict):
            if isinstance(kwargs.get("input"), list):
                kwargs["input"] = _remove_empty_assistant_messages(kwargs["input"])
            if isinstance(kwargs.get("messages"), list):
                kwargs["messages"] = _sanitize_tool_call_history(
                    _remove_empty_assistant_messages(kwargs["messages"])
                )
        return kwargs


proxy_handler_instance = ResponsesInputSanitizer()`

function bridgeModelName(runId: string): string {
  return `ctf-audit-${runId}`
}

async function unpackArchive(
  execute: DockerCommandExecutor,
  archive: string,
  destinationVolume: string,
  signal: AbortSignal,
): Promise<void> {
  const archiveAccess = archiveContainerAccess(archive)
  const command = /\.zip$/i.test(archive)
    ? `unzip -q ${shellPath(archiveAccess.path)} -d /source`
    : /\.tar$/i.test(archive)
      ? `tar -xf ${shellPath(archiveAccess.path)} -C /source`
      : `tar -xzf ${shellPath(archiveAccess.path)} -C /source`
  const validation = await execute(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...archiveAccess.arguments,
      "ctf-agent-solver:latest",
      "sh",
      "-lc",
      archiveValidationCommand(archive, archiveAccess.path),
    ],
    { signal, timeoutMs: 60_000 },
  )
  if (validation.code !== 0) throw new Error("压缩包包含不安全条目或超过展开限制")
  const result = await execute(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...archiveAccess.arguments,
      "--mount",
      `type=volume,src=${destinationVolume},dst=/source`,
      // Solver image is built alongside the audit image and already carries tar/unzip.
      "ctf-agent-solver:latest",
      "sh",
      "-lc",
      command,
    ],
    { signal, timeoutMs: 60_000 },
  )
  if (result.code !== 0) throw new Error("压缩包解包失败")
}

function archiveContainerAccess(path: string): { arguments: string[]; path: string } {
  const volume = process.env.CTF_AGENT_DATA_VOLUME
  const dataRoot = "/data/.ctf-agent"
  if (process.env.CONTAINER_ENV === "docker" && volume && path.startsWith(`${dataRoot}/`)) {
    return {
      arguments: ["--mount", `type=volume,src=${volume},dst=${dataRoot},readonly`],
      path,
    }
  }
  return { arguments: ["--mount", `type=bind,src=${path},dst=/archive,readonly`], path: "/archive" }
}
function shellPath(path: string): string {
  return `'${path.replaceAll("'", "'\\\"'\\\"'")}'`
}
function archiveValidationCommand(archive: string, path: string): string {
  const kind = /\.zip$/i.test(archive) ? "zip" : "tar"
  return `python3 - <<'PY'
import os, sys, tarfile, zipfile
path = ${JSON.stringify(path)}
kind = '${kind}'
limit_entries, limit_bytes = 100_000, 2 * 1024 * 1024 * 1024
def safe(name):
    normalized = name.replace('\\\\', '/')
    return normalized and not normalized.startswith('/') and '..' not in normalized.split('/')
if kind == 'zip':
    entries = zipfile.ZipFile(path).infolist()
    invalid = any(not safe(item.filename) or item.is_dir() is False and ((item.external_attr >> 16) & 0o170000) == 0o120000 for item in entries)
    size = sum(item.file_size for item in entries)
else:
    entries = tarfile.open(path, 'r:*').getmembers()
    invalid = any(not safe(item.name) or item.issym() or item.islnk() or item.isdev() or item.isfifo() for item in entries)
    size = sum(item.size for item in entries)
sys.exit(0 if entries and len(entries) <= limit_entries and size <= limit_bytes and not invalid else 1)
PY`
}

async function applyScope(
  execute: DockerCommandExecutor,
  sourceVolume: string,
  scopeVolume: string,
  includePaths: readonly string[],
  excludePaths: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const rules = JSON.stringify({ includePaths, excludePaths })
  const script = `RULES='${rules.replaceAll("'", "'\\\"'\\\"'")}' python3 - <<'PY'
import fnmatch, json, os, shutil
rules = json.loads(os.environ['RULES'])
include = rules['includePaths'] or ['**']
exclude = rules['excludePaths']
def matches(path, patterns):
    return any(fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(path, pattern.removesuffix('/**')) for pattern in patterns)
base = '/source'
entries = [name for name in os.listdir(base) if not os.path.islink(os.path.join(base, name))]
if len(entries) == 1 and os.path.isdir(os.path.join(base, entries[0])):
    base = os.path.join(base, entries[0])
for root, dirs, files in os.walk(base, followlinks=False):
    dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(root, name))]
    for name in files:
        source = os.path.join(root, name)
        if os.path.islink(source): continue
        path = os.path.relpath(source, base).replace(os.sep, '/')
        if matches(path, include) and not matches(path, exclude):
            target = os.path.join('/scope', path)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(source, target)
PY`
  const result = await execute(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=volume,src=${sourceVolume},dst=/source,readonly`,
      "--mount",
      `type=volume,src=${scopeVolume},dst=/scope`,
      "ctf-agent-solver:latest",
      "sh",
      "-lc",
      script,
    ],
    { signal, timeoutMs: 60_000 },
  )
  if (result.code !== 0) throw new Error("无法按项目配置准备审计范围")
}

async function createVolume(
  execute: DockerCommandExecutor,
  volume: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await execute(
    ["volume", "create", "--label", "com.ctf-agent.audit-volume=1", volume],
    { signal, timeoutMs: 10_000 },
  )
  if (result.code !== 0) throw new Error("无法创建隔离审计卷")
}

async function removeVolume(execute: DockerCommandExecutor, volume: string): Promise<void> {
  await execute(["volume", "rm", "-f", volume]).catch(() => undefined)
}

async function prepareHostOutput(
  execute: DockerCommandExecutor,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const access = outputContainerAccess(destination)
  const result = await execute(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges",
      ...access.arguments,
      "--user",
      "0:0",
      "ctf-agent-solver:latest",
      "sh",
      "-lc",
      `mkdir -p ${shellPath(access.path)} && chown 10001:10001 ${shellPath(access.path)}`,
    ],
    { signal, timeoutMs: 30_000 },
  )
  if (result.code !== 0) {
    const detail = dockerResultDetail(result)
    throw new Error(`无法准备审计结果目录${detail ? `: ${detail}` : ""}`)
  }
}

async function exportOutput(
  execute: DockerCommandExecutor,
  volume: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const destinationAccess = outputContainerAccess(destination)
  const result = await execute(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=volume,src=${volume},dst=/output,readonly`,
      ...destinationAccess.arguments,
      "--user",
      "10001:10001",
      "ctf-agent-solver:latest",
      "sh",
      "-lc",
      `cp -r /output/. ${shellPath(destinationAccess.path)}/`,
    ],
    { signal, timeoutMs: 60_000 },
  )
  if (result.code !== 0)
    throw new Error(
      `无法导出审计结果${dockerResultDetail(result) ? `: ${dockerResultDetail(result)}` : ""}`,
    )
}

function outputContainerAccess(path: string): { arguments: string[]; path: string } {
  const volume = process.env.CTF_AGENT_DATA_VOLUME
  const dataRoot = "/data/.ctf-agent"
  if (process.env.CONTAINER_ENV === "docker" && volume && path.startsWith(`${dataRoot}/`)) {
    return {
      arguments: [`--mount`, `type=volume,src=${volume},dst=/host-data`],
      path: `/host-data${path.slice(dataRoot.length)}`,
    }
  }
  return {
    arguments: [`--mount`, `type=bind,src=${path},dst=/host-output`],
    path: "/host-output",
  }
}

async function ingestFindings(store: AuditStore, runId: string, output: string): Promise<void> {
  const raw = JSON.parse(await readFile(join(output, "findings.json"), "utf8")) as {
    findings?: unknown[]
  }
  const findings = Array.isArray(raw.findings) ? raw.findings : []
  store.replaceFindings(
    runId,
    findings.flatMap((candidate) => parseFinding(candidate, runId)),
  )
}
function parseFinding(value: unknown, runId: string) {
  if (typeof value !== "object" || value === null) return []
  const item = value as Record<string, unknown>
  const severity = (item.severity as { level?: unknown } | undefined)?.level
  const confidence = (item.confidence as { level?: unknown } | undefined)?.level
  const location = Array.isArray(item.locations)
    ? (item.locations[0] as Record<string, unknown> | undefined)
    : undefined
  if (
    !isSeverity(severity) ||
    !isConfidence(confidence) ||
    typeof item.findingId !== "string" ||
    typeof item.title !== "string" ||
    typeof item.summary !== "string" ||
    typeof item.remediation !== "string" ||
    typeof location?.path !== "string" ||
    typeof location.startLine !== "number"
  )
    return []
  return [
    {
      id: randomUUID(),
      runId,
      findingId: item.findingId,
      title: item.title,
      summary: item.summary,
      severity,
      confidence,
      path: location.path,
      startLine: location.startLine,
      remediation: item.remediation,
    },
  ]
}
async function resourceIds(execute: DockerCommandExecutor, args: string[]): Promise<string[]> {
  const result = await execute(args, { timeoutMs: 10_000 }).catch(() => undefined)
  if (!result || result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function isSeverity(
  value: unknown,
): value is "critical" | "high" | "medium" | "low" | "informational" {
  return ["critical", "high", "medium", "low", "informational"].includes(String(value))
}
function isConfidence(value: unknown): value is "high" | "medium" | "low" {
  return ["high", "medium", "low"].includes(String(value))
}
function containerName(runId: string): string {
  return `ctf-agent-audit-${runId}`
}
function bridgeContainerName(runId: string): string {
  return `ctf-agent-audit-bridge-${runId}`
}
function networkName(runId: string, kind: "internal" | "egress"): string {
  return `ctf-agent-audit-${runId}-${kind}`
}
function volumeName(
  runId: string,
  kind: "source" | "scope" | "output" | "bridge" | "token" | "runtime",
): string {
  return `ctf-agent-audit-${runId}-${kind}`
}
function dockerResultDetail(result: { stdout: string; stderr: string }): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\\n").slice(0, 1_000)
}
function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return /(?:api[_-]?key|token|secret|bearer)\s*[:=]/iu.test(text)
    ? "[redacted]"
    : text.slice(0, 4_000)
}

function recordWorkerProgress(store: AuditStore, runId: string, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const message = line.trim()
    if (!message) continue
    const progress = /Scan phase:\s*([^(:]+)\s*\((\d+)\/(\d+) files?\)/iu.exec(message)
    const running = /Running scan:\s*([^|]+)\|\s*Files:\s*(\d+)\/(\d+)/iu.exec(message)
    const match = progress ?? running
    if (!match) continue
    const phase = (match[1] ?? "scan").trim()
    store.updateRun(runId, {
      status: "running",
      progress: {
        phase,
        message,
        filesCompleted: Number(match[2]),
        filesTotal: Number(match[3]),
        updatedAt: new Date().toISOString(),
      },
    })
  }
}

async function appendWorkerLog(path: string, chunk: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined)
  await writeFile(path, chunk, { encoding: "utf8", flag: "a" }).catch(() => undefined)
}

async function preserveFailureArtifacts(
  execute: DockerCommandExecutor,
  runtime: AuditRuntime,
  outputVolume: string,
  output: string,
  preservedRuntime: string,
): Promise<void> {
  await mkdir(output, { recursive: true }).catch(() => undefined)
  await mkdir(preservedRuntime, { recursive: true }).catch(() => undefined)
  await copyVolumeToHost(execute, outputVolume, output)
  await copyVolumeToHost(execute, runtime.runtimeVolume, preservedRuntime)
}

async function copyVolumeToHost(
  execute: DockerCommandExecutor,
  volume: string,
  destination: string,
): Promise<void> {
  const access = outputContainerAccess(destination)
  const result = await execute(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=volume,src=${volume},dst=/volume,readonly`,
      ...access.arguments,
      "--user",
      "10001:10001",
      "ctf-agent-solver:latest",
      "sh",
      "-lc",
      `mkdir -p ${shellPath(access.path)} && cp -a /volume/. ${shellPath(access.path)}/ && chown -R 10001:10001 ${shellPath(access.path)}/`,
    ],
    { timeoutMs: 120_000 },
  )
  if (result.code !== 0) return
}
