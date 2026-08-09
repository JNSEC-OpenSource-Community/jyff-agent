import type { AgentStreamEvent, AgentStreamPayload } from "@ctf-agent/core"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { describe, expect, it } from "vitest"
import {
  applyAgentStreamEvent,
  INITIAL_AGENT_ACTIVITY,
  mergeCanonicalConversation,
  reduceAgentActivity,
  shouldRefreshAgentView,
} from "../src/lib/conversation-stream.ts"

const createdAt = "2026-08-09T10:00:00.000Z"

describe("applyAgentStreamEvent", () => {
  it("将文本增量合并进同一条 Assistant 消息", () => {
    const first = applyAgentStreamEvent(
      null,
      streamEvent({
        type: "message_started",
        messageId: "message-1",
        message: assistantMessage(""),
      }),
    )
    const completed = applyAgentStreamEvent(
      applyAgentStreamEvent(
        first,
        streamEvent({
          type: "text_delta",
          messageId: "message-1",
          contentIndex: 0,
          delta: "发现 ",
        }),
      ),
      streamEvent({
        type: "text_delta",
        messageId: "message-1",
        contentIndex: 0,
        delta: "offset",
      }),
    )

    expect(completed.messages).toHaveLength(1)
    expect(completed.messages[0]?.entryId).toBe("live:message-1")
    const message = completed.messages[0]?.message
    if (message?.role !== "assistant") throw new Error("缺少 Assistant 消息")
    expect(message.content).toEqual([{ type: "text", text: "发现 offset" }])
  })

  it("忽略找不到对应消息的迟到 delta", () => {
    const conversation = applyAgentStreamEvent(
      null,
      streamEvent({
        type: "text_delta",
        messageId: "missing",
        contentIndex: 0,
        delta: "late",
      }),
    )
    expect(conversation.messages).toEqual([])
  })
})

describe("mergeCanonicalConversation", () => {
  it("校准已落盘消息并保留尚未落盘的实时消息", () => {
    const persisted = {
      entryId: "persisted-1",
      timestamp: createdAt,
      message: assistantMessage("done"),
    }
    const pending = {
      entryId: "live:message-2",
      timestamp: createdAt,
      message: assistantMessage("still streaming"),
    }
    expect(
      mergeCanonicalConversation(
        { messages: [persisted] },
        {
          messages: [{ ...persisted, entryId: "live:message-1" }, pending],
        },
      ).messages,
    ).toEqual([persisted, pending])
  })
})

describe("reduceAgentActivity", () => {
  it("跟踪工具从运行到失败的状态与耗时边界", () => {
    const running = reduceAgentActivity(
      INITIAL_AGENT_ACTIVITY,
      streamEvent({
        type: "tool_started",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "file chall" },
      }),
    )
    expect(running).toMatchObject({
      phase: "tool",
      detail: "bash",
      tools: { "tool-1": { status: "running" } },
    })

    const failed = reduceAgentActivity(
      running,
      streamEvent({
        type: "tool_completed",
        toolCallId: "tool-1",
        toolName: "bash",
        result: "not found",
        isError: true,
      }),
    )
    expect(failed).toMatchObject({
      phase: "responding",
      tools: { "tool-1": { status: "failed", result: "not found" } },
    })
  })

  it("记录并清除当前流式消息", () => {
    const started = reduceAgentActivity(
      INITIAL_AGENT_ACTIVITY,
      streamEvent({
        type: "message_started",
        messageId: "message-1",
        message: assistantMessage(""),
      }),
    )
    expect(started.streamingMessageId).toBe("message-1")

    const completed = reduceAgentActivity(
      started,
      streamEvent({
        type: "message_completed",
        messageId: "message-1",
        message: assistantMessage("done"),
      }),
    )
    expect(completed.streamingMessageId).toBeUndefined()
  })
})

describe("shouldRefreshAgentView", () => {
  it("在 Father 请求测试连接信息后刷新页面投影", () => {
    expect(
      shouldRefreshAgentView(
        streamEvent({
          type: "tool_completed",
          toolCallId: "tool-1",
          toolName: "father_request_test_access",
          result: { requested: true },
          isError: false,
        }),
      ),
    ).toBe(true)
    expect(
      shouldRefreshAgentView(
        streamEvent({
          type: "tool_completed",
          toolCallId: "tool-2",
          toolName: "bash",
          result: "ok",
          isError: false,
        }),
      ),
    ).toBe(false)
  })

  it("在自动 compact 结束后恢复 responding 状态", () => {
    const compacting = reduceAgentActivity(
      INITIAL_AGENT_ACTIVITY,
      streamEvent({ type: "status_changed", status: "compacting" }),
    )
    expect(compacting.phase).toBe("compacting")
    expect(
      reduceAgentActivity(
        compacting,
        streamEvent({ type: "status_changed", status: "active" }),
      ).phase,
    ).toBe("responding")
  })
})

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.parse(createdAt),
  }
}

function streamEvent(payload: AgentStreamPayload): AgentStreamEvent {
  return {
    ...payload,
    runId: "run-1",
    seq: 1,
    createdAt,
  } as AgentStreamEvent
}
