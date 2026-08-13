# 容器配发与远程环境生命周期

本文描述比赛平台远程环境的当前实现。远程环境由 CTF 平台创建，与 Solver 使用的本地 Docker sandbox 是两套独立资源：sandbox 执行分析命令，远程环境提供题目服务 endpoint。

## 1. 责任边界

```text
Solver tool
  ctf_instance_start/status/destroy
        │
        ▼
RemoteEnvironmentCoordinator（Project 级）
  配额、优先级、硬超时、取消、租约、迟到清理
        │
        ▼
ChallengeCapability.instance（平台适配器）
  平台 API、状态轮询、endpoint 映射、幂等销毁
        │
        ▼
CTF 平台容器 / 本地流量代理
```

Core 不把完整 `PlatformProject` 交给 Solver。Solver 只能操作当前题目绑定的 `ChallengeCapability.instance`，协调器再用 Run ID 绑定配额和租约。

## 2. 配发状态

一次申请依次经过以下逻辑状态：

| 状态               | 是否占配额           | 含义                                                |
| ------------------ | -------------------- | --------------------------------------------------- |
| `pending`          | 否                   | Project 配额已满，按优先级和 FIFO 等待              |
| `starting`         | 是                   | 已预留槽位，正在执行平台 `start(signal)`            |
| `waiting_delivery` | 是                   | 平台已返回环境，Solver 正在重新取得执行许可         |
| `active`           | 是                   | endpoint 已交付 Solver，租约进入实际可用时间        |
| `releasing`        | 是，直到有界销毁结束 | 正在调用平台 `destroy()`                            |
| 遗留租约           | 否                   | 销毁失败，保留 SQLite 记录供下次 Project 打开时回收 |

锁只保护这些状态转换。平台 `start`、`status`、`destroy`、遗留回收等远程 I/O 均不在 Project 协调锁内等待，因此一个故障平台调用不会锁住其他申请的取消或租约释放。

## 3. 配额与优先级

`maxRemoteEnvironments` 是 Project 级上限，默认由 runtime 配置提供。

- 没有附件的环境题为 `required`：没有实例通常无法本地推进。
- 有附件的环境题为 `verification`：可以先完成本地分析，再申请实例验证。
- `required` 请求可撤销最早取得的 `verification` 租约，但不能撤销尚未把 endpoint
  交付 Solver 的租约。交付后的 verification 租约默认至少获得 30 秒可用时间片，避免环境
  创建完成后在 Agent 第一次使用前就被撤销。
- 同优先级请求按申请时间 FIFO。
- 降低配额时优先撤销最早的 `verification` 租约；不会强制撤销 `required` 租约。

撤销后，Core 向原 Solver 注入 `<environment_revoked>` 消息，旧 endpoint 不再可信。

## 4. 超时与取消

Core 提供不依赖插件实现质量的边界：

| 操作                                    | 默认墙钟上限 | 结果                                                  |
| --------------------------------------- | -----------: | ----------------------------------------------------- |
| `start`                                 |       4 分钟 | 抛出可重试的 `RemoteEnvironmentStartTimeoutError`     |
| `status`、`destroy`、遗留回收和补偿清理 |        30 秒 | 抛出可重试的 `RemoteEnvironmentOperationTimeoutError` |

`ctf_instance_start` 的 tool signal、Project 关闭信号和 Core 启动 deadline 会合并。即使插件忽略 signal，Core 也会让 tool call 在 deadline 内结束、释放内存配额并继续 pump 后续请求。

调度器把 `pending` 和 `starting` 都视为外部环境等待，不扣减 Solver 的实际解题时限；远程环境自身仍受上表中的独立 deadline 约束，所以不会形成无限暂停。

长驻 `ContestScheduler` 还会在 `ctf_instance_start` 开始时释放当前 Run 的 Solver 执行许可，
让本地分析题使用空闲算力。环境启动成功或失败后，Run 进入
`waiting_execution_slot`，并优先于新 Run 重新取得许可；只有取得许可后，工具结果才返回
Agent。环境在等待恢复期间被抢占时，Core 会拒绝返回旧 endpoint。完整调度不变量见
[调度原则与执行许可](scheduling.md)。

平台明确标记为 `retryable: true` 的启动失败不会立即返回 Agent。协调器在同一次工具调用
和同一个 4 分钟 deadline 内按 `2s → 5s → 15s → 30s` 有限退避；错误携带有效
`retryAfterMs` 时优先采用平台建议。每次重试前先执行幂等补偿清理，清理失败则停止重试，
避免非幂等 POST 产生重复实例。取消、Project 关闭和 required 对 starting verification 的
优先级抢占都会中断退避，不会继续发起下一次平台调用。

Ret2Shell 的实例删除是异步过程。适配器在 DELETE 被接受后继续轮询 Project 实例列表，
只有目标实例消失才让 Core 删除租约并分配下一个名额；销毁确认自身受 25 秒 deadline
约束。平台返回 `rebuilding cargo crates` 时只标记为可重试，不伪造固定短间隔，交由 Core
使用上述有限指数退避。

