# 黑板系统实现规范

> 面向开发者的实现规格说明。当前版本为**原型**——目标是用最小实现验证黑板模式在 CTF 解题中的效果。实现上保持克制，但架构上预留扩展点，为后续的多 Agent 协作、LLM 摘要等方向留下可演进空间。

---

## 1. 概述与边界

### 1.1 问题

当前每次 attempt 是孤立的。attempt-1 的发现不传递给 attempt-2。黑板在**同一道题目**的多次 attempt 之间传递结构化知识。

### 1.2 范围内（原型阶段必须实现）

> 以下为第一版原型的最小范围。每个条目在实现时都考虑到了后续扩展——
> 例如数据模型不做跨题目知识迁移，但 challenge_id 字段的存在使得扩展时只需改动查询条件。

| 项 | 说明 |
|---|---|
| Origin Evidence | 首次创建 Solver 时自动建立，包含题目结构化摘要 |
| 持久化 Evidence 与 Opportunity | SQLite，与 runs 同库 |
| Agent 可读写黑板 | 两个工具：`ctf_blackboard_read` + `ctf_blackboard_record` |
| 自动注入既有知识 | 每次创建 Solver 时自动将黑板内容注入 systemPrompt |
| 超边关联 | Opportunity 可从多个 Evidence 出发 |
| 结论即产出 Evidence | conclude 时必须同时创建一条新 Evidence |

### 1.3 范围外（明确不做）

| 项 | 说明 |
|---|---|
| 跨题目知识迁移 | Evidence/Opportunity 只绑定单个 challenge_id |
| 多 Agent 协同协议 | 无 claim/heartbeat/release；Opportunity 只有 open/concluded 两态 |
| Hint（外部策略注入） | 无 |
| 独立 HTTP 服务 | 黑板嵌入 RunStore，不暴露网络接口 |
| 图可视化 | 不做 |
| 图推理算法（置信度、死路检测等） | 不做 |

### 1.4 核心概念

```
Evidence（证据）           Opportunity（机会）
─────────────────         ──────────────────────
表示: 已确认的客观发现      表示: 从 Evidence 出发的探索方向
生命周期: 只增不改          生命周期: open → concluded
产出方式: Agent 直接记录     产出方式: Agent 声明 + Agent 结论
                           结论约束: 结论时必须同时产出新 Evidence

特殊 Evidence: origin
  每个 challenge 的第一条 Evidence，由系统在首次创建 Solver 时自动创建。
  包含题目的结构化摘要（title / category / score / description / attachments）。
  作为所有后续 Opportunity 的逻辑起点。
```

---

## 2. 存储规范

### 2.1 位置

`runs.sqlite`，不新建数据库文件。建表语句追加到 `RunStore.open()` 的现有 DDL 中。

### 2.2 表定义

```sql
-- 证据节点（只 INSERT，不 UPDATE 不 DELETE）
CREATE TABLE IF NOT EXISTS challenge_evidence (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id   TEXT    NOT NULL,
  description    TEXT    NOT NULL,
  run_id         TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at     TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_evidence_challenge
  ON challenge_evidence(challenge_id, id);


-- 探索机会（可 INSERT + UPDATE status/target_evidence_id/concluded_at）
CREATE TABLE IF NOT EXISTS challenge_opportunities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id        TEXT    NOT NULL,
  description         TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'concluded')),
  run_id              TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  target_evidence_id  INTEGER          REFERENCES challenge_evidence(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL,
  concluded_at        TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_opportunities_challenge
  ON challenge_opportunities(challenge_id, status);


-- 超边关联（多对多）
CREATE TABLE IF NOT EXISTS challenge_opportunity_sources (
  opportunity_id  INTEGER NOT NULL REFERENCES challenge_opportunities(id) ON DELETE CASCADE,
  evidence_id     INTEGER NOT NULL REFERENCES challenge_evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (opportunity_id, evidence_id)
);
```

### 2.3 RunStore 新增方法

