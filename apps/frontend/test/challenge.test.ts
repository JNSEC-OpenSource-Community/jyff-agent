import { describe, expect, it } from "vitest"
import {
  ACTIVE_STATUSES,
  challengeCategoryMark,
  filterChallenges,
  recentChallenges,
  sortChallenges,
  toneForStatus,
} from "../src/lib/challenge.ts"
import type { DashboardChallenge } from "../src/types.ts"

function challenge(overrides: Partial<DashboardChallenge>): DashboardChallenge {
  return {
    id: "c1",
    title: "题目",
    category: "web",
    score: 100,
    status: "pending",
    platformSolved: false,
    attempts: 0,
    latestRunId: null,
    latestRunStatus: null,
    lastActivityAt: null,
    progress: "",
    queuePosition: null,
    dispatchSource: null,
    schedulerAttempts: 0,
    sessionInterruptions: 0,
    evidence: 0,
    openOpportunities: 0,
    concludedOpportunities: 0,
    ...overrides,
  }
}

describe("toneForStatus", () => {
  it("已解出/完成 → positive", () => {
    expect(toneForStatus("solved")).toBe("positive")
    expect(toneForStatus("completed")).toBe("positive")
  })

  it("运行链路 → info", () => {
    for (const status of ACTIVE_STATUSES)
      expect(toneForStatus(status)).toBe("info")
  })

  it("失败/超时/中断/需介入 → danger", () => {
    for (const status of ["failed", "timed_out", "blocked", "interrupted"]) {
      expect(toneForStatus(status)).toBe("danger")
    }
  })

  it("队列/待派发 → warning，未知状态 → neutral", () => {
    expect(toneForStatus("queued")).toBe("warning")
    expect(toneForStatus("pending")).toBe("warning")
    expect(toneForStatus("closed")).toBe("neutral")
    expect(toneForStatus("mystery")).toBe("neutral")
  })
})

describe("filterChallenges", () => {
  const list = [
    challenge({ id: "a", title: "SQL 注入", status: "running" }),
    challenge({ id: "b", title: "XSS", status: "failed" }),
    challenge({
      id: "c",
      title: "逆向",
      category: "reverse",
      status: "queued",
    }),
    challenge({
      id: "d",
      title: "web 签到",
      category: "web",
      status: "solved",
    }),
  ]

  it("默认不过滤", () => {
    expect(filterChallenges(list, {})).toHaveLength(4)
  })

  it("按 active / attention 分组过滤", () => {
    expect(
      filterChallenges(list, { statusFilter: "active" }).map((c) => c.id),
    ).toEqual(["a"])
    expect(
      filterChallenges(list, { statusFilter: "attention" }).map((c) => c.id),
    ).toEqual(["b"])
  })

  it("按具体状态过滤", () => {
    expect(
      filterChallenges(list, { statusFilter: "solved" }).map((c) => c.id),
    ).toEqual(["d"])
  })

  it("关键词匹配标题与分类（忽略大小写与首尾空白）", () => {
    expect(
      filterChallenges(list, { query: "  sql  " }).map((c) => c.id),
    ).toEqual(["a"])
    expect(
      filterChallenges(list, { query: "REVERSE" }).map((c) => c.id),
    ).toEqual(["c"])
  })

  it("无匹配返回空数组", () => {
    expect(filterChallenges(list, { query: "不存在" })).toEqual([])
  })

  it("空关键词与 all 状态组合返回全部", () => {
    expect(
      filterChallenges(list, { query: " ", statusFilter: "all" }),
    ).toHaveLength(4)
  })
})

describe("sortChallenges", () => {
  it("执行中的题目置顶，其余按分值降序、标题升序", () => {
    const list = [
      challenge({ id: "low", title: "A 题", score: 50 }),
      challenge({ id: "high", title: "B 题", score: 200, status: "running" }),
      challenge({ id: "mid", title: "C 题", score: 100 }),
    ]
    expect(sortChallenges(list).map((c) => c.id)).toEqual([
      "high",
      "mid",
      "low",
    ])
  })

  it("同分值按中文标题升序", () => {
    const list = [
      challenge({ id: "z", title: "乙题", score: 100 }),
      challenge({ id: "a", title: "甲题", score: 100 }),
    ]
    expect(sortChallenges(list).map((c) => c.id)).toEqual(["a", "z"])
  })

  it("不修改原数组", () => {
    const list = [
      challenge({ id: "a", score: 10 }),
      challenge({ id: "b", score: 20 }),
    ]
    sortChallenges(list)
    expect(list.map((c) => c.id)).toEqual(["a", "b"])
  })
})

describe("recentChallenges", () => {
  it("按最后活动时间降序截取", () => {
    const list = [
      challenge({ id: "old", lastActivityAt: "2024-01-01T00:00:00Z" }),
      challenge({ id: "new", lastActivityAt: "2024-06-01T00:00:00Z" }),
      challenge({ id: "none", lastActivityAt: null }),
    ]
    expect(recentChallenges(list).map((c) => c.id)).toEqual([
      "new",
      "old",
      "none",
    ])
  })

  it("无活动时间的排在最后，且 limit 生效", () => {
    const list = [
      challenge({ id: "a", lastActivityAt: "2024-05-01T00:00:00Z" }),
      challenge({ id: "b", lastActivityAt: "2024-06-01T00:00:00Z" }),
      challenge({ id: "c", lastActivityAt: null }),
    ]
    expect(recentChallenges(list, 2).map((c) => c.id)).toEqual(["b", "a"])
  })
})

describe("challengeCategoryMark", () => {
  it("中文分类显示首个汉字，英文分类显示三字母缩写", () => {
    expect(challengeCategoryMark("美工设计")).toEqual({
      text: "美",
      chinese: true,
    })
    expect(challengeCategoryMark("现代密码")).toEqual({
      text: "现",
      chinese: true,
    })
    expect(challengeCategoryMark("web")).toEqual({
      text: "WEB",
      chinese: false,
    })
  })
})
