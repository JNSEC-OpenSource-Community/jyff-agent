import type { Announcement, ChallengeSummary } from "@ctf-agent/platform"
import { describe, expect, it } from "vitest"
import {
  announcementRevision,
  classifyAnnouncement,
  filterAnnouncementKeywords,
  matchAnnouncementChallenges,
  normalizeAnnouncementText,
} from "../../src/orchestration/announcement-matcher.ts"

const challenges: ChallengeSummary[] = [
  { id: "12", title: "Cookie Jar", category: "Web", score: 500 },
  { id: "13", title: "Cookie", category: "Web", score: 300 },
  { id: "14", title: "RE", category: "Reverse", score: 200 },
  { id: "15", title: "同名题", category: "Misc", score: 100 },
  { id: "16", title: "同名题", category: "Misc", score: 100 },
]

function announcement(input: Partial<Announcement>): Announcement {
  return {
    id: "notice",
    title: "Notice",
    content: "",
    publishedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  }
}

describe("announcement classification", () => {
  it("uses a stable key per platform ID and content revision", () => {
    const first = announcementRevision(
      announcement({ id: "1", title: "Hint", content: "v1" }),
    )
    expect(
      announcementRevision(
        announcement({ id: "1", title: "Hint", content: "v1" }),
      ),
    ).toEqual(first)
    expect(
      announcementRevision(
        announcement({ id: "1", title: "Hint", content: "v2" }),
      ).key,
    ).not.toBe(first.key)
  })

  it("filters platform blood kinds, blood titles, and structured solve actions", () => {
    expect(
      classifyAnnouncement(announcement({ kind: "solve_broadcast" })),
    ).toMatchObject({ ignored: true, reason: "platform_kind" })
    expect(
      classifyAnnouncement(announcement({ title: "First Blood: Cookie Jar" })),
    ).toMatchObject({ ignored: true, reason: "blood_title" })
    expect(
      classifyAnnouncement(
        announcement({ content: "team alpha solved by user beta" }),
      ),
    ).toMatchObject({ ignored: true, reason: "structured_solve_action" })
  })

  it("does not drop a real hint merely because it mentions the blood mechanic", () => {
    expect(
      classifyAnnouncement(
        announcement({
          kind: "hint",
          title: "Scoring hint",
          content: "The first blood mechanic changes only the score.",
        }),
      ),
    ).toEqual({ kind: "hint", ignored: false, reason: "platform_kind" })
  })

  it("只让包含关键变更词的公告进入人工审批", () => {
    expect(
      filterAnnouncementKeywords(
        announcement({
          title: "Cookie Jar attachment updated",
          content: "Download the fixed archive.",
        }),
      ),
    ).toEqual({
      eligible: true,
      matchedKeywords: ["fix", "update", "attachment"],
      reason: "critical_keyword",
    })
    expect(
      filterAnnouncementKeywords(
        announcement({ kind: "hint", title: "Cookie Jar", content: "Look up" }),
      ),
    ).toEqual({
      eligible: true,
      matchedKeywords: ["hint"],
      reason: "critical_keyword",
    })
  })

  it("过滤新题上线和没有关键字的普通旧公告", () => {
    expect(
      filterAnnouncementKeywords(
        announcement({
          kind: "new_challenge",
          title: "New challenge: Cookie Jar",
        }),
      ),
    ).toMatchObject({ eligible: false, reason: "new_challenge" })
    expect(
      filterAnnouncementKeywords(
        announcement({ title: "Welcome", content: "Contest starts now" }),
      ),
    ).toMatchObject({ eligible: false, reason: "no_critical_keyword" })
  })
})

describe("announcement challenge matching", () => {
  it("normalizes Unicode, case, and whitespace and prefers the complete title", () => {
    expect(normalizeAnnouncementText("ＣＯＯＫＩＥ   JAR")).toBe("cookie jar")
    const matches = matchAnnouncementChallenges(
      announcement({
        content: "Hint for ＣＯＯＫＩＥ   JAR: inspect SameSite.",
      }),
      challenges,
    )
    expect(matches.map((match) => match.challengeId)).toEqual(["12"])
  })

  it("requires quoting for very short titles and marks duplicate titles", () => {
    expect(
      matchAnnouncementChallenges(
        announcement({ content: "Use RE tooling" }),
        challenges,
      ),
    ).toEqual([])
    expect(
      matchAnnouncementChallenges(
        announcement({ content: "Hint for [RE]" }),
        challenges,
      ).map((match) => match.challengeId),
    ).toEqual(["14"])
    expect(
      matchAnnouncementChallenges(
        announcement({ content: "关于《同名题》的新提示" }),
        challenges,
      ).filter((match) => match.ambiguousTitle),
    ).toHaveLength(2)
  })

  it("matches a challenge ID only as an independent token", () => {
    expect(
      matchAnnouncementChallenges(
        announcement({ content: "challenge (12) has a new hint" }),
        challenges,
      ).map((match) => match.challengeId),
    ).toEqual(["12"])
    expect(
      matchAnnouncementChallenges(
        announcement({ content: "challenge 123 has a new hint" }),
        challenges,
      ),
    ).toEqual([])
  })
})
