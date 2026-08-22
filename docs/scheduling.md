# 调度与硬资源上限

本文描述 WebUI 长驻调度器 `ContestScheduler` 的实际资源模型。核心目标不是让尽可能多的
Run 处于“活跃”状态，而是在固定本地容器和远程环境预算内，持续把算力交给最可能推进的题目。

一次性批量执行器 `ContestRunner` 不维护本文的持久队列，但同样受自身 worker pool 上限约束。

## 1. 调度意图与双队列

WebUI 的手动调度不是“启动后自动挑选所有未解题”，而是一个显式的两阶段计划：

```text
赛题池 ──批量加入──> 空闲队列 ──启动调度──> 执行队列 ──获得名额──> 活跃 Solver
```

- **空闲队列（`idle`）**：只在调度停止时编排。用户可从筛选后的题目表格批量加入、逐题移除并拖拽排序；这些操作不会创建 Run、Sandbox 或远程实例。
- **执行队列（`execution`）**：保存已提交但尚未获得 Solver 名额的题目。它与空闲队列独立排序，Blocked revival 使用同一执行阶段中的 blocked lane。
- **活跃 Solver**：已获得 `maxConcurrent` 名额并开始持有 Sandbox 的 Run，不再属于任一等待队列。

`POST /scheduler/start` 以 `manual` 模式启动：RunStore 在同一事务内按既有顺序将全部空闲项迁入执行队列，再由 Scheduler pump。没有被用户加入空闲队列的题目不会被隐式调度。`POST /scheduler/auto/start` 是独立的 `automatic` 模式，供 `--auto-start` 或明确启用“自动补题”的调用方持续发现可调度题。

调度模式持久化为 `stopped | manual | automatic`。暂停会把模式改为 `stopped`，停止领取新任务，但**保留并冻结空闲队列和执行队列**，也不取消已经活跃的 Solver；恢复手动调度会继续原执行队列，并提交暂停期间保留的空闲计划。停止活跃 Solver 是另一个需要确认的操作。

两阶段分别维护 `idleVersion` 与 `executionVersion`。整队排序必须携带客户端读取到的版本；陈旧写入返回 `409 queue_version_conflict`，WebUI 丢弃乐观顺序并重新读取服务端快照。`scheduler_queue.stage`、`scheduler_control` 和两个版本均保存在 SQLite；旧数据库中没有 `stage` 的队列项迁移后归入 `execution`，从而不丢失升级前的等待任务。

## 2. 两个硬上限

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

## 3. Run 生命周期

