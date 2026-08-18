# 远程环境生命周期

本文描述 CTF 平台远程实例的配额、就绪、到期、共享和回收协议。远程实例与 Solver 的本地
Docker Sandbox 是两套资源：Sandbox 执行分析命令，远程实例提供题目服务 endpoint。

## 1. 单一所有者

```text
Solver / SubAgent tools
  ctf_instance_start / status
  Solver-only destroy
            │
            ▼
RemoteEnvironmentCoordinator（Project 级唯一所有者）
  配额、single-flight、FIFO、deadline、租约、到期通知、补偿清理
            │
            ▼
ChallengeCapability.instance（题目级平台适配器）
  start / waitUntilReady / status / destroy
            │
            ▼
CTF 平台实例、TCP/HTTP/WS 服务或本地流量代理
```

Agent 永远拿不到完整 `PlatformProject`。Solver 与 SubAgent 共享同一个 Run-scoped managed
capability，因此只能操作当前题目。Solver 可以 start/status/destroy；SubAgent 只能 start/status，
不能销毁实例或提交 Flag。

## 2. 状态与配额

协调器对 Dashboard 暴露以下状态：

| phase       | 是否占远程配额 | 含义                                      |
| ----------- | -------------- | ----------------------------------------- |
| `waiting`   | 否             | 没有名额，仍在协调器队列                  |
| `starting`  | 是             | 已预留名额，执行平台 start 和协议就绪检查 |
| `ready`     | 是             | endpoint 已确认可用并交付 Run             |
| `releasing` | 是             | destroy 尚未有界完成                      |

配额计算始终是：

```text
occupied = starting + ready
available = max(0, maximum - occupied)
```

`releasing` 是 ready 租约的投影，在 destroy 成功、内存状态和 SQLite 租约一起删除前不会向后续
请求发放同一名额。

等待请求仍分 `required`（无附件）和 `verification`（有附件）优先级；同优先级 FIFO，required
可以排到尚未开始的 verification 前面。**不存在活跃租约抢占**：已经取得环境的题可以一直使用，
直到解出、Blocked、取消、显式 destroy 或平台到期。降低配额也不销毁现有租约；占用自然下降到
新上限前不再启动新实例。

## 3. 每个 Run 的原子申请

一个 Run 同时最多有一个 pending、starting 或 active 远程状态。

多个参与者同时调用 `ctf_instance_start` 时：

1. 第一个调用创建 pending 请求；
2. 后续 Solver/SubAgent 调用加入同一个 Promise；
3. 平台只收到一次 start；
4. 所有调用者获得同一份已就绪环境结果。

如果 destroy 正在进行，新的 start 先等待同一个 release task 完成，再重新进入 acquire；不会在旧
实例尚未确认删除时并发创建替代实例。多个 destroy 同样共享一个 release task。

这避免了环境释放或过期边界上多个 Agent 同时成功启动实例、重复推理和重复打平台 API。

## 4. endpoint 就绪契约

平台返回 URL、host:port 或 `Running` 状态不等于题目服务可用。Core 的交付顺序是：

```text
instance.start(signal)
  → instance.waitUntilReady(environment, signal)
  → 持久化租约
  → environment_acquired
  → tool result 交付 Agent
```

`waitUntilReady` 是协议感知的适配器能力：

- HTTP(S) 可以请求真实入口；5xx 继续等待，2xx–4xx 表示应用已接受协议请求；
- TCP、SSH、自定义二进制协议至少需要成功建立对应传输连接；
- WS/WSS 或带本地代理的平台应验证握手或上游隧道，而不是只检查本地监听端口；
- UDP 或特殊 challenge protocol 应由插件实现自己的最小有效握手。

`packages/platform/src/endpoint-readiness.ts` 提供 HTTP(S) 与 TCP/TLS 的通用检查，但插件可以并且
应当实现更强的 challenge-specific probe。GZCTF 会在容器入口出现后执行 endpoint 传输检查；
DASCTF Pro 在异步 build 完成并返回代理/直连 endpoint 后执行传输检查；Ret2Shell 在 pod Running、WSRX/本地 endpoint 建立后执行传输检查。

为兼容旧扩展，没有 `waitUntilReady` 时 Core 只在 `status === running` 且 endpoint 非空后交付。
该兼容路径不能证明特殊协议可用；新的远程环境插件应实现显式 readiness。

整个 start + readiness 共享 4 分钟 Core deadline 和同一 AbortSignal。就绪失败按启动失败处理，
不会把尚不可用的 endpoint 直接丢给 Agent 消耗 token。

## 5. 到期、变化与全员同步

`RemoteEnvironment` 可以携带：

- `expiresAt`：平台给出的绝对到期时间；
- `readyAt`：适配器完成协议就绪检查的时间。

协调器为已知 `expiresAt` 安排单个 unref timer。到期时原子删除活跃租约和 SQLite 记录、释放名额，
写入 `environment_expired`，并通知当前 Solver 与所有正在运行的 SubAgent。status 返回 null、stopped
或过期时间已到时走同一转换。

endpoint、status 或 expiresAt 变化时，协调器更新内存租约和持久化记录，写入
`environment_updated`，再广播：

```xml
<remote_environment_update>
  ...最新状态、到期或失效说明...
</remote_environment_update>
```

