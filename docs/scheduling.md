# 调度与硬资源上限

本文描述 WebUI 长驻调度器 `ContestScheduler` 的实际资源模型。核心目标不是让尽可能多的
Run 处于“活跃”状态，而是在固定本地容器和远程环境预算内，持续把算力交给最可能推进的题目。

一次性批量执行器 `ContestRunner` 不维护本文的持久队列，但同样受自身 worker pool 上限约束。

## 1. 两个硬上限

| 配置                    | 限制对象                         | 语义                                          |
| ----------------------- | -------------------------------- | --------------------------------------------- |
| `maxConcurrent`         | 本地 Solver Run / Docker Sandbox | Project 内同时存在的活跃 Solver 容器硬上限    |
| `maxRemoteEnvironments` | CTF 平台远程实例                 | `starting + ready + releasing` 的远程环境上限 |

`maxConcurrent` 不再是“LLM 请求执行许可”。一个 Run 只要仍持有 Sandbox，无论 Agent 正在调用
模型、执行命令还是等待 `ctf_instance_start`，都计入该上限：

```text
scheduler.active.length <= maxConcurrent
```

同一 Provider 的 LLM 请求仍受独立的请求门、2 秒错峰和 429/5xx 冷却控制；该背压不能扩大
Solver 容器上限，也不能被解释为调度并发。

降低 `maxConcurrent` 时不会杀死正在解题的 Solver。现有 Run 继续持有容器，直到活跃数自然降到
新上限以下；期间不再启动新题。

## 2. Run 生命周期

```text
queued
  │ 通过准入检查且有容器槽
  ▼
preparing ──→ running ──→ blocking / writing_writeup ──→ terminal
                │
                │ ctf_instance_start 等待配额或平台启动
                ▼
       waiting_environment
                │ 工具成功、失败或取消
                └──────────────────────────────→ running
```

| phase                 | 是否占 Sandbox 槽 | 含义                                         |
| --------------------- | ----------------- | -------------------------------------------- |
| `preparing`           | 是                | 绑定题目、创建 Sandbox、下载附件并组装 Agent |
| `running`             | 是                | Solver 正在推理或执行工具                    |
| `waiting_environment` | 是                | 当前工具调用等待远程名额、启动和协议就绪     |
| `cancelling`          | 是，直到清理结束  | 中止 Agent、SubAgent、远程租约和 Sandbox     |

不存在 `waiting_execution_slot`，也不存在环境等待时临时释放并发、随后重新抢执行许可的流程。
这正是容器数量不再从配置值 2 膨胀到 6、7 个的关键。

Solver 在同一个 Run 和 Sandbox 中持续工作，直到以下任一结果：

- Flag 被平台接受并完成 Writeup；
- Supervisor 判定为 Blocked 并完成进度收尾；
- 人工取消、进程关闭或不可恢复失败。

普通 turn 结束、远程环境排队或 transient retry 都不会为了“提高表面并发”创建额外 Sandbox。

## 3. 远程环境感知准入

调度器在创建 Sandbox **之前**判断题目是否可以推进。队列扫描允许越过当前不可准入的远程题，
但不会改变持久化顺序。

### 3.1 远程槽已满时仍可启动

以下题目只要有空闲 Sandbox 槽就可以启动：

1. 平台明确 `needsEnv: false` 的本地题；
2. `hasAttachments: true` 的题——先下载、逆向、审计或本地复现附件，再在确有验证需求时申请实例。

Solver 系统提示明确要求附件题先形成具体结果、exploit 或待验证假设，再调用一次
`ctf_instance_start`；等待期间禁止轮询、重复调用或让多个 SubAgent 重复申请。

### 3.2 远程槽已满时不得启动

平台明确需要环境且无附件的题会留在队列，不提前创建一个只能等待的容器。

平台摘要无法判断 `needsEnv` 且也没有附件信号时，调度器先采取保守策略：把它当作一个“预期
远程槽”请求。远程槽已满且仍有本地容器可用时，Scheduler 每次只对一个候选读取题目级调度提示
（结果在 Project 内缓存，失败至少冷却 30 秒）；确认存在附件后再准入。这样 GZCTF 等摘要不携带
附件元数据的平台仍能利用本地分析，同时未知类型不能绕过上限批量创建 Sandbox 或请求平台。