```typescript
interface EvidenceRecord {
  id: number
  challengeId: string
  description: string
  runId: string
  createdAt: string
}

type OpportunityStatus = "open" | "concluded"

interface OpportunityRecord {
  id: number
  challengeId: string
  description: string
  status: OpportunityStatus
  runId: string
  sourceEvidenceIds: number[]
  targetEvidenceId: number | null
  createdAt: string
  concludedAt: string | null
}

interface BlackboardSummary {
  evidence: { id: number; description: string; runId: string }[]
  opportunities: {
    id: number
    description: string
    status: OpportunityStatus
    sourceEvidenceIds: number[]
    targetEvidenceId: number | null
  }[]
}
```

方法契约：

```
recordEvidence(challengeId, runId, description) → EvidenceRecord
  行为: INSERT challenge_evidence，返回完整记录
  异常: 不校验 description 内容（由 Agent 保证质量）

ensureOrigin(challengeId, runId, challengeInfo) → EvidenceRecord
  行为: 如果该 challenge 尚无任何 evidence，则创建一条 origin evidence。
        内容为结构化摘要:
          Title: {challengeInfo.title}
          Category: {challengeInfo.category}
          Score: {challengeInfo.score}
          Description: {challengeInfo.description}
          Attachments:
            - {name1} ({size1} bytes)
            - {name2} ({size2} bytes)
  幂等: 如果已有 evidence（包括之前已创建的 origin），则不做任何事，返回已有的 origin。
  返回: origin evidence（新创建的或已存在的）

recordOpportunity(challengeId, runId, description, sourceEvidenceIds[]) → OpportunityRecord
  前置条件: sourceEvidenceIds 必须非空
  行为: 一个事务内完成:
        1. INSERT challenge_opportunities (status='open')
        2. 对每个 sourceEvidenceId: INSERT challenge_opportunity_sources
  异常: 任一 sourceEvidenceId 不存在于 challenge_evidence 时报错（外键约束）

concludeOpportunity(opportunityId, resultDescription, runId) → { evidence, opportunity }
  前置条件: opportunity 必须存在且 status='open'
  行为: 一个事务内完成:
        1. INSERT challenge_evidence（challenge_id 从 opportunity 继承）
        2. UPDATE challenge_opportunities SET status='concluded', target_evidence_id=<新id>, concluded_at=now
  返回: 新创建的 Evidence 和更新后的 Opportunity

getBlackboardSummary(challengeId) → BlackboardSummary
  行为: 查询 challenge_evidence + challenge_opportunities + JOIN sources
  返回: 按 id 升序排列的所有 evidence 和 opportunity
  性能: 数据量极小（单题通常 < 100 行），无需分页
```

### 2.4 事务要求

| 方法 | 事务 |
|---|---|
| `recordEvidence` | 单行 INSERT，隐式事务即可 |
| `ensureOrigin` | 先 SELECT 检查 → 如需要则 INSERT；用于幂等保护时加 BEGIN IMMEDIATE |
| `recordOpportunity` | BEGIN IMMEDIATE → 多条 INSERT → COMMIT |
| `concludeOpportunity` | BEGIN IMMEDIATE → INSERT + UPDATE → COMMIT |
| `getBlackboardSummary` | 只读，不需要事务 |

### 2.5 外键约束含义

```sql
ON DELETE CASCADE  在 opportunity_sources:
  → 删除 opportunity 时自动清理关联行

ON DELETE SET NULL 在 opportunities.target_evidence_id:
  → 删除 evidence 时，引用它的 opportunity 的 target_evidence_id 置为 NULL
  （实际上 evidence 只增不删，这是防御性设计）

ON DELETE CASCADE  在所有 run_id 引用上:
  → 删除 run 时级联删除相关 evidence 和 opportunity
  （由 RunStore 统一管理生命周期）
```

---

## 3. Agent 接口规范

### 3.1 工具注入位置

在 `createSolverTools()` 中，将黑板工具追加到现有 tools 数组末尾。黑板工具通过闭包持有 `runStore`、`challengeId`、`runId`。

