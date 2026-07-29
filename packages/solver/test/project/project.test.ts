import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, type AgentOptions } from "@earendil-works/pi-agent-core"
import { afterEach, describe, expect, it } from "vitest"
import { mockPlatform } from "../../../platform-mock/src/index.js"
import { Project } from "../../src/project/project.js"
import type { CommandResult, DockerSandboxOptions, Sandbox } from "../../src/sandbox/docker-sandbox.js"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

class FakeSandbox implements Sandbox {
  readonly id = "fake-container"
  closed = false
  async exec(): Promise<CommandResult> { return { code: 0, stdout: "", stderr: "" } }
  async close(): Promise<void> { this.closed = true }
}

const agentOptions = {
  streamFn: (() => { throw new Error("本测试不调用模型") }) as AgentOptions["streamFn"],
} satisfies AgentOptions

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-project-"))
  roots.push(root)
  await writeFile(join(root, ".gitignore"), "")
  await mkdir(join(root, ".pi"), { recursive: true })
  await writeFile(join(root, ".pi", "ctf-config.json"), JSON.stringify({
    version: 1,
    project: { id: "test-project", name: "Test Project" },
    contest: { platform: "mock", eventId: "event" },
    platform: { config: {} },
    sandbox: { image: "test-image", privileged: true, networkMode: "none" },
  }))
  await mkdir(join(root, ".pi", "skills", "reverse"), { recursive: true })
  await writeFile(join(root, ".pi", "skills", "reverse", "SKILL.md"), "---\nname: reverse\ndescription: Analyze challenge binaries\n---\n# Reverse")
  return root
}

describe("Project", () => {
  it("创建题目绑定的 Agent、持久化 workspace，并在 close 后仅删除容器", async () => {
    const root = await fixture()
    const sandbox = new FakeSandbox()
    let received: DockerSandboxOptions | undefined
    const project = await Project.open({
      root,
      platforms: [mockPlatform],
      sandboxFactory: async (options) => {
        received = options
        return sandbox
      },
    })

    const solver = await project.createSolver("warmup-flag", { agent: agentOptions })
    expect(solver).toBeInstanceOf(Agent)
    expect(solver.challenge.id).toBe("warmup-flag")
    const toolNames = solver.state.tools.map((tool) => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining(["read", "write", "edit", "list", "bash"]))
    expect(toolNames).not.toContain("ctf_instance_start")
    expect(toolNames).toContain("load_skill")
    expect(solver.state.systemPrompt).toContain("<available_skills>")
    expect(solver.state.systemPrompt).toContain("/workspace/.skills/skill-1/SKILL.md")
    expect(received).toMatchObject({ projectId: "test-project", image: "test-image", privileged: true, networkMode: "none" })

    await solver.close()
    expect(sandbox.closed).toBe(true)
    expect(project.runs()).toEqual([
      expect.objectContaining({ challengeId: "warmup-flag", attempt: 1, status: "closed", closeReason: "manual" }),
    ])
    const run = JSON.parse(await readFile(join(root, ".ctf-agent", "runs", solver.runId, "run.json"), "utf8"))
    expect(run.workspace).toContain("workspace")
    await expect(access(run.workspace)).resolves.toBeUndefined()
    await expect(access(join(run.workspace, ".skills", "skill-1", "SKILL.md"))).resolves.toBeUndefined()
    expect(project.runEvents(solver.runId).map((event) => event.type)).toEqual([
      "run_created",
      "run_started",
      "run_finished",
    ])
    await project.close()
  })
})
