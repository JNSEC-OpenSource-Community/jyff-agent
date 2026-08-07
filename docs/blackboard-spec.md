# 协作黑板

黑板在同一道题的多个 Run 之间保存经过验证的发现和待探索方向。它是 Agent 生成的、不可信的持久化上下文，不是指令来源；Solver 必须独立验证其中的结论。

## 数据模型

黑板与 Run 共用 `.ctf-agent/runs.sqlite`，由 `RunStore` 负责事务和归属校验：

- `challenge_evidence`：可纠正、可删除的证据节点；
- `challenge_opportunities`：从一组证据出发、必须经过实验才能判断的探索方向；状态为 `open` 或 `concluded`，结束时 resolution 为 `confirmed` 或 `dead_end`；
- `challenge_opportunity_sources`：Opportunity 与多个源 Evidence 的关联。

黑板默认为空，不复制 `<challenge_context>` 中已经提供的标题、分类、分值、描述和附件。只有 Agent 通过黑板工具确认写入的 Evidence 和 Opportunity 才会持久化；两者均绑定 `challenge_id` 和产生它的 `run_id`，不能跨题关联。

关键限制定义在 `packages/core/src/persistence/run-store.ts`：描述最长 4,000 字符，单个 Opportunity 最多引用 32 条 Evidence，每题最多保存 256 条 Evidence 和 256 条 Opportunity。

## Agent 工具

主 Solver 拥有三个顺序执行的工具：

- `blackboard_read`：读取当前题目的有界快照；
- `blackboard_record`：新增 Evidence、声明 Opportunity，或在产生新 Evidence 的同时结束 Opportunity。
- `blackboard_manage`：按 ID 更新或删除一条 Evidence/Opportunity。

`blackboard_record` 的输入结构如下：

```json
{
  "evidence": { "description": "已复现的发现" },
  "opportunity": {
    "description": "下一步可验证方向",
    "sourceEvidenceIds": [1]
  },
  "concludeOpportunity": {
    "opportunityId": 2,
    "resolution": "dead_end",
    "resultDescription": "实验过程及确认不可行的结果"
  }
}
```

三个操作均可选，但至少提供一个。每项操作独立返回结果或错误；结束 Opportunity 时，写入结果 Evidence 和更新 Opportunity 会在同一 `BEGIN IMMEDIATE` 事务内完成。`resolution` 省略时兼容为 `confirmed`；标记 `dead_end` 时结果 Evidence 必须描述实际实验及其结果，记录默认会跨 Run 保留，除非 Solver 之后明确纠正或删除。

`blackboard_manage` 每次只接受一个 `action`：`update_evidence`、`delete_evidence`、`update_opportunity` 或 `delete_opportunity`。更新 Opportunity 时可以修改描述、源 Evidence 集合或两者。为避免静默破坏图关系，仍被 Opportunity 作为 source 或 target 引用的 Evidence 不能删除；应先更新或删除引用它的 Opportunity。所有操作继续按当前题目隔离，不能用其他题目的 ID 修改数据。

SubAgent 不直接操作黑板。它把结果返回给主 Solver，由主 Solver 复核后记录，避免未经验证的 worker 输出直接成为共享事实。无需实验即可排除的方向不应写成 Opportunity；平台公告和提示也必须经过验证后才能成为 Evidence。

## 自动注入

创建全新 Solver 时，`Project` 仅在黑板非空时将最新快照作为初始 user 数据消息注入：

```xml
<challenge_blackboard encoding="json">
  {"snapshot":"..."}
</challenge_blackboard>
```

动态快照不会拼进 system prompt。自动注入最多 16,000 字符，主动读取最多 64,000 字符；发生截断时会提示 Solver 再次调用读取工具。

同一题因为 Session block 而创建全新 Run 时，新 Solver 会读取同一题目的黑板，因此关键进度应及时记录，而不能只留在即将结束的会话里。

## 实现位置

```text
packages/core/src/
├── collaboration/blackboard.ts   # 序列化与 Agent tools
├── persistence/run-store.ts      # 表、事务、限制和查询
└── project/project.ts            # 非空快照注入和工具装配

packages/prompts/src/project.ts   # 数据边界和安全提示词
```

修改黑板协议时，应同步更新 RunStore 测试、黑板工具测试、Project 注入测试和本文档。