### 3.2 `ctf_blackboard_read`

**TypeBox 签名：**
```typescript
Type.Object({})
```

**行为：**
1. 调用 `runStore.getBlackboardSummary(challengeId)`
2. `serializeBlackboard(summary)` 转为文本
3. 返回 `{ content: [{ type: "text", text }] }`

**序列化格式（精确规范）：**

当前版本采用**结构化序列化**——将图数据转为 Markdown 列表。这是原型阶段的务实选择：
- 单题图的规模通常不大（几十条 evidence），Markdown 列表完全可读
- LLM 对 Markdown 格式的理解能力经过充分验证，无需额外适配
- 保留了精确的 ID 引用（`[e{id}]`、`[o{id}]`），Agent 调用 `ctf_blackboard_record` 时可直接使用

后期如果图膨胀到数百条 evidence，可在此层增加**LLM 摘要模式**——调一次小模型
将结构化数据压缩为叙事文本，作为 Markdown 列表的替代或补充。该扩展仅需修改
`serializeBlackboard()` 的实现，不影响数据模型和 Agent 工具接口。

```
## Confirmed Evidence
{each: "- [e{id}] {description}\n"}
（若无额外 evidence 则省略此段，但 origin 至少保证有一条）
（若所有段均为空——即黑板中无任何记录，仅返回尾部的使用提示）

## Open Opportunities
{each: "- [o{id}] from {e1, e2, ...}: {description}\n"}
（若无则省略此段）

## Concluded Opportunities
{each: "- [o{id}] from {e1, e2, ...} → e{target}: {description}\n"}
（若无则省略此段）
```

末尾始终追加：
```
Use ctf_blackboard_record to add new evidence or opportunities as you discover them.
```

### 3.3 `ctf_blackboard_record`

**TypeBox 签名：**
```typescript
Type.Object({
  evidence: Type.Optional(Type.Object({
    description: Type.String({ minLength: 1 }),
  })),
  opportunity: Type.Optional(Type.Object({
    description: Type.String({ minLength: 1 }),
    sourceEvidenceIds: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
  })),
  concludeOpportunity: Type.Optional(Type.Object({
    opportunityId: Type.Integer({ minimum: 1 }),
    resultDescription: Type.String({ minLength: 1 }),
  })),
})
```

**行为：** 按顺序执行三个可选操作（先 evidence，再 opportunity，最后 concludeOpportunity），每个操作的错误不阻断后续操作：

```
if (evidence) {
  try { result.evidence = runStore.recordEvidence(...) }
  catch (e) { result.evidenceError = e.message }
}
if (opportunity) {
  try { result.opportunity = runStore.recordOpportunity(...) }
  catch (e) { result.opportunityError = e.message }
}
if (concludeOpportunity) {
  try { result.concluded = runStore.concludeOpportunity(...) }
  catch (e) { result.concludeError = e.message }
}
```

**约束：**
- 至少提供一个操作（`evidence`、`opportunity`、`concludeOpportunity` 不能全部为空）
  - 由于三者都是 Optional，TypeBox 层面允许全空；**实现时需在 execute 入口处校验**，全空时抛出 `"至少需要提供 evidence、opportunity 或 concludeOpportunity 之一"`
- `opportunity.sourceEvidenceIds` 如果指定了不存在的 evidence ID，由 RunStore 的外键约束报错，工具返回包含该错误的结果
- `concludeOpportunity.opportunityId` 如果指定了不存在或已 concluded 的 opportunity，由 RunStore 报错

### 3.4 执行模式

两个工具均标记 `executionMode: "sequential"`，因为：
- `ctf_blackboard_record` 涉及写操作，需要保证顺序
- `ctf_blackboard_read` 是纯读，但为了一致性也标记 sequential

---

## 4. Origin 与自动注入

### 4.1 Origin 创建

在 `Project.createSolver()` 中，**`capability.getInfo()` 返回后**，立即调用：

