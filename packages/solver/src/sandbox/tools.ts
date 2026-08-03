import { Buffer } from "node:buffer"
import { Type } from "typebox"
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import type { ChallengeCapability, FlagSubmission } from "../platform/types.ts"
import type { Sandbox } from "./docker-sandbox.ts"
import type { RunStore } from "../project/run-store.ts"
import { createBlackboardTools } from "../blackboard/index.ts"
import { RtkRewriter } from "./rtk.ts"

function result(details: object): AgentToolResult<Record<string, unknown>> {
  const value = details as Record<string, unknown>
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const FILE_HELPER = String.raw`
import json, sys
from pathlib import Path, PurePosixPath

root = Path('/workspace').resolve()
payload = json.loads(sys.stdin.read())
relative = payload.get('path', '')
if not isinstance(relative, str) or not relative or relative.startswith('/') or '\\' in relative:
    raise ValueError('路径必须是 workspace 内的相对 POSIX 路径')
parts = PurePosixPath(relative).parts
if '..' in parts or '.' in parts:
    raise ValueError('路径不能包含 . 或 ..')
target = root.joinpath(*parts)
resolved = target.resolve()
try:
    resolved.relative_to(root)
except ValueError:
    raise ValueError('路径或符号链接逃出了 /workspace')

op = payload['op']
if op == 'read':
    if not resolved.is_file(): raise ValueError('目标不是普通文件')
    text = resolved.read_text(encoding='utf-8')
    offset = payload.get('offset', 1)
    limit = payload.get('limit', 2000)
    lines = text.splitlines()
    print(json.dumps({'text': '\n'.join(lines[offset - 1:offset - 1 + limit]), 'totalLines': len(lines)}))
elif op == 'list':
    if not resolved.is_dir(): raise ValueError('目标不是目录')
    entries = []
    for child in sorted(resolved.iterdir(), key=lambda p: p.name):
        child_resolved = child.resolve()
        try: child_resolved.relative_to(root)
        except ValueError: continue
        entries.append({'name': child.name, 'type': 'directory' if child.is_dir() else 'file'})
    print(json.dumps({'entries': entries}))
elif op == 'write':
    parent = resolved.parent.resolve()
    try: parent.relative_to(root)
    except ValueError: raise ValueError('父目录逃出了 /workspace')
    parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(payload['content'], encoding='utf-8')
    print(json.dumps({'path': relative, 'bytes': len(payload['content'].encode())}))
elif op == 'write_bytes':
    import base64
    parent = resolved.parent.resolve()
    try: parent.relative_to(root)
    except ValueError: raise ValueError('父目录逃出了 /workspace')
    parent.mkdir(parents=True, exist_ok=True)
    content = base64.b64decode(payload['base64'], validate=True)
    resolved.write_bytes(content)
    print(json.dumps({'path': relative, 'bytes': len(content)}))
elif op == 'edit':
    if not resolved.is_file(): raise ValueError('目标不是普通文件')
    old = payload['oldText']
    text = resolved.read_text(encoding='utf-8')
    if text.count(old) != 1: raise ValueError('oldText 必须在文件中唯一匹配一次')
    updated = text.replace(old, payload['newText'], 1)
    resolved.write_text(updated, encoding='utf-8')
    print(json.dumps({'path': relative, 'replaced': True}))
else:
    raise ValueError('未知文件操作')
`

/** 文件操作通过 docker exec + Python 完成，宿主机只负责持有 bind mount。 */
class ContainerFiles {
  constructor(private readonly sandbox: Sandbox) { }

  private async run(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const execution = await this.sandbox.exec(["python3", "-c", FILE_HELPER], {
      input: JSON.stringify(payload),
      signal,
      timeoutMs: 10_000,
    })
    try {
      return JSON.parse(execution.stdout) as Record<string, unknown>
    } catch {
      throw new Error(`容器文件工具返回了无效 JSON: ${execution.stdout}`)
    }
  }

  read(path: string, offset: number | undefined, limit: number | undefined, signal?: AbortSignal) {
    return this.run({ op: "read", path, offset, limit }, signal)
  }

  list(path: string, signal?: AbortSignal) {
    return this.run({ op: "list", path }, signal)
  }

  write(path: string, content: string, signal?: AbortSignal) {
    return this.run({ op: "write", path, content }, signal)
  }

  writeBytes(path: string, content: Uint8Array, signal?: AbortSignal) {
    return this.run({ op: "write_bytes", path, base64: Buffer.from(content).toString("base64") }, signal)
  }

  edit(path: string, oldText: string, newText: string, signal?: AbortSignal) {
    return this.run({ op: "edit", path, oldText, newText }, signal)
  }
}

/** ctf_report_tool_need 的上报载荷(工具契约,随工具定义)。 */
export interface ToolNeedReport {
  tool: string
  reason: string
}

export interface SolverToolOptions {
  capability: ChallengeCapability
  sandbox: Sandbox
  onTerminalSubmission(submission: FlagSubmission): void
  blackboard?: {
    runStore: RunStore
    challengeId: string
    runId: string
  }
  /** 工具需求收集器回调;提供时才注册 ctf_report_tool_need(条件工具)。 */
  onToolNeedReport?: (report: ToolNeedReport) => void
}

/** 每个 tool closure 都捕获当前题 capability，调用方无法通过参数越题。 */
export function createSolverTools(options: SolverToolOptions): AgentTool[] {
  const files = new ContainerFiles(options.sandbox)
  const rtk = new RtkRewriter(options.sandbox)
  const tools: AgentTool[] = [
    {
      name: "bash",
      label: "Sandbox Bash",
      description: "在当前题目的 Docker sandbox 中执行 shell 命令；已安装工具索引见 /tools.txt。",
      parameters: Type.Object({ command: Type.String() }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as { command: string }
        const command = await rtk.rewrite(input.command, signal)
        const output = await options.sandbox.exec(["bash", "-lc", command], { signal })
        return result({ command, stdout: output.stdout, stderr: output.stderr })
      },
    },
    {
      name: "read",
      label: "Read Workspace File",
      description: "读取 Docker sandbox 内 /workspace 下的 UTF-8 文本文件。",
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })) }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as { path: string; offset?: number; limit?: number }
        return result(await files.read(input.path, input.offset, input.limit, signal))
      },
    },
    {
      name: "write",
      label: "Write Workspace File",
      description: "写入 Docker sandbox 内 /workspace 下的文本文件。",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as { path: string; content: string }
        return result(await files.write(input.path, input.content, signal))
      },
    },
    {
      name: "edit",
      label: "Edit Workspace File",
      description: "在 Docker sandbox 内唯一替换 workspace 文件中的文本。",
      parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as { path: string; oldText: string; newText: string }
        return result(await files.edit(input.path, input.oldText, input.newText, signal))
      },
    },
    {
      name: "list",
      label: "List Workspace Directory",
      description: "列出 Docker sandbox 内 /workspace 下的目录。",
      parameters: Type.Object({ path: Type.String() }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as { path: string }
        return result(await files.list(input.path, signal))
      },
    },
    {
      name: "ctf_challenge_info",
      label: "Challenge Info",
      description: "获取当前题目的说明与附件清单。",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() { return result(await options.capability.getInfo()) },
    },
    {
      name: "ctf_download_attachment",
      label: "Download Attachment",
      description: "下载当前题附件到 Docker sandbox 的 attachments 目录。",
      parameters: Type.Object({ attachmentId: Type.String() }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as { attachmentId: string }
        const downloaded = await options.capability.downloadAttachment(input.attachmentId)
        // 附件名来自平台，但仍通过同一容器路径校验逻辑写入。
        const saved = await files.writeBytes(`attachments/${downloaded.attachment.name}`, downloaded.content, signal)
        return result({ attachment: downloaded.attachment, ...saved })
      },
    },
    {
      name: "ctf_submit_flag",
      label: "Submit Flag",
      description: "向当前题目提交 Flag。",
      parameters: Type.Object({ flag: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as { flag: string }
        const submission = await options.capability.submitFlag(input.flag)
        if (submission.status === "accepted" || submission.status === "already_solved") options.onTerminalSubmission(submission)
        return result(submission)
      },
    },
  ]

  // 没有远程环境的题目根本不向模型暴露实例工具。
  if (options.capability.instance) {
    const instance = options.capability.instance
    tools.push(
      {
        name: "ctf_instance_start", label: "Start Challenge Instance", description: "启动当前题目的远程实例。", parameters: Type.Object({}), executionMode: "sequential",
        async execute() { return result(await instance.start() as unknown as Record<string, unknown>) },
      },
      {
        name: "ctf_instance_status", label: "Challenge Instance Status", description: "查询当前题目的远程实例。", parameters: Type.Object({}), executionMode: "sequential",
        async execute() { return result({ instance: await instance.status() }) },
      },
      {
        name: "ctf_instance_destroy", label: "Destroy Challenge Instance", description: "销毁当前题目的远程实例。", parameters: Type.Object({}), executionMode: "sequential",
        async execute() { await instance.destroy(); return result({ destroyed: true }) },
      },
    )
  }

  // 黑板工具（读写 Evidence 和 Opportunity）
  if (options.blackboard) {
    tools.push(...createBlackboardTools({
      runStore: options.blackboard.runStore,
      challengeId: options.blackboard.challengeId,
      runId: options.blackboard.runId,
    }))
  }

  // 工具需求上报(未接入收集器的调用方不向模型暴露该工具)
  if (options.onToolNeedReport) {
    tools.push({
      name: "ctf_report_tool_need",
      label: "Report Tool Need",
      description: "上报当前环境缺失的工具或命令。发现任何缺失工具（即使认为可以绕过）都必须第一时间调用本工具上报（附工具名与原因），不要自行判断是否必要；上报不会安装任何工具，随后可继续尝试替代思路。",
      parameters: Type.Object({
        tool: Type.String({ minLength: 1, maxLength: 128 }),
        reason: Type.String({ minLength: 1, maxLength: 2_000 }),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        options.onToolNeedReport!(params as ToolNeedReport)
        return result({ status: "recorded" })
      },
    })
  }

  return tools
}

export { ContainerFiles, errorText }
