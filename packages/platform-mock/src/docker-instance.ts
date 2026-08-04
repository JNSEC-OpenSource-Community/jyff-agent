// packages/platform-mock/src/docker-instance.ts
// 真实容器实例提供者:远程题以 Docker 容器启动,FLAG 通过环境变量动态注入。
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { RemoteEnvironment } from "@ctf-agent/platform"

const exec = promisify(execFile)

export interface ContainerSpec {
  image: string
  port: number
  network: string
  flag: string
}

export class DockerInstanceProvider {
  static readonly networkName = "ctf-net"

  static async ensureNetwork(): Promise<void> {
    try {
      await exec("docker", ["network", "create", DockerInstanceProvider.networkName])
    } catch (error) {
      if (!String(error).includes("already exists")) throw error
    }
  }

  /** 按容器名销毁(rm -f),幂等;集成方(容器名已知、spec 未持有)使用此 API。 */
  static async destroyByName(containerName: string): Promise<void> {
    try { await exec("docker", ["rm", "-f", containerName]) } catch { /* 已删除,幂等 */ }
  }

  constructor(
    private readonly spec: ContainerSpec,
    private readonly containerName: string,
  ) {}

  /**
   * 查询容器实际发布的宿主端口(docker run -p 127.0.0.1::<port> 随机映射)。
   * 输出形如 "9999/tcp -> 127.0.0.1:51234",取最后一个数字段。
   */
  private async hostPort(): Promise<number> {
    const { stdout } = await exec("docker", ["port", this.containerName])
    const match = /(\d+)\s*$/.exec(stdout.trim())
    if (!match) throw new Error(`无法解析容器 ${this.containerName} 的宿主端口: ${stdout.trim()}`)
    return Number(match[1])
  }

  /** endpoint 指向宿主发布端口:求解沙箱(host 网络)经 127.0.0.1:<宿主端口> 连接实例。 */
  private async endpoint(): Promise<string> {
    return `tcp://127.0.0.1:${await this.hostPort()}`
  }

  async start(): Promise<RemoteEnvironment> {
    await DockerInstanceProvider.ensureNetwork()
    await exec("docker", [
      "run", "-d", "--rm",
      "--name", this.containerName,
      "--network", this.spec.network,
      "-e", `FLAG=${this.spec.flag}`,
      "-p", `127.0.0.1::${this.spec.port}`,
      this.spec.image,
      // 保持容器存活:alpine 裸启动 sh 会立即退出,容器(含 FLAG)随之被 --rm 移除
      "sh", "-c", "sleep 86400",
    ])
    return { id: this.containerName, challengeId: this.containerName, status: "running", endpoint: await this.endpoint() }
  }

  async status(): Promise<RemoteEnvironment | null> {
    try {
      const { stdout } = await exec("docker", ["inspect", "-f", "{{.State.Running}}", this.containerName])
      return stdout.trim() === "true"
        ? { id: this.containerName, challengeId: this.containerName, status: "running", endpoint: await this.endpoint() }
        : null
    } catch {
      return null
    }
  }

  async destroy(): Promise<void> {
    await DockerInstanceProvider.destroyByName(this.containerName)
  }
}
