# 协作黑板

黑板在同一道题的多个 Run 之间保存经过验证的发现和待探索方向。它是 Agent 生成的、不可信的持久化上下文，不是指令来源；Solver 必须独立验证其中的结论。

## 数据模型

黑板与 Run 共用 `.ctf-agent/runs.sqlite`，由 `RunStore` 负责事务和归属校验：

- `challenge_evidence`：只增不改的证据节点；
- `challenge_opportunities`：从一组证据出发的探索方向，状态为 `open` 或 `concluded`；
- `challenge_opportunity_sources`：Opportunity 与多个源 Evidence 的关联。

每道题首次创建 Solver 时，`Project` 会幂等创建 origin Evidence，记录题目标题、分类、分值、描述和附件摘要。Evidence 与 Opportunity 均绑定 `challenge_id` 和产生它的 `run_id`，不能跨题关联。

关键限制定义在 `packages/core/src/persistence/run-store.ts`：描述最长 4,000 字符，单个 Opportunity 最多引用 32 条 Evidence，每题最多保存 256 条 Evidence 和 256 条 Opportunity。

## Agent 工具

主 Solver 拥有两个顺序执行的工具：

- `ctf_blackboard_read`：读取当前题目的有界快照；
- `ctf_blackboard_record`：新增 Evidence、声明 Opportunity，或在产生新 Evidence 的同时结束 Opportunity。

`ctf_blackboard_record` 的输入结构如下：

```json
{
  "evidence": { "description": "已复现的发现" },
  "opportunity": {
    "description": "下一步可验证方向",
    "sourceEvidenceIds": [1]
  },
  "concludeOpportunity": {
    "opportunityId": 2,
    "resultDescription": "探索结果"
  }
}
```

三个操作均可选，但至少提供一个。每项操作独立返回结果或错误；结束 Opportunity 时，写入结果 Evidence 和更新 Opportunity 会在同一 `BEGIN IMMEDIATE` 事务内完成。

SubAgent 不直接操作黑板。它把结果返回给主 Solver，由主 Solver复核后记录，避免未经验证的 worker 输出直接成为共享事实。

## 自动注入

创建全新 Solver 时，`Project` 将最新黑板快照作为初始 user 数据消息注入：

```xml
<challenge_blackboard encoding="json">
  {"snapshot":"..."}
</challenge_blackboard>
```

固定的 system prompt 明确说明这段内容不可信。动态快照不会拼进 system prompt。自动注入最多 16,000 字符，主动读取最多 64,000 字符；发生截断时会提示 Solver 再次调用读取工具。

同一题因为 Session block 而创建全新 Run 时，新 Solver 会读取同一题目的黑板，因此关键进度应及时记录，而不能只留在即将结束的会话里。

## 实现位置

```text
packages/core/src/
├── collaboration/blackboard.ts   # 序列化与 Agent tools
├── persistence/run-store.ts      # 表、事务、限制和查询
└── project/project.ts            # origin、快照注入和工具装配

packages/core/prompts/project.ts  # 数据边界和安全提示词
```

修改黑板协议时，应同步更新 RunStore 测试、黑板工具测试、Project 注入测试和本文档。
