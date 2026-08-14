import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuditStore, type CodeAuditRun } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { CodeAuditRunner } from "../src/domain/code-audit-runner.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const result = { code: 0, stdout: "", stderr: "" }

describe("CodeAuditRunner", () => {
  it("runs untrusted source through constrained containers and imports only canonical findings/report", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-runner-"))
    roots.push(root)
    const archive = join(root, "source.zip")
    await writeFile(archive, "not-a-real-zip")
    const storePath = join(root, "audits.sqlite")
    const store = await AuditStore.open(storePath)
    const audit = store.create({
      name: "服务",
      archiveName: "source.zip",
      archiveSize: 1,
      archivePath: archive,
    })
    const run = store.createRun(audit.id, "standard", {
      purpose: "follow_up",
      parentRunId: "previous-run",
      followUpPrompt: "继续检查认证边界并验证代码引用",
    }) as CodeAuditRun
    store.close()
    const commands: string[][] = []
    const inputs: string[] = []
    const execute = async (args: string[], options?: { input?: string }) => {
      commands.push(args)
      if (options?.input) inputs.push(options.input)
      if (
        args.includes("ctf-agent-solver:latest") &&
        args.some(
          (value) =>
            (value.includes("cp -a /output/.") || value.includes("cp -r /output/.")) &&
            value.includes("/host-output"),
        )
      ) {
        const output = args.find((x) => x.includes("dst=/host-output"))?.match(/src=([^,]+)/)?.[1]
        if (output) {
          await mkdir(output, { recursive: true })
          await writeFile(
            join(output, "findings.json"),
            JSON.stringify({
              findings: [
                {
                  findingId: "f-1",
                  title: "缺少授权",
                  summary: "入口未授权",
                  severity: { level: "high" },
                  confidence: { level: "high" },
                  locations: [{ path: "src/auth.ts", startLine: 12 }],
                  remediation: "检查所有权",
                },
              ],
            }),
          )
          await writeFile(join(output, "report.md"), "# 报告")
        }
      }
      return result
    }
    const models = {
      codexSecurityConfiguration: async () => ({
        model: "audit-model",
        baseUrl: "https://pool.example/v1",
        apiKey: "secret",
        providerApi: "openai-completions",
      }),
    } as never
    const runner = new CodeAuditRunner(join(root, "work"), storePath, models, execute)
    await runner.run(run, { ...audit, auditModelId: "audit-model" })
    const check = await AuditStore.open(storePath)
    expect(check.runs(audit.id)[0]).toMatchObject({ status: "completed" })
    expect(check.findings(run.id)).toMatchObject([{ findingId: "f-1", path: "src/auth.ts" }])
    expect(check.report(run.id)).toBe("# 报告")
    expect(check.runs(audit.id)[0]?.progress).toBeUndefined()
    check.close()
    const archiveValidation = commands.find((args) =>
      args.some((value) => value.includes("zipfile.ZipFile")),
    )
    expect(archiveValidation).toEqual(
      expect.arrayContaining(["--network", "none", "--cap-drop", "ALL"]),
    )
    const auditCommand = commands.find((args) => args.includes("ctf-agent-audit:latest")) ?? []
    expect(auditCommand).toContain("--read-only")
    expect(auditCommand).toContain("--init")
    expect(auditCommand).toContain("--pids-limit")
    expect(auditCommand).toContain("512")
    expect(auditCommand).toContain("--cap-drop")
    expect(auditCommand).toContain("ALL")
    const auditText = auditCommand.join(" ")
    expect(auditText).toContain("--output-dir")
    expect(auditText).toContain("/output")
    expect(auditText).toContain("--post-scan-prompt-file")
    expect(auditText).toContain("/runtime/follow-up.md")
    const promptWriter =
      commands.find(
        (args) => args.includes("python3") && args.some((value) => value.includes("follow-up.md")),
      ) ?? []
    expect(promptWriter).toEqual(expect.arrayContaining(["-i", "--read-only"]))
    expect(inputs).toContain("继续检查认证边界并验证代码引用")
    expect(auditText).toContain("--model")
    expect(auditText).toContain("ctf-audit-")
    expect(auditText).toContain("http://litellm:4000/v1")
    expect(auditText).toContain("dst=/source,readonly")
    expect(auditText).toContain("dst=/runtime")
    expect(auditText).toContain("CODEX_OSS_BASE_URL=http://litellm:4000/v1")
    expect(auditText).toContain("CODEX_SECURITY_STATE_DIR=/runtime/state")
    expect(auditText).toContain("CODEX_HOME=/runtime/codex-home")
    expect(auditText).toContain("/bridge/bridge.key")
    expect(auditText).toContain('model_provider="lmstudio"')
    expect(auditText).not.toContain("secret")
    const bridgeWriter = commands.find((args) => args.includes("python3")) ?? []
    expect(bridgeWriter).toContain("CHOWN")
    const permissionCommand = commands.find((args) =>
      args.some((value) => value.includes("chmod 700 /bridge /token")),
    )
    expect(permissionCommand).toEqual(
      expect.arrayContaining(["--user", "0:0", "--cap-add", "CHOWN"]),
    )
    const bridgeCommand =
      commands.find((args) => args.some((value) => value.includes("litellm/litellm@sha256:"))) ?? []
    expect(bridgeCommand).toEqual(expect.arrayContaining(["--user", "10001:10001"]))
    const bridgePayload = JSON.parse(
      inputs.find((input) => input.trimStart().startsWith("{")) ?? "{}",
    ) as {
      config?: string
      callback?: string
      upstreamKey?: string
      bridgeToken?: string
    }
    expect(bridgePayload.config).toContain('"use_chat_completions_api":true')
    expect(bridgePayload.config).toContain(
      '"additional_drop_params":["web_search_options","client_metadata"]',
    )
    expect(bridgePayload.config).not.toContain("secret")
    expect(bridgePayload.config).toContain('"custom_callbacks.proxy_handler_instance"')
    expect(bridgePayload.callback).toContain("CustomLogger")
    expect(bridgePayload.callback).toContain("async_pre_call_hook")
    expect(bridgePayload.callback).toContain("async_pre_call_deployment_hook")
    expect(bridgePayload.callback).toContain("empty_assistant_message")
    expect(bridgePayload.callback).toContain('data.get("messages")')
    expect(bridgePayload.upstreamKey).toBe("secret")
    expect(bridgePayload.bridgeToken).toMatch(/^sk-ctf-/)
    expect(commands.some((args) => args.includes("network") && args.includes("create"))).toBe(true)
    expect(commands.some((args) => args.includes("network") && args.includes("rm"))).toBe(true)
  })

  it("prepares the host output directory with the container path as one argument", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-output-"))
    roots.push(root)
    const archive = join(root, "source.zip")
    await writeFile(archive, "not-a-real-zip")
    const storePath = join(root, "audits.sqlite")
    const store = await AuditStore.open(storePath)
    const audit = store.create({
      name: "服务",
      archiveName: "source.zip",
      archiveSize: 1,
      archivePath: archive,
    })
    const run = store.createRun(audit.id, "standard") as CodeAuditRun
    store.close()
    const commands: string[][] = []
    const execute = async (args: string[]) => {
      commands.push(args)
      if (
        args.includes("ctf-agent-solver:latest") &&
        args.some((value) => value.includes("mkdir"))
      ) {
        return result
      }
      return result
    }
    const runner = new CodeAuditRunner(
      join(root, "work"),
      storePath,
      {
        codexSecurityConfiguration: async () => ({
          model: "audit-model",
          baseUrl: "https://pool.example/v1",
          apiKey: "secret",
          providerApi: "openai-completions",
        }),
      } as never,
      execute,
    )
    await runner.run(run, { ...audit, auditModelId: "audit-model" })
    const prepare = commands.find((args) =>
      args.some((value) => value.includes("mkdir -p") && value.includes("/host-output")),
    )
    expect(prepare).toBeDefined()
  })

  it("records worker scan progress in the independent audit store", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-progress-"))
    roots.push(root)
    const archive = join(root, "source.zip")
    await writeFile(archive, "not-a-real-zip")
    const storePath = join(root, "audits.sqlite")
    const store = await AuditStore.open(storePath)
    const audit = store.create({
      name: "服务",
      archiveName: "source.zip",
      archiveSize: 1,
      archivePath: archive,
    })
    const run = store.createRun(audit.id, "standard") as CodeAuditRun
    store.close()
    let emitted = false
    const execute = async (args: string[], options?: { onStdout?: (chunk: string) => void }) => {
      if (args.includes("ctf-agent-audit:latest") && !emitted) {
        emitted = true
        options?.onStdout?.("[00:01] Scan phase: reviewing files (3/8 files)\\n")
      }
      return result
    }
    const runner = new CodeAuditRunner(
      join(root, "work"),
      storePath,
      {
        codexSecurityConfiguration: async () => ({
          model: "audit-model",
          baseUrl: "https://pool.example/v1",
          apiKey: "secret",
          providerApi: "openai-completions",
        }),
      } as never,
      execute,
    )
    await runner.run(run, { ...audit, auditModelId: "audit-model" })
    const check = await AuditStore.open(storePath)
    expect(check.runs(audit.id)[0]?.progress).toMatchObject({
      phase: "reviewing files",
      filesCompleted: 3,
      filesTotal: 8,
    })
    check.close()
  })
})