```text
idle（手动计划）──启动迁移──┐
                           ├──> queued / execution
自动发现───────────────────┘          │ 通过准入检查且有容器槽
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

进程异常退出时，Project 会把遗留的非终态 Run 标记为 `interrupted`。Scheduler 恢复执行队列时，若该 Run 来自调度器且题目尚未 Blocked，会用原 Run 的 attempt 和 JSONL session 调用 `resumeSolver()`，发送默认 continuation prompt，而不是创建新的 attempt。人工再次派发 `cancelled`、普通失败或超时的题目时也遵循同一规则；只有题目已进入 Blocked 时才不恢复原 Run。

普通 turn 结束、远程环境排队或 transient retry 都不会为了“提高表面并发”创建额外 Sandbox。

## 4. 远程环境感知准入

调度器在创建 Sandbox **之前**判断题目是否可以推进。队列扫描允许越过当前不可准入的远程题，
但不会改变持久化顺序。

### 4.1 远程槽已满时仍可启动

以下题目只要有空闲 Sandbox 槽就可以启动：

1. 平台明确 `needsEnv: false` 的本地题；
2. `hasAttachments: true` 的题——先下载、逆向、审计或本地复现附件，再在确有验证需求时申请实例。

Solver 系统提示明确要求附件题先形成具体结果、exploit 或待验证假设，再调用一次
`ctf_instance_start`；等待期间禁止轮询、重复调用或让多个 SubAgent 重复申请。

### 4.2 远程槽已满时不得启动

平台明确需要环境且无附件的题会留在队列，不提前创建一个只能等待的容器。

平台摘要无法判断 `needsEnv` 且也没有附件信号时，调度器先采取保守策略：把它当作一个“预期
远程槽”请求。远程槽已满且仍有本地容器可用时，Scheduler 每次只对一个候选读取题目级调度提示
（结果在 Project 内缓存，失败至少冷却 30 秒）；确认存在附件后再准入。这样 GZCTF 等摘要不携带
附件元数据的平台仍能利用本地分析，同时未知类型不能绕过上限批量创建 Sandbox 或请求平台。

### 4.3 同一轮 pump 的预留

只检查协调器当前 `occupied` 不够：刚启动的 Solver 还未来得及调用 `ctf_instance_start`，同一轮
pump 可能连续创建多个远程题。调度器因此同时计算：

```text
max(remoteCoordinator.occupied, admittedRemoteOnlyRuns) < maxRemoteEnvironments
```

无附件远程题和保守未知题在 Sandbox 创建前就占一个“预期远程槽”。该预留不创建平台实例，
只防止启动风暴。附件题不占预期远程槽，因为它可以先本地推进。

## 5. 最大化解题速度的选择顺序

每次出现空闲 Sandbox 槽时，调度器按以下原则扫描队列：

1. 保留 manual override、normal lane、blocked revival 和用户拖拽顺序；
2. 跳过当前远程容量不允许启动的无附件环境题；
3. 选择最早可本地推进的题；
4. 远程环境释放后由容量事件立即再次 pump，不等待下一次平台轮询。

结果是：远程环境持有者可以连续推理和利用实例；空闲本地容器同时处理纯本地题或附件题；不会
为排队中的远程题制造额外容器和 LLM 请求。

## 6. 等待、超时和重试

`ctf_instance_start` 是一个顺序工具调用。远程名额不足时，调用停在协调器队列中，当前 Agent
不会产生下一次 LLM 请求。Run 仍占 Sandbox 槽，因此系统总资源保持有界。

- 环境等待不扣减 Solver 工作时限；
- 平台启动仍受独立的 4 分钟墙钟上限；
- status、destroy 和补偿清理默认受 30 秒上限；
- 明确 `retryable: true` 的启动错误在同一次工具调用内有限退避，不创建新 Run 或新 LLM turn；
- 取消等待中的 Run 会中止 pending/starting 请求，并走统一 Solver 清理；
- 网络、429 和 5xx 的普通 Solver 失败仍按 `10s → 60s → 300s` 做同 Run 有限退避；退避耗尽后，所有非 `blocked` 的终态重试都会复用原 attempt/session，并发送默认 continuation prompt。

## 7. 队列、Blocked 与恢复

- 同一题在 idle/execution/active 三个阶段互斥；重复批量加入已在空闲队列的题是幂等操作，执行中或已在执行队列则明确拒绝；
- 平台已解、RunStore 已解、人工 `excluded/solved` 的题不自动入队；
- normal 题处理完后才进入 blocked revival；
- 空闲与执行队列的位置和版本分别持久化，拖拽通过队列级或条目级 `expectedVersion` 拒绝陈旧写入；
- `pauseAuto()` 保留两条等待队列但不取消活跃 Run；WebUI 暂停后会提供“停止全部 Solver”，并等待各 Run 完成正常资源回收；
- `suspend()` 在平台或模型配置故障时冻结领取，并保留队列和持久化模式；
- 创建 Scheduler 后先执行 `restore()`：从 RunStore 恢复两条队列与模式，再 reconcile 平台事实；
- 重启后遗留非终态 Run 标记为 interrupted，旧进程的容器和内存许可不会被假定仍存在；未被 Blocked 的调度 Run 重新进入 execution 时复用原 attempt/session，并发送默认 continuation prompt。历史 `cancelled`、`failed`、`timed_out` 和 `closed` Run 再次派发时同样复用原 attempt；`blocked` Run 不自动恢复。

## 8. Dashboard 可观察性

Project Dashboard 直接展示三类调度事实：

- **调度工作台**：并排显示空闲与执行队列、持久化模式、活跃数量和 Blocked lane；停止时提供题目复选、批量加入/移除与键盘可操作的拖拽手柄，运行时冻结编排控件；
- **远程环境**：占用/上限、题目、Run、waiting/starting/ready/releasing、已持续时间、到期时间，并允许人工释放；
- **所有 Solver 日志**：跨题聚合最近 Run、工具、SubAgent、Flag 和环境事件。高频 thinking 与 usage 不进入该列表，避免日志本身造成存储和渲染压力。

Dashboard 数据来自 RunStore 与 `RemoteEnvironmentCoordinator.snapshot()`；浏览器不是资源状态的
权威来源。SSE 断线后重新读取快照即可恢复。

## 9. 必须保持的不变量

- 空闲队列只能在 `stopped` 模式编排；启动迁移必须保持顺序且不能隐式加入其他题。
- 暂停不得删除空闲/执行队列，也不得自动取消活跃 Solver；暂停后不得领取新的执行项。
- 活跃 Solver/Sandbox 数不得超过 `maxConcurrent`；下调期间只允许保留调整前已存在的 Run。
- 等待远程环境的 Run 仍计入 Sandbox 上限。
- 无附件远程题在没有预期远程槽时不得创建 Sandbox。
- 本地题和附件题可以越过暂不可准入的远程题。
- 一个 Run 同时最多有一个远程申请或租约；并发 start 调用必须 single-flight。
- 已交付远程租约不因后续高优先级请求被抢占；持有者直到解出、Blocked、取消或主动释放。
- Scheduler shutdown、Run 取消和终态收尾必须逐个调用 Solver 正常关闭，最终关闭 Sandbox 并释放远程租约；单个关闭失败不得跳过其余 Solver。
- 进程无法执行关闭钩子时，下次 Project 打开必须按 interrupted Run 标签回收遗留 Sandbox，并 reconcile 持久化远程租约。

相关实现和行为测试：

- `packages/core/src/orchestration/contest-scheduler.ts`
- `packages/core/src/project/remote-environment-coordinator.ts`
- `packages/core/src/project/project.ts`
- `packages/core/test/runner/contest-scheduler.test.ts`
- `packages/core/test/project/remote-environment-coordinator.test.ts`
