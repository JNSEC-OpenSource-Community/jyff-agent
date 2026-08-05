export const LENGTH_CONTINUATION_PROMPT =
  "上一轮输出因长度上限被截断，当前题目尚未完成。停止长篇内部推理，不要复述已有分析；下一回复尽快调用至少一个工具，把复杂分析拆成可验证的短步骤并继续推进，直到提交正确 Flag 或确认存在无法绕过的外部阻塞。"

export const INCOMPLETE_CONTINUATION_PROMPT =
  "当前仍未提交正确 Flag，因此本次解题尚未完成。检查已有证据和失败假设，立即选择下一条可验证路径并继续调用工具；不要只给建议、计划、总结或把后续工作留给用户。"
