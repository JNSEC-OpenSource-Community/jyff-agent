# 系统架构

CTF Agent 是一个以 WebUI 为控制面的 pnpm/TypeScript monorepo。它把比赛平台、Pi Agent、Docker 工具环境、调度器和持久化运行历史组合起来，面向整场比赛并发解题。

## 包边界

```text
packages/
├── platform/  ChallengeCapability 契约与 CTFd、GZCTF 插件
├── sandbox/   Docker 生命周期、DockerExecutionEnv、RTK 与 solver 镜像
├── prompts/   Solver、SubAgent 与项目上下文的共享提示词
├── agents/    BaseAgent、Solver/SubAgent、Pi session/skills 和容器工具
├── core/      Project、ControlPlane、调度器、RunStore、黑板与 SubAgent manager
└── webui/     进程入口、HTTP/SSE API、模型配置和 React 客户端
```

主要依赖方向是 `webui → core → agents/platform/sandbox`；`webui`、`core` 与 `agents` 共享依赖 `prompts`，而 `prompts` 只依赖 `platform` 的题目类型。`agents` 可以依赖 `platform` 与 `sandbox`，但不能依赖 `core`、Project 或 SQLite。跨包公开 API 从各包的 `src/index.ts` 导出。

## 启动与配置

`packages/webui/src/main.ts` 是生产入口。它依次打开 Secret Store、模型配置、调度配置和 ControlPlane，再启动 HTTP/SSE 服务。业务配置保存在项目根目录下的 `.ctf-agent/`：

```text
.ctf-agent/
├── secrets.json
├── auth.json
├── model-config.json
├── scheduler-config.json
├── project-config.json
├── runs.sqlite
├── runs/<run-id>/
│   ├── session.jsonl
│   └── subagents/<subagent-id>/session.jsonl
└── challenges/<safe-key>/
    └── workspace/
```

`.pi/ctf-config.json` 只作为旧配置的只读回退。平台配置只保存非敏感字段和 secret 名称，凭据由 Secret Store 单独保存。

`model-config.json` 保存 v2 模型池、默认 Solver 模型、独立 TLDR 模型和 SubAgent role 绑定，不保存密钥。自定义 Provider 的 API Key 按 Provider 隔离在 Secret Store；原生 Provider 继续使用 Pi CredentialStore。控制面为每次调度构造完整 Pi `Models` registry，Solver 选择默认模型，TLDR 选择自己的模型，SubAgent manager 在创建新 Run 时把 WebUI role 绑定覆盖到 registry 角色；未覆盖的角色仍使用 frontmatter 的 `model`。旧版单模型文件和遗留明文 Key 会自动迁移。Solver 最大并发量由独立的 `scheduler-config.json` 管理，可在 WebUI 主控制台即时调整。

## 一次 Solver Run

`Project.createSolver()` 的主要流程：

1. 将题目 ID 绑定为单题 `ChallengeCapability` 并读取元数据；
2. 读取当前题目已有的共享黑板；黑板默认保持为空；
3. 创建或复用由题目 ID 稳定哈希得到的题目级 workspace，并创建 Docker sandbox；
4. 自动下载全部附件到容器的 `/workspace/attachments/<文件名>`；同题后续 attempt 会复用内容未变化的附件，内容变化时以同目录原子替换刷新，避免覆盖仍被旧进程执行的 inode 时触发 `ETXTBSY`；
5. 把题目信息与附件路径编码为 `<challenge_context>` 初始 user 消息；
6. 创建共享同一 sandbox 的 SubAgent manager；
7. 装配 Solver 的容器工具、平台工具、黑板工具与 SubAgent 工具；
8. 用 Pi 原生 append-only JSONL session 运行并持久化消息树。

题目描述和黑板快照均按不可信数据处理，动态内容不会进入 system prompt。固定 Solver、SubAgent、continuation 和 CTF compaction 提示词使用版本化英文占位文案，并明确要求 Agent 使用英语 reasoning；题目原文、Flag、路径、命令和协议 payload 保留原文。最终 Solver 策略和角色正文仍由人类审阅替换。Solver 默认 `thinkingLevel=medium`，再使用 Pi 的 `clampThinkingLevel` 按模型能力映射。SubAgent 的 thinkingLevel 由角色 registry 自己决定。

每个 Solver Run 的 `ctf_submit_flag` 工具维护独立滑动窗口：任意连续 60 秒内最多发起 5 次平台提交，第 6 次在工具层拒绝且不会触达平台。新的 Run 会开始新的窗口。

容器文件工具不限制到 `/workspace`；`bash`、`read`、`write`、`edit` 和 `list` 可访问 sandbox 内任意绝对路径，包括 `/tmp`。这不会给予 Agent 宿主机文件访问权，宿主机只负责 Docker bind/volume 和控制面状态。

## Session 中断与阻塞