### 3.3 同一轮 pump 的预留

只检查协调器当前 `occupied` 不够：刚启动的 Solver 还未来得及调用 `ctf_instance_start`，同一轮
pump 可能连续创建多个远程题。调度器因此同时计算：

```text
max(remoteCoordinator.occupied, admittedRemoteOnlyRuns) < maxRemoteEnvironments
```

无附件远程题和保守未知题在 Sandbox 创建前就占一个“预期远程槽”。该预留不创建平台实例，
只防止启动风暴。附件题不占预期远程槽，因为它可以先本地推进。

## 4. 最大化解题速度的选择顺序

每次出现空闲 Sandbox 槽时，调度器按以下原则扫描队列：

1. 保留 manual override、normal lane、blocked revival 和用户拖拽顺序；
2. 跳过当前远程容量不允许启动的无附件环境题；
3. 选择最早可本地推进的题；
4. 远程环境释放后由容量事件立即再次 pump，不等待下一次平台轮询。

结果是：远程环境持有者可以连续推理和利用实例；空闲本地容器同时处理纯本地题或附件题；不会
为排队中的远程题制造额外容器和 LLM 请求。

## 5. 等待、超时和重试

`ctf_instance_start` 是一个顺序工具调用。远程名额不足时，调用停在协调器队列中，当前 Agent
不会产生下一次 LLM 请求。Run 仍占 Sandbox 槽，因此系统总资源保持有界。

- 环境等待不扣减 Solver 工作时限；
- 平台启动仍受独立的 4 分钟墙钟上限；
- status、destroy 和补偿清理默认受 30 秒上限；
- 明确 `retryable: true` 的启动错误在同一次工具调用内有限退避，不创建新 Run 或新 LLM turn；
- 取消等待中的 Run 会中止 pending/starting 请求，并走统一 Solver 清理；
- 网络、429 和 5xx 的普通 Solver 失败仍按 `10s → 60s → 300s` 做同 Run 有限退避。

## 6. 队列、Blocked 与恢复

- 同一题在 queued/active 阶段互斥；
- 平台已解、RunStore 已解、人工 `excluded/solved` 的题不自动入队；
- normal 题处理完后才进入 blocked revival；
- 队列位置和版本持久化，拖拽通过 `expectedVersion` 拒绝陈旧写入；
- `pauseAuto()` 清除自动等待意图但不取消活跃 Run；
- `suspend()` 在平台或模型配置故障时冻结领取，并保留队列；
- 重启后遗留非终态 Run 标记为 interrupted，旧进程的容器和内存许可不会被假定仍存在。

## 7. Dashboard 可观察性

Project Dashboard 直接展示两类调度事实：

- **远程环境**：占用/上限、题目、Run、waiting/starting/ready/releasing、已持续时间、到期时间，
  并允许人工释放；
- **所有 Solver 日志**：跨题聚合最近 Run、工具、SubAgent、Flag 和环境事件。高频 thinking 与 usage
  不进入该列表，避免日志本身造成存储和渲染压力。

Dashboard 数据来自 RunStore 与 `RemoteEnvironmentCoordinator.snapshot()`；浏览器不是资源状态的
权威来源。SSE 断线后重新读取快照即可恢复。

## 8. 必须保持的不变量

- 活跃 Solver/Sandbox 数不得超过 `maxConcurrent`；下调期间只允许保留调整前已存在的 Run。
- 等待远程环境的 Run 仍计入 Sandbox 上限。
- 无附件远程题在没有预期远程槽时不得创建 Sandbox。
- 本地题和附件题可以越过暂不可准入的远程题。
- 一个 Run 同时最多有一个远程申请或租约；并发 start 调用必须 single-flight。
- 已交付远程租约不因后续高优先级请求被抢占；持有者直到解出、Blocked、取消或主动释放。
- Scheduler shutdown、Run 取消和终态收尾必须最终关闭 Sandbox 并释放远程租约。

相关实现和行为测试：

- `packages/core/src/orchestration/contest-scheduler.ts`
- `packages/core/src/project/remote-environment-coordinator.ts`
- `packages/core/src/project/project.ts`
- `packages/core/test/runner/contest-scheduler.test.ts`
- `packages/core/test/project/remote-environment-coordinator.test.ts`
