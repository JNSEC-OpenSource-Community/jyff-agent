import type {
  Announcement,
  AnnouncementKind,
  ChallengeSummary,
} from "@ctf-agent/platform"

export interface AnnouncementClassification {
  kind: AnnouncementKind
  ignored: boolean
  reason: string
}

export interface AnnouncementChallengeMatch {
  challengeId: string
  matchType: "title" | "challenge_id"
  matchedValue: string
  ambiguousTitle: boolean
}

const BLOOD_TITLE =
  /(?:一血|二血|三血|首杀|\bFirst\s+Blood\b|\bSecond\s+Blood\b|\bThird\s+Blood\b)/iu
const SOLVE_ACTION = /(?:\bsolved\s+by\b|成功解出|解出了)/iu

export function classifyAnnouncement(
  announcement: Announcement,
): AnnouncementClassification {
  if (announcement.kind === "solve_broadcast") {
    return { kind: "solve_broadcast", ignored: true, reason: "platform_kind" }
  }
  if (
    announcement.rawType &&
    /^(?:FirstBlood|SecondBlood|ThirdBlood)$/i.test(announcement.rawType)
  ) {
    return {
      kind: "solve_broadcast",
      ignored: true,
      reason: "platform_raw_type",
    }
  }
  if (BLOOD_TITLE.test(announcement.title)) {
    return { kind: "solve_broadcast", ignored: true, reason: "blood_title" }
  }
  if (SOLVE_ACTION.test(announcement.content)) {
    return {
      kind: "solve_broadcast",
      ignored: true,
      reason: "structured_solve_action",
    }
  }
  return {
    kind: announcement.kind ?? "unknown",
    ignored: false,
    reason: announcement.kind ? "platform_kind" : "unclassified",
  }
}

export function matchAnnouncementChallenges(
  announcement: Announcement,
  challenges: readonly ChallengeSummary[],
): AnnouncementChallengeMatch[] {
  const haystack = normalizeAnnouncementText(
    `${announcement.title}\n${announcement.content}`,
  )
  const titleCounts = new Map<string, number>()
  for (const challenge of challenges) {
    const title = normalizeAnnouncementText(challenge.title)
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }

  const matches: AnnouncementChallengeMatch[] = []
  const matchedTitles: string[] = []
  const ordered = [...challenges].sort(
    (left, right) =>
      normalizeAnnouncementText(right.title).length -
        normalizeAnnouncementText(left.title).length ||
      left.id.localeCompare(right.id),
  )
  for (const challenge of ordered) {
    const title = normalizeAnnouncementText(challenge.title)
    const id = normalizeAnnouncementText(challenge.id)
    if (
      title &&
      !matchedTitles.some(
        (longer) => longer !== title && longer.includes(title),
      ) &&
      titleMatch(haystack, title)
    ) {
      matchedTitles.push(title)
      matches.push({
        challengeId: challenge.id,
        matchType: "title",
        matchedValue: challenge.title,
        ambiguousTitle: (titleCounts.get(title) ?? 0) > 1,
      })
      continue
    }
    if (id && tokenMatch(haystack, id)) {
      matches.push({
        challengeId: challenge.id,
        matchType: "challenge_id",
        matchedValue: challenge.id,
        ambiguousTitle: false,
      })
    }
  }
  return matches
}

export function normalizeAnnouncementText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim()
}

function titleMatch(haystack: string, title: string): boolean {
  if (title.length < 3) {
    return [
      `"${title}"`,
      `'${title}'`,
      `《${title}》`,
      `「${title}」`,
      `[${title}]`,
      `【${title}】`,
    ].some((quoted) => haystack.includes(quoted))
  }
  return boundaryMatch(haystack, title)
}

function tokenMatch(haystack: string, token: string): boolean {
  return boundaryMatch(haystack, token)
}

function boundaryMatch(haystack: string, needle: string): boolean {
  let offset = haystack.indexOf(needle)
  while (offset >= 0) {
    const before = offset === 0 ? "" : (haystack[offset - 1] ?? "")
    const after = haystack[offset + needle.length] ?? ""
    if (!isTokenCharacter(before) && !isTokenCharacter(after)) return true
    offset = haystack.indexOf(needle, offset + 1)
  }
  return false
}

function isTokenCharacter(value: string): boolean {
  return value !== "" && /[\p{L}\p{N}_]/u.test(value)
}