一次模型 prompt 对应一个 Solver Run 和一个 Pi session。只有成功提交 Flag 才算完成；模型正常停止、长度截断、provider/WebSocket 错误都记为一次 Session 中断。调度器关闭旧 Solver（同时停止其 SubAgent），创建全新的 Run/session，并使用固定提示词继续：

```text
The correct final flag has not been submitted. Continue solving the challenge.
```

中断计数按 challenge 持久化在 `challenge_runtime_state`。默认允许 3 次；当计数超过 `maxSessionInterruptions` 时，题目进入 `blocked`，不再自动调度，等待 WebUI 人工重启。人工强制派发会清除该题的中断计数和 blocked 状态。

Run 级人工重试与题目级重新派发是两个不同操作。重新派发创建新 Run/attempt；对 `failed`、`timed_out`、`cancelled`、`closed`、`interrupted` 或 `blocked` Run 执行重试时，Scheduler 重新创建 sandbox 并通过 `Project.resumeSolver()` 打开原 Pi JSONL，保留 Run ID、attempt、source 和 workspace。首轮默认使用 `INCOMPLETE_CONTINUATION_PROMPT`，WebUI 可覆盖为最长 32,000 字符的人工提示词；恢复后的 turn 仍经过正常的超时、compaction、blocked 和 Flag 提交监督。

`interrupted` 与 `blocked` Run 不消耗常规 `maxAttempts` 预算；超时、取消、准备失败等走各自终态和重试规则。

## SubAgent 协作

每个 Run 拥有独立 fleet，默认最多并发 4 个后台 worker。主 Solver 用 `Agent`、`get_subagent_result`、`steer_subagent`、`cancel_subagent` 和 `list_subagents` 管理 worker。worker 共享题目 sandbox，但默认 cwd 为 `/workspace/subagents/<id>`，有独立 Pi session，不能提交 Flag、管理远端实例或写黑板。

角色来自内置 registry，并可由 `.agents/agents/*.md` 和 `.pi/agents/*.md` 覆盖；后者同名优先。派发策略和 prompt 占位协议见 `packages/prompts/src/project.ts`。

## 持久化职责

- Pi JSONL：单个 Solver/SubAgent 的完整对话树、thinking、工具状态和 compaction；WebUI 只对明确选择且已经产生 assistant 消息的 attempt/SubAgent session 调用 Pi HTML 导出器，不提供题目级“最新 Run”推断，也不从 SQLite 事件重建 transcript。导出以 HTML 页面内联呈现、不强制下载。活跃 Solver Run 从内存 AgentState 读取 system prompt 与 tools metadata；关闭后从 Run 目录的 `session-export-metadata.json` 恢复同一信息；
- SQLite RunStore：Run 状态、事件时间线、SubAgent 摘要、调度状态、Session 中断计数和黑板；
- 题目级 workspace：附件、脚本、反编译结果、`writeup.md` 和其他跨复活保留的解题产物。

题目级目录使用 challenge ID 的 SHA-256 截断值作为 `safe-key`，不会把平台 ID 直接拼入宿主机路径。文件 API 可复用 `resolveWorkspaceArtifact()` 和 symlink containment 检查拒绝路径逃逸。`validateChallengeWriteup()` 已提供 UTF-8、大小和必需标题校验；accepted Flag 后的 `writing_writeup` turn 与延迟 sandbox 清理由后续 lifecycle supervisor 接管，在该接入完成前不得把 validator 的存在误认为交付生命周期已经切换。

不要把完整 transcript 复制到 SQLite，也不要从 `agents` 包反向读取 RunStore。涉及多个控制面事实的更新应继续使用 RunStore 事务，以免 WebUI、调度器和恢复逻辑看到中间状态。

RunStore 已具备 block v2 的持久化基础：`challenge_runtime_state` 保存 `block_score`、基础阈值、复活次数、blocked 来源和 lifecycle generation，`challenge_block_events` 以唯一 `event_key` 幂等记录每次计分及 compact 是否执行。有效阈值为 `base_block_threshold + revival_count * 4`，只有 `score > threshold` 才设置 blocked。数据库使用 partial unique index 保证同一道题最多存在一个 `preparing`、`running`、`blocking` 或 `writing_writeup` Run；打开遗留库时会保留最新 active Run，并把重复项审计为 interrupted。

在 Solver supervisor 接管 turn 生命周期前，现有 Session 中断路径仍会同步维护旧 `session_interruptions` 与 `block_score` 兼容值；新 supervisor 应只写 block event ledger，旧字段只保留审计和迁移用途。

