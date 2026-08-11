import {
  type CommandResult,
  DEFAULT_DOCKER_SANDBOX_RESOURCES,
  type DockerCommandExecutor,
  DockerSandbox,
  type DockerSandboxOptions,
  dockerSandboxCreateArguments,
} from "@ctf-agent/sandbox"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const options: DockerSandboxOptions = {
  projectId: "project",
  runId: "run",
  image: "solver:latest",
  workspace: "/host/workspace",
  privileged: false,
  networkMode: "bridge",
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

function result(code: number, output: { stdout?: string; stderr?: string } = {}): CommandResult {
  return {
    code,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DockerSandbox resources", () => {
  it("默认限制每个 Solver 容器的 CPU、内存、swap、PID 与存储", () => {
    const args = dockerSandboxCreateArguments(options)

    expect(valueAfter(args, "--cpus")).toBe(String(DEFAULT_DOCKER_SANDBOX_RESOURCES.cpus))
    expect(valueAfter(args, "--memory")).toBe(String(DEFAULT_DOCKER_SANDBOX_RESOURCES.memoryBytes))
    expect(valueAfter(args, "--memory-swap")).toBe(
      String(DEFAULT_DOCKER_SANDBOX_RESOURCES.memorySwapBytes),
    )
    expect(valueAfter(args, "--pids-limit")).toBe(
      String(DEFAULT_DOCKER_SANDBOX_RESOURCES.pidsLimit),
    )
    expect(valueAfter(args, "--storage-opt")).toBe(
      `size=${DEFAULT_DOCKER_SANDBOX_RESOURCES.storageBytes}`,
    )
  })

  it("允许调用方收紧资源并拒绝小于内存的 swap 上限", () => {
    const args = dockerSandboxCreateArguments({
      ...options,
      resources: {
        cpus: 1.5,
        memoryBytes: 1024,
        memorySwapBytes: 2048,
        pidsLimit: 32,
        storageBytes: 4096,
      },
    })
    expect(valueAfter(args, "--cpus")).toBe("1.5")
    expect(valueAfter(args, "--memory")).toBe("1024")
    expect(valueAfter(args, "--memory-swap")).toBe("2048")
    expect(valueAfter(args, "--pids-limit")).toBe("32")
    expect(valueAfter(args, "--storage-opt")).toBe("size=4096")

    expect(() =>
      dockerSandboxCreateArguments({
        ...options,
        resources: { memoryBytes: 2048, memorySwapBytes: 1024 },
      }),
    ).toThrow("resources.memorySwapBytes must be >= resources.memoryBytes")
  })

  it("拒绝零值或负值的存储上限", () => {
    for (const storageBytes of [0, -1]) {
      expect(() =>
        dockerSandboxCreateArguments({
          ...options,
          resources: { storageBytes },
        }),
      ).toThrow("resources.storageBytes must be a positive safe integer")
    }
  })

  it("Docker 不支持可写层配额时只移除 storage-opt 并重试创建", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute
      .mockResolvedValueOnce(
        result(125, {
          stderr: "--storage-opt is supported only for overlay over xfs with 'pquota' mount option",
        }),
      )
      .mockResolvedValueOnce(result(0, { stdout: "container-id\n" }))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})

    const sandbox = await DockerSandbox.create(options, execute)
    await sandbox.close()

    expect(execute).toHaveBeenCalledTimes(4)
    expect(execute.mock.calls[0]?.[0]).toContain("--storage-opt")
    expect(execute.mock.calls[1]?.[0]).not.toContain("--storage-opt")
    expect(execute.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(["--cpus", "2", "--mount"]))
    expect(execute.mock.calls[2]?.[0]).toEqual(["start", "container-id"])
    expect(execute.mock.calls[3]?.[0]).toEqual(["rm", "-f", "container-id"])
    expect(warning).toHaveBeenCalledOnce()
  })

  it("普通 Docker 创建错误不移除资源限制或重试", async () => {
    const execute = vi
      .fn<DockerCommandExecutor>()
      .mockResolvedValueOnce(result(125, { stderr: "permission denied" }))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(DockerSandbox.create(options, execute)).rejects.toThrow(
      "Docker create failed: permission denied",
    )

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toContain("--storage-opt")
    expect(warning).not.toHaveBeenCalled()
  })

  it("无配额重试仍失败时保留第二次 Docker 错误", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute
      .mockResolvedValueOnce(
        result(125, {
          stderr: "storage-opt size is not supported for this graph driver",
        }),
      )
      .mockResolvedValueOnce(result(125, { stderr: "image not found" }))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(DockerSandbox.create(options, execute)).rejects.toThrow(
      "Docker create failed: image not found",
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1]?.[0]).not.toContain("--storage-opt")
  })

  it("旧版 Docker 不支持 volume-subpath 时以兼容工作目录重试", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute
      .mockResolvedValueOnce(
        result(125, {
          stderr: "unexpected key 'volume-subpath' in 'volume-subpath=father/sessions/a/workspace'",
        }),
      )
      .mockResolvedValueOnce(result(0, { stdout: "container-id\n" }))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})

    const sandbox = await DockerSandbox.create(
      {
        ...options,
        workspaceMount: {
          type: "volume",
          source: "ctf-agent-data",
          subpath: "father/sessions/a/workspace",
        },
      },
      execute,
    )
    await sandbox.close()

    const retry = execute.mock.calls[1]?.[0] ?? []
    expect(valueAfter(retry, "--mount")).toBe(
      "type=volume,src=ctf-agent-data,dst=/ctf-agent-volume",
    )
    expect(retry).toEqual(
      expect.arrayContaining([
        "sh",
        "-c",
        "mkdir -p /ctf-agent-volume/father/sessions/a/workspace && rm -rf /workspace && ln -s /ctf-agent-volume/father/sessions/a/workspace /workspace && exec sleep infinity",
      ]),
    )
    expect(warning).toHaveBeenCalledOnce()
  })
})
