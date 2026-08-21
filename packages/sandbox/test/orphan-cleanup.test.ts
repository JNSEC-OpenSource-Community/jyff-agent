import { type DockerCommandExecutor, removeManagedContainers } from "@ctf-agent/sandbox"
import { describe, expect, it, vi } from "vite-plus/test"

describe("遗留 Docker Sandbox 回收", () => {
  it("列举托管容器失败时报告错误，而不是误判为没有遗留资源", async () => {
    const execute = vi.fn<DockerCommandExecutor>().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "docker daemon unavailable",
    })

    await expect(removeManagedContainers(["run-orphaned"], execute)).rejects.toThrow(
      "Docker list failed: docker daemon unavailable",
    )
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