ControlPlane 连接平台时先执行公告 baseline，再创建 Scheduler；baseline 失败只进入降级诊断，不阻塞解题。之后由不重叠的递归 timer 默认每 30 秒同步一次，失败指数退避，断开时停止。公告按平台 ID 与内容 revision hash 持久化；solve broadcast、新题上线和不含 hint/fix/update/attachment/environment/credential 等关键字的普通公告会被过滤。通过过滤且能确定匹配题目的公告先以 `pending` 候选显示在 WebUI，只有用户批准后才进入 `challenge_announcements` 上下文；拒绝项保持审计记录但不会发送。活跃 Solver 的获批公告 steer 先进入 `announcement_deliveries` outbox，按题目、公告 revision 和 Run 幂等排队，成功/失败/attempts 可恢复，失败 delivery 后续 poll 可重试。steer 只在消息队列尾部追加公告，不改写既有消息；支持前缀缓存的 Provider 通常仍可复用原有前缀，compact 才会重写会话上下文。

生产 Scheduler 在 accepted/already_solved 后进入 `writing_writeup`，保留同一 Solver/session 但将 active tools 限制为 `read/write/edit/list`。Solver 必须把英文可复现 writeup 写入题目 workspace，校验失败时最多继续专用 writeup turn，不增加 block score；通过校验后才以 solved 关闭并销毁 sandbox；校验失败会清除临时 terminal submission，再以 failed 关闭，不能被 close callback 自动改回 solved。测试调度器可显式关闭该流程以隔离生命周期测试。

题目级 TLDR 的 SQLite 记录独立于 Run，保存最新内容、模型、稳定 workspace 下的 `tldr/session.jsonl` 路径、更新时间和错误；更新采用题目主键 upsert，进程重启后以 SQLite 与该 JSONL 作为恢复依据。`CtfTldrAgent` 仅提供 `read/list`，题目、黑板、公告和已有 TLDR 作为不可信数据注入；Project 使用临时 sandbox 挂载同一题目 workspace，生成完成后销毁内存 Agent 和 sandbox。WebUI 详情可查看状态并触发 `/api/challenges/:id/tldr/refresh` 更新。

WebUI 的 Agent 缓存率统一计算为 `cacheRead / (input + cacheRead)`，`cacheWrite` 单独显示。Solver Run 从持久化 `agent_usage` 聚合；SubAgent 在 worker snapshot 中累计 input/cache read/cache write 并通过兼容迁移列持久化；TLDR 保存最近一次成功生成的 usage。没有可用 usage 或分母为 0 时显示无数据，不显示误导性的 0%。

Solver 停止原因经过 `classifySolverStop` 归一化：网络断连、Provider 5xx/429 和显式 retryable 错误不增加 block score，记录 `run_transient_failure` 后按基础设施退避重试；认证/配置错误不重试。模型自然停止、长度耗尽、协议异常和 prompt timeout 在未超过阈值时记录幂等 block event，并在同一 Run/session 追加 continuation prompt；超过阈值才关闭为 blocked。取消、进程关闭和已提交结果不计入 block。

Scheduler 已关闭 Solver 的隐式 BaseAgent compaction，并在每个 turn 前读取 context pressure。compact 边界先以 `delta=2` 预判有效阈值：可 compact 时执行 CTF compact 并写入 `compact_performed=true`，会超阈值时跳过 compact 并直接进入 `blocking`。`CTF_COMPACTION_PROMPT` 只让摘要保留未被权威快照覆盖的 Solver 本地调查状态；该提示词由 `CtfSolverAgent` 传给 Pi `AgentHarness.compact()`。compact 成功后，控制面按题目信息、非空黑板、已批准公告、SubAgent snapshot 的顺序重新注入最新结构化数据，因此各部分不在摘要中重复，compact 期间完成的 worker 结果也会进入下一 turn。blocking 阶段会向 running SubAgent 请求 final report，等待短 grace 后将最新 worker snapshot 作为不可信数据注入 Solver，执行一次 `BLOCKED_FINALIZATION_PROMPT` final turn；该收尾要求终止遗留进程、删除临时文件，并把所有保留文件的准确路径与用途记录为 Evidence。最终无论成功还是失败都关闭为 blocked，失败追加 `block_finalization_failed`。因 legacy interruption 上限而进入 blocking 时使用独立的 `forceChallengeBlocked` 生命周期更新，只改变 blocked 事实，不重复增加 block score；存在 ledger 的 Run 也不会再被 close callback 重复计分。事件 key 由 Run/session 事件序列稳定派生，崩溃重放不会重复计分。

调度等待队列持久化在 `scheduler_queue`，记录 normal/blocked lane、lane 内位置、人工跨 lane override 和乐观锁版本。自主调度优先填充 normal lane；普通题耗尽后，按 `blocked_at` 顺序加入 blocked revival。领取复活题时保留原 block score，`revival_count` 和 `lifecycle_generation` 各增加 1，因此有效阈值增加 4。人工重排使用版本检查，冲突时拒绝覆盖；数据库队列在进程关闭后保留，显式暂停自主调度或取消排队题目时才删除相应记录。生产默认 Solver 并发数为 8。