```typescript
this.runStore.ensureOrigin(challengeId, runId, {
  title: challenge.title,
  category: challenge.category,
  score: challenge.score,
  description: challenge.description,
  attachments: challenge.attachments,
})
```

由于每次 `createSolver()` 都会调用，`ensureOrigin` 内部通过检查 `challenge_evidence` 是否已有数据来实现幂等。

### 4.2 黑板内容注入

在 `Project.createSolver()` 中，**Agent 构造之前**（与 origin 创建之后）：

```typescript
const summary = this.runStore.getBlackboardSummary(challengeId)
const text = serializeBlackboard(summary)
options.agent.initialState!.systemPrompt +=
  `\n\n<challenge_blackboard>\n${text}\n</challenge_blackboard>`
```

由于 origin 始终存在，**每次 attempt（包括 attempt=1）都注入**。origin 内容即为题目的结构化摘要，对 Agent 始终可见。

### 4.3 注入格式

使用 XML 标签包裹，与现有的 `<available_skills>` 格式一致：

```
<challenge_blackboard>
{serializeBlackboard() 的输出}
</challenge_blackboard>
```

### 4.4 边界情况

| 情况 | 行为 |
|---|---|
| origin 已存在（后续 attempt） | `ensureOrigin` 幂等，不重复创建 |
| `getBlackboardSummary()` 抛异常 | 静默吞掉，不注入（避免阻断解题） |
| `serializeBlackboard()` 返回空字符串 | 不注入 |
| systemPrompt 原本为空 | 从 `\n\n<challenge_blackboard>...` 开始拼接 |

### 4.5 Token 预算考量

不做额外处理。黑板内容（含 origin 摘要）不计入 compaction 的 reserve 计算，由现有的 compaction 机制统一管理。

---

## 5. 集成规范

### 5.1 文件变更清单

```
packages/solver/src/
├── blackboard/
│   └── index.ts              ← 【新增】所有黑板逻辑的入口
├── project/
│   └── run-store.ts          ← 【修改】加 3 张表 + 类型导出 + 5 个方法（含 ensureOrigin）+ 1 个 helper
├── sandbox/
│   └── tools.ts              ← 【修改】createSolverTools() 调用 createBlackboardTools()
├── project/
│   └── project.ts            ← 【修改】createSolver() 加 origin 创建 + 注入逻辑
└── index.ts                  ← 【修改】加 export * from "./blackboard/index.ts"
```

### 5.2 允许修改与严禁修改的文件

以下文件**仅允许做最小 plumbing 修改**（透传 blackboard 配置到工具层）：

| 文件 | 允许范围 | 原因 |
|---|---|---|
| `solver-agent.ts` | 仅允许在 `CreateCtfSolverAgentOptions` 新增 `blackboard?` 字段，并透传给 `createSolverTools()` | tools 需要闭包捕获 `runStore`/`challengeId`/`runId`，必须通过该文件传递 |

以下文件在任何情况下都**不应**因本次变更而被修改：

| 文件 | 原因 |
|---|---|
| `contest-runner.ts` | 调度不涉及黑板；attempt 编号由 RunStore 管理 |
| `docker-sandbox.ts` | 黑板数据全在宿主机 SQLite 中 |
| `agent/compaction.ts` | 压缩不涉及黑板 |
| `skills/project-skills.ts` | 技能系统与黑板正交 |
| `platform/types.ts` | 平台接口不变 |

### 5.3 数据流

```
createSolver(challengeId):
  1. capability.getInfo()  →  challenge 元数据
  2. ensureOrigin()        →  challenge_evidence (origin 记录)
  3. getBlackboardSummary() → serializeBlackboard() → 注入 systemPrompt
  4. 创建 Agent（tools 中包含 ctf_blackboard_read / ctf_blackboard_record）

Agent 运行时:
  ctf_blackboard_read   → getBlackboardSummary() → 序列化 → 文本
  ctf_blackboard_record → recordEvidence() / recordOpportunity() / concludeOpportunity()
                        → SQLite 写入
```

