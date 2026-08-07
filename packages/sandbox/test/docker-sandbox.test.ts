import {
  DEFAULT_DOCKER_SANDBOX_RESOURCES,
  type DockerSandboxOptions,
  dockerSandboxCreateArguments,
} from "@ctf-agent/sandbox"
import { describe, expect, it } from "vitest"

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

describe("DockerSandbox resources", () => {
  it("默认限制每个 Solver 容器的 CPU、内存、swap、PID 与存储", () => {
    const args = dockerSandboxCreateArguments(options)

    expect(valueAfter(args, "--cpus")).toBe(
      String(DEFAULT_DOCKER_SANDBOX_RESOURCES.cpus),
    )
    expect(valueAfter(args, "--memory")).toBe(
      String(DEFAULT_DOCKER_SANDBOX_RESOURCES.memoryBytes),
    )
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
})
