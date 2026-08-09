# Third Party Notices

## pi-web-access

本目录包含 [pi-web-access](https://github.com/nicobailon/pi-web-access) 的派生代码，作为纯 Agent 工具库接入 ctf-agent。

- **版权**：Copyright (c) 2025 Nico Bailon
- **License**：MIT（见同目录 `LICENSE`）
- **上游 commit**：`7bf05f9acc4a61d9ff50927fa8be7ad3f87d77b6`（v0.19.0）

派生细节见 `UPSTREAM_PIN.md`。

## 运行时依赖

| 包 | License | 用途 |
|---|---|---|
| `@earendil-works/pi-ai` | MIT | `complete` / `Model` / `Api` 类型（auto-summary） |
| `@mozilla/readability` | Apache-2.0 | 正文抽取 |
| `linkedom` | MIT | DOM 解析 |
| `p-limit` | MIT | 并发限流 |
| `promise.try` | MIT | `Promise.try` ponyfill |
| `turndown` | MIT | HTML → Markdown |
| `typebox` | MIT | 工具参数 schema |
| `unpdf` | MIT | PDF 文本抽取 |