### 5.4 依赖关系

- `blackboard/index.ts` 依赖 `run-store.ts` 的类型
- `tools.ts` 依赖 `blackboard/index.ts`
- `project.ts` 依赖 `blackboard/index.ts` + `run-store.ts`
- 不引入新的 npm 依赖

---

## 6. 错误处理规范

### 6.1 数据库错误

| 场景 | 处理 |
|---|---|
| SQLite 写入失败（磁盘满等） | RunStore 事务回滚，错误冒泡到工具 → 返回 error 给 Agent |
| 外键约束违反（引用不存在的 evidence/opportunity） | SQLite 报错 → RunStore 抛出 → 工具捕获 → 返回 error |
| RunStore 已关闭后调用 | `assertOpen()` 抛出 → 工具捕获 → 返回 error |
| 并发写入冲突 | WAL 模式 + busy_timeout=5000ms 自动处理 |
| ensureOrigin 并发调用 | 幂等设计 + BEGIN IMMEDIATE 事务保证只有一条 origin |

### 6.2 Agent 输入错误

| 场景 | 处理 |
|---|---|
| sourceEvidenceIds 为空数组 | TypeBox `minItems` 约束阻止 |
| description 为空字符串 | TypeBox `minLength: 1` 约束阻止 |
| 三个操作全空 | execute 入口显式检查，抛出错误 |
| sourceEvidenceIds 包含不存在 ID | 外键约束报错，返回 error 字段 |
| opportunityId 不存在或已 concluded | RunStore 报错，返回 error 字段 |

### 6.3 注入错误

| 场景 | 处理 |
|---|---|
| `getBlackboardSummary()` 抛异常 | 静默吞掉，不注入 |
| `serializeBlackboard()` 返回空字符串 | 不注入 |

---

## 7. 实现检查清单

- [ ] `RunStore.open()` 创建包含三张新表
- [ ] `recordEvidence()` 正确写入并返回 EvidenceRecord
- [ ] `ensureOrigin()` 首次调用创建 origin，再次调用幂等返回已有
- [ ] `recordOpportunity()` 在一个事务中写入 opportunity + sources
- [ ] `concludeOpportunity()` 在一个事务中创建 evidence + 更新 opportunity
- [ ] `getBlackboardSummary(challengeId)` 返回正确关联的数据
- [ ] `createBlackboardTools()` 返回两个工具，均可被 Agent 调用
- [ ] `ctf_blackboard_read` 输出符合 3.2 定义的格式
- [ ] `ctf_blackboard_record` 支持三种操作，错误不阻断后续操作
- [ ] `ctf_blackboard_record` 全空参数时抛出友好错误
- [ ] `project.createSolver()` 在获取 challenge 信息后调用 `ensureOrigin()`
- [ ] `project.createSolver()` 始终注入黑板内容（含 origin）
- [ ] `serializeBlackboard()` 黑板为空时返回固定提示文本
- [ ] TypeScript 类型检查通过（`tsc --noEmit`）
- [ ] 现有所有测试仍然通过（`pnpm test`）
- [ ] `index.ts` 导出 `EvidenceRecord`、`OpportunityRecord`、`BlackboardSummary` 等类型
- [ ] 未修改严禁修改的文件清单中的任何文件

---

## 8. 后续方向：多 Agent 协作

> 以下为愿景陈述，不在当前原型范围内。供团队讨论和后续设计参考。
> 当前原型的数据模型（Evidence + Opportunity + 超边关联）可直接承载多 Agent 模式，
> 无需迁移。

### 8.1 目标架构