平台适配器可以使用更短的业务 deadline。例如 Ret2Shell 的实例就绪 deadline 是 3 分钟，单次 HTTP 最多 30 秒，且 HTTP deadline 覆盖响应头和完整响应体读取。

平台插件 Validation Gate 使用同样的防御边界：普通契约调用默认最多 30 秒，环境启动最多 4 分钟；启动超时时会中止传给候选插件的 signal，继续执行有界 `destroy()` 和 `close()`。候选插件忽略取消时，Gate 报告会失败但验证进程不会无限等待。该行为属于 validation harness version 2。

## 5. 取消后的补偿清理

启动 POST 存在不确定结果：客户端超时或取消时，请求可能已经到达平台并创建实例。Core 因此采用两次有界、幂等的补偿机会：

1. 启动失败、取消或超时后立即调用一次 `destroy()`。
2. 不遵守 abort 的 `start()` 如果迟到成功，再调用一次 `destroy()`。

这保证控制面不会等待失控 promise，也尽量避免孤儿实例。插件的 `destroy()` 必须幂等：实例不存在、已经停止或重复销毁都应成功返回。
销毁失败时，Core 保留内存和 SQLite 租约并继续占用 Project 环境配额；只有后续幂等重试
确认销毁成功，才删除租约并启动下一项环境申请。

如果销毁失败，内存槽位会被释放，`remote_environment_leases` 记录继续保留。下次 Project 打开时，`reconcile()` 只回收这些由本系统持有的遗留租约，不扫描或销毁用户在平台上的其他实例。

## 6. 平台适配器契约

Core 已负责配额、公平性、硬 deadline、tool 取消竞速和持久化，但插件仍需满足以下最小要求：

- `start(signal)` 将 signal 传给 fetch、轮询等待和其他可取消操作，并在取消后抛出 `AbortError`；不要吞掉取消继续轮询。
- 平台请求必须有自己的有限超时，而且超时覆盖响应体消费，不只覆盖收到响应头之前。
- 启动使用墙钟 deadline；不要用“轮询次数 × sleep”假设总耗时，因为每次请求本身也会耗时。
- 启动 POST 应视为非幂等且结果可能不确定。失败后先读取状态，避免重复创建；取消时配合幂等销毁。
- `start()` 只有在返回值足以让 Agent 继续工作时才成功；长期 `starting` 或缺少必要 endpoint 应在有限时间后抛出有界错误。
- `status()` 和 `destroy()` 自身应有有限网络超时；Core 的 timeout 是最后防线，无法终止插件内部泄漏的 socket、timer 或 promise。
- `destroy()` 和 `close()` 必须幂等，并清理轮询 timer、socket、WebSocket、本地代理和认证状态。
- 错误不得包含凭据或完整上游响应正文；网络、限流和服务端错误应暴露 `retryable: true` 或稳定的结构化错误码。

内置 Ret2Shell 会把 WSRX WebSocket 流量映射为控制面本地 TCP endpoint，因此其 `solverSandboxNetwork` 为 `control_plane`。Project 会让 Solver sandbox 与控制面共享可访问该回环代理的网络命名空间；配置为 `networkMode: none` 时拒绝启动。

## 7. 事件与排障

协调器向 RunStore 写入以下生命周期事件：

| 事件                              | 说明                                     |
| --------------------------------- | ---------------------------------------- |
| `environment_waiting`             | 等待配额，包含优先级和队列位置           |
| `environment_starting`            | 已取得槽位并开始平台调用                 |
| `environment_acquired`            | 租约持久化成功，包含环境 ID 和启动耗时   |
| `environment_delivered`           | endpoint 已返回 Solver，包含交付等待时间 |
| `environment_preemption_deferred` | 抢占因尚未交付或最小时间片而推迟         |
| `environment_retry_scheduled`     | 可重试启动错误的次数、延迟和脱敏原因     |
| `environment_start_failed`        | 启动取消、超时或平台失败                 |
| `environment_cleanup_failed`      | 启动失败后的补偿销毁失败                 |
| `environment_released`            | 正常销毁并删除租约                       |
| `environment_release_failed`      | 销毁失败，持久化租约保留                 |
| `environment_revoked`             | 因优先级或配额降低而撤销                 |

排查长期 tool call 时，依次确认：

1. 是否出现 `environment_waiting`；若有，检查当前活跃租约及其 release 事件。
2. 是否出现 `environment_starting`；若有但没有终态，检查 Core 启动 deadline 是否生效。
3. 平台请求是否把 AbortSignal 传到底层 fetch，响应体是否也受 timeout 约束。
4. 平台实例是否一直处于 `Pending/starting`，适配器是否在业务 deadline 后错误返回成功。
5. 是否出现 cleanup/release failure；SQLite 遗留租约会在下次打开 Project 时重试回收。

相关实现：

- `packages/core/src/project/remote-environment-coordinator.ts`
- `packages/core/src/project/project.ts`
- `packages/agents/src/solver/sandbox/tools.ts`
- `packages/platform/src/index.ts`
- `packages/platform/src/gzctf.ts`
- `packages/platform/src/ret2shell.ts`
