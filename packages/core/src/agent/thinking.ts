// 思考块提取:从 agent message_end 事件的消息中提取整 turn 思考文本。
//
// 原生化迁移(design.md §4.2):
// - pi-ai 原生链路把 thinking_* 流事件组装为 AssistantMessage 的 ThinkingContent 块,
//   在 message_end 事件中随完整消息一次性携带 → 天然每 turn 一条,无逐词问题;
// - 本模块只做纯函数提取(多块按 \n 合并 + 4KB 截断),由 project.ts 订阅方接线持久化。

export const MAX_REASONING_CHARS = 4096;
export const MAX_ASSISTANT_TEXT_CHARS = 8000;

interface ThinkingBlockLike {
	type?: string;
	thinking?: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

/** 提取消息中的思考块(整 turn 聚合);无思考块/内容异常返回 ""。合并后统一截断保留开头。 */
export function extractThinkingText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = Array.isArray((message as MessageLike).content)
		? ((message as MessageLike).content as unknown[])
		: [];
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as ThinkingBlockLike).type === "thinking"
		) {
			const thinking = (block as ThinkingBlockLike).thinking;
			if (typeof thinking === "string" && thinking.length > 0)
				parts.push(thinking);
		}
	}
	if (parts.length === 0) return "";
	const joined = parts.join("\n");
	return joined.length > MAX_REASONING_CHARS
		? joined.slice(0, MAX_REASONING_CHARS)
		: joined;
}

interface TextBlockLike {
	type?: string;
	text?: unknown;
}

/**
 * 提取 assistant 消息的文本块(整 turn 聚合),供对话框时间线展示。
 * 只处理 role === "assistant" 的消息:user 提示消息、toolResult 消息与黑板
 * 注入消息同样触发 message_end,必须按 role + text 块过滤,否则会误报事件。
 */
export function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as MessageLike;
	if (candidate.role !== "assistant") return "";
	const content = Array.isArray(candidate.content) ? candidate.content : [];
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as TextBlockLike).type === "text"
		) {
			const text = (block as TextBlockLike).text;
			if (typeof text === "string" && text.length > 0) parts.push(text);
		}
	}
	if (parts.length === 0) return "";
	const joined = parts.join("\n");
	return joined.length > MAX_ASSISTANT_TEXT_CHARS
		? joined.slice(0, MAX_ASSISTANT_TEXT_CHARS)
		: joined;
}