```
                         ┌──────────────────────┐
                         │      Blackboard       │
                         │  Evidence + Opportunity│
                         └──────────┬───────────┘
                                    │ 读写
                    ┌───────────────┴───────────────┐
                    │          Main Agent            │
                    │  - 创建题目 Origin 结构化摘要   │
                    │  - 读取全图，判断态势            │
                    │  - 提出新 Opportunity 并派发     │
                    │  - 接收 SubAgent 结果并写入图    │
                    └──────┬────────────┬───────────┘
                           │            │
                  派发任务  │            │  派发任务
                           ↓            ↓
              ┌──────────────┐  ┌──────────────┐
              │  SubAgent A  │  │  SubAgent B  │
              │  (explore)   │  │  (explore)   │
              │  执行探索     │  │  执行探索     │
              │  返回结果     │  │  返回结果     │
              └──────────────┘  └──────────────┘
                     ↑                 ↑
                     └─── 共享 Docker ──┘
                      (同一 challenge 一个容器)
```

### 8.2 角色定义

| 角色 | 职责 | 类比 Cairn |
|---|---|---|
| **Main Agent** | 读图 → 判断态势 → 声明 Opportunity → 派发给 SubAgent → 接收结果 → 写图 | Dispatcher + Reason 的推理部分 |
| **SubAgent** | 接收一个 Opportunity + 相关 Evidence 上下文 → 执行探索 → 返回结构化结果 | Worker（执行 explore 任务） |

Main Agent **不执行具体探索**。它的全部工作是调度和写图。SubAgent **不直接写图**——它返回结构化结果给 Main Agent，由 Main Agent 代为写入。

### 8.3 协作机制

采用**信息素式去中心化协调**（Stigmergy）：

- Agent 之间**不直接通信**
- 协作完全通过黑板间接完成
- SubAgent A 写了一条新 Evidence，Main Agent 在下一轮读图时感知到，可能据此派发新的 Opportunity 给 SubAgent B
- 不存在中央调度瓶颈——Main Agent 的决策仅取决于图状态，多个 SubAgent 可并行推进不同方向

这种模式等价于 Cairn 的核心设计，区别在于：Cairn 的 Dispatcher 是纯调度（不做推理），而我们的 Main Agent 同时承担推理和调度——它用 LLM 能力自己判断"图走到哪了、下一步该派发什么"，而非依赖预定义的调度规则。

### 8.4 SubAgent 契约

SubAgent 接收的 prompt 应包含：

```
# 任务
执行以下探索方向并返回结论。

# 背景（当前已知证据）
- [e1] ...
- [e2] ...

# 当前 Opportunity
[oX] from e1, e2: <description>

# 输出要求
只返回一个 JSON:
{"finding": "<客观发现描述>"}
```

SubAgent 返回后，Main Agent 调用 `concludeOpportunity()`，将 finding 写入为新的 Evidence。Main Agent 可以基于新 Evidence 的质量决定是否继续声明更多 Opportunity。

### 8.5 运行环境

同一 challenge 的所有 Agent（Main + 多个 SubAgent）共享一个 Docker 容器。容器内的工作目录即为当前的 workspace。这与 Cairn 的"一个项目一个容器"一致。

### 8.6 与当前原型的关系

当前原型实现的是**单 Agent 模式**——Agent 既是"推理者"也是"执行者"，通过 `ctf_blackboard_record` 直接操作黑板。这为多 Agent 模式打下了基础：

| 当前原型 | 多 Agent 模式 |
|---|---|
| 一个 Solver 负责全部 | Main Agent + N SubAgent |
| Agent 直接调 `ctf_blackboard_record` | Main Agent 代 SubAgent 写图 |
| 无角色区分 | 明确的调度/执行分离 |
| Opportunity 只有 open/concluded | 可加 `claimed`/`exploring` 状态 |

数据模型（Evidence + Opportunity + 超边关联）在两种模式下完全一致，不需要迁移。

---

## 附录：类型导出清单

`packages/solver/src/index.ts` 需新增导出：

```
EvidenceRecord
OpportunityRecord
OpportunityStatus
BlackboardSummary
```

`packages/solver/src/blackboard/index.ts` 需导出：

```
serializeBlackboard()
createBlackboardTools()
BlackboardToolOptions（参数类型）
```