参与者必须把该消息视为权威状态：立即停止使用旧 endpoint。环境失效后 Solver 或任一 SubAgent
均可调用一次 `ctf_instance_start` 重开；single-flight 保证并发调用只产生一个平台请求。

Solver compaction 后，Project 会重新注入当前 `<remote_environment_state>`，避免压缩上下文后恢复
旧 endpoint。完成、释放和到期更新同样广播给运行中的参与者。

## 6. 超时、重试和补偿清理

| 操作                         | 默认墙钟上限 | 行为                                                |
| ---------------------------- | -----------: | --------------------------------------------------- |
| start + readiness            |       4 分钟 | 超时返回可重试 `RemoteEnvironmentStartTimeoutError` |
| status / destroy / 遗留回收  |        30 秒 | 有界失败，不阻塞协调锁                              |
| 通用 endpoint probe 单次尝试 |         5 秒 | 在总 readiness deadline 内重试                      |

平台明确 `retryable: true` 的启动失败会在同一次工具调用内按
`2s → 5s → 15s → 30s` 有限退避；有效 `retryAfterMs` 优先。每次重试前先幂等 destroy，避免
非幂等 POST 重复创建实例。Agent 不会因为这些内部重试产生额外 LLM turn。

启动请求存在不确定结果：客户端超时时 POST 可能已经到达平台。Core 因此执行两次有界补偿机会：

1. 启动失败、取消或超时后立即调用幂等 destroy；
2. 不遵守 abort 的迟到 start 如果之后成功，再调用一次 destroy。

平台 I/O 不在协调锁中等待。destroy 失败时租约继续保留并占名额，Dashboard 显示 releasing/错误
事件；只有确认销毁后才删除租约和发放下一个槽。

## 7. 持久化与重启

`remote_environment_leases` 保存系统明确持有的 Run、题目、环境 ID、优先级和取得时间。
Project 打开时只回收这些遗留租约，不扫描或销毁用户在平台上手工创建的其他实例。

启动时遗留回收同样有 30 秒边界。失败记录作为诊断保留，不能为了“恢复可用名额”假装平台环境
已经消失。

## 8. Dashboard 与人工操作

Project Dashboard 的“远程环境”栏目显示：

- `occupied / maximum`；
- 占用或等待的题目、Run/环境 ID；
- waiting、starting、ready、releasing；
- 已开启/等待时长、平台到期时间；
- 平台列表中存在但不属于当前协调器租约的外部实例；
- 人工释放操作。

栏目读取 `RemoteEnvironmentCoordinator.snapshot()`，并与同一次平台环境列表合并，不额外增加轮询
请求。平台列表中仍存活的外部实例也计入 Project 远程上限；在人工释放或平台列表确认消失前，
Scheduler 不会把它当作空闲名额。人工释放仍通过 Project 级 API 和协调器 single-flight 路径执行。

全局 Solver 日志聚合以下高信号事件：Run、工具、SubAgent、Flag、环境等待/启动/更新/过期/释放。
高频 thinking 和 usage 被过滤，日志只展示摘要，不暴露完整推理或上游响应正文。

## 9. 事件

| 事件                          | 说明                                           |
| ----------------------------- | ---------------------------------------------- |
| `environment_waiting`         | 等待配额，含优先级和队列位置                   |
| `environment_starting`        | 预留槽并开始平台 start/readiness               |
| `environment_retry_scheduled` | 同工具调用内的有限重试                         |
| `environment_acquired`        | readiness 通过并持久化，含 endpoint 到期元数据 |
| `environment_delivered`       | endpoint 已返回 Agent                          |
| `environment_updated`         | endpoint、status 或 expiresAt 变化             |
| `environment_expired`         | 平台停止或到期，旧 endpoint 失效               |
| `environment_start_failed`    | 取消、超时、readiness 或平台失败               |
| `environment_cleanup_failed`  | 启动失败后的补偿销毁失败                       |
| `environment_released`        | destroy 成功并删除租约                         |
| `environment_release_failed`  | destroy 失败，租约和名额保留                   |
| `environment_status_failed`   | 到期检查或状态刷新失败                         |

## 10. 平台适配器要求

- start、readiness、轮询和请求必须向下传递 AbortSignal；
- 非幂等 start 失败后先读状态，不得无条件重复 POST；
- `waitUntilReady` 必须验证实际协议，而不只是平台状态码；
- status 和 destroy 必须有自身网络 deadline，Core timeout 只是最后防线；
- destroy/close 必须幂等，并清理 timer、socket、WebSocket 和本地代理；
- 发现到期或不存在时返回 null/stopped，不得继续返回缓存 endpoint；
- 错误不得包含 Secret 或完整上游响应正文；429、网络和服务端错误应提供稳定 retryable 语义。

相关实现：

- `packages/core/src/project/remote-environment-coordinator.ts`
- `packages/core/src/project/project.ts`
- `packages/platform/src/endpoint-readiness.ts`
- `packages/platform/src/dasctf.ts`
- `packages/platform/src/gzctf.ts`
- `packages/platform/src/ret2shell.ts`
- `packages/agents/src/solver/sandbox/tools.ts`
- `packages/core/test/project/remote-environment-coordinator.test.ts`
