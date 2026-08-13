# 调度原则与执行许可

本文描述 WebUI 长驻调度器 `ContestScheduler` 的当前行为。一次性批量执行器
`ContestRunner` 不维护持久队列，也不使用本文的远程环境 parking 流水线。

## 1. 三类独立资源

调度器不再把一个活跃 Run 等同于一个正在使用的 Solver 并发槽。运行期间存在三类
互相独立的资源：

| 资源            | 上限                      | 含义                                       |
| --------------- | ------------------------- | ------------------------------------------ |
| Run 生命周期    | 环境型 Run 受驻留上限保护 | 题目仍在运行、等待或收尾                   |
| Solver 执行许可 | `maxConcurrent`           | Agent 正在准备、调用模型或执行工具         |
| 远程环境租约    | `maxRemoteEnvironments`   | 平台实例处于 starting、active 或 releasing |

因此 `snapshot.active.length` 可以大于 `maxConcurrent`。判断实际算力占用时应读取
`phase`，不能再用 active 数量代替执行并发。

## 2. Run 阶段

```text
preparing ──→ running ──→ terminal
                │
                │ ctf_instance_start
                ▼
       waiting_environment
                │ 环境成功或失败
                ▼
      waiting_execution_slot
                │ 优先重新取得 Solver 许可
                └──────────────→ running
```

| phase                    | 占 Solver 许可   | 含义                                        |
| ------------------------ | ---------------- | ------------------------------------------- |
| `preparing`              | 是               | 创建 Sandbox、绑定题目并组装 Agent          |
| `running`                | 是               | Agent/model/tool 正在执行                   |
| `waiting_environment`    | 否               | `ctf_instance_start` 正在等待配额或平台启动 |
| `waiting_execution_slot` | 否               | 环境操作已结束，等待重新进入 Agent 执行     |
| `cancelling`             | 取决于取消前状态 | 正在中止 Agent 并回收资源                   |

只有 `ctf_instance_start` 会临时释放执行许可。短时且有 30 秒 Core deadline 的
`status`、`destroy` 不释放许可，避免为所有工具引入不必要的切换复杂度。

## 3. 执行许可公平性

出现空闲 Solver 许可时，调度器严格按以下顺序分配：

1. 最早进入 `waiting_execution_slot` 的已有 Run；
2. 持久队列中下一个符合自动模式和驻留限制的题目。

已有 Run 优先，避免已经创建的远程实例空转，也避免不断启动新题导致恢复中的 Agent
饥饿。降低 `maxConcurrent` 不会抢占正在执行的 Run；在实际占用降到新上限以下之前，
不会发放新的许可。

环境成功、失败或超时都必须重新取得执行许可后，工具结果才会返回 Agent。平台明确标记的
可重试启动错误由远程环境协调器在原工具调用内有限退避，不会额外创建 LLM 回合。取消
`waiting_environment` 会中止 pending/starting 请求；取消 `waiting_execution_slot` 会从
许可等待队列移除 Run。两条路径最终都会走 Solver 关闭和远程租约清理。

## 4. 环境型 Run 驻留上限

释放 Solver 许可后，调度器可以继续创建新 Run。为避免远程平台长期拥塞时一次性创建
大量 Sandbox，环境型驻留 Run 默认最多为：

```text
maxEnvironmentResidentRuns = 2 × maxConcurrent
```

达到上限后，新的 `needsEnv: true` 题会暂时留在队列，但明确不需要环境的题仍可越过它
使用空闲算力。平台列表无法提前确定 `needsEnv` 时，该 Run 从领取时就保守占用一个驻留
名额；首次调用 `ctf_instance_start` 后再被明确标记为环境型。这样未知类型不会绕过驻留
上限而批量创建 Sandbox。

该上限只约束本地 Run/Sandbox 驻留数量，不改变远程协调器的 `required`、`verification`
优先级和抢占规则。

## 5. 队列与题目选择

- 自动模式加入未解、未排除、未 blocked 且未处于 queued/active 的题目。
- 同一题在 queued/active 阶段互斥。
- 人工 override 优先于普通队列；normal lane 优先于 blocked lane。
- normal 题全部处理完后，blocked 题才按 blocked 时间进入 revival。
- 队列位置和版本持久化在 RunStore；重排使用乐观锁拒绝陈旧版本。
- `pauseAuto()` 清除等待队列但不取消活跃 Run；`suspend()` 冻结领取并保留队列。

## 6. 重试、阻塞与服务暂停

- 普通失败和重新创建 Run 受历史 `maxAttempts` 约束。
- 网络、限流和 5xx 在同一 Run 内按 `10s → 60s → 300s` 有限退避。
- 鉴权、配置、余额或免费额度耗尽会 suspend 调度器，不继续创建 LLM 请求。
- 修复模型配置后可调用 `POST /api/scheduler/resume`；接口只在 Solver 模型有效时恢复，
  随后立即 reconcile。
- 模型配置、项目模型绑定或凭据恢复成功也会自动 resume 并 reconcile。
- 平台同步失败由 ControlPlane 进入 degraded 并 suspend；平台恢复后继续原有队列意图。

## 7. 超时与重启

`waiting_environment` 和 `waiting_execution_slot` 都不扣减题目的 Solver 工作时限；平台
环境启动仍受独立的 4 分钟硬 deadline。远程环境操作限制见
[容器配发与远程环境生命周期](remote-environments.md)。

执行许可和等待队列是进程内状态，不跨重启持久化。Project 打开时会将遗留的非终态
Run 标为 interrupted，并按持久化 Run、session、环境租约和调度队列执行现有恢复流程，
不会假设上一个进程仍持有任何许可。

## 8. 关键不变量

- 持有 Solver 执行许可的 Run 数不得超过当前 `maxConcurrent`，并发下调期间只允许暂时
  保留既有占用。
- 每个 Run 同时最多存在一个 execution waiter 和一个远程环境申请/租约。
- execution waiter 必须优先于新 Run 获得空闲许可。
- 环境 endpoint 在等待恢复期间被撤销后不得返回 Agent；工具应报告可重试的
  `RemoteEnvironmentRevokedError`。
- 未交付 Solver 的 verification 环境不得因 required 请求被抢占；交付后必须先获得最小
  可用时间片。配额下调仍是硬约束，不受该时间片保护。
- Run 取消、结束和 Scheduler shutdown 都必须清除 waiter，不得泄漏执行许可。

相关实现和行为测试：

- `packages/core/src/orchestration/contest-scheduler.ts`
- `packages/core/src/project/project.ts`
- `packages/core/src/project/remote-environment-coordinator.ts`
- `packages/core/test/runner/contest-scheduler.test.ts`
- `packages/core/test/project/remote-environment-coordinator.test.ts`
