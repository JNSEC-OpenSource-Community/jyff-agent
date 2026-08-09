import type { CSSProperties } from "react"

export interface AnsiSegment {
  text: string
  style: CSSProperties
}

const NORMAL = [
  "#1f2937",
  "#ef6b73",
  "#65b88a",
  "#d6a85f",
  "#6f8ee8",
  "#b47bd5",
  "#56b6c2",
  "#d8dee9",
]
const BRIGHT = [
  "#667085",
  "#ff858b",
  "#7ad9a5",
  "#efc978",
  "#91a7ff",
  "#d29bf0",
  "#78dce8",
  "#f7f8f8",
]
const ESC = "\u001b"
const SGR_PATTERN = new RegExp(`${ESC}\\[([\\d;:]*)m`, "g")
const OSC_PATTERN = new RegExp(
  `${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)?`,
  "g",
)
const CSI_PATTERN = new RegExp(`${ESC}\\[[\\d:;<=>?]*[ -/]*[@-~]`, "g")
const ESCAPED_ESC_PATTERN = /\\(?:x1b|u001b|033|e)(?=\[|\])/gi
const BARE_CSI_PATTERN = /\[([\d:;<=>?]*[ -/]*[@-~])/g
const BARE_TERMINAL_CONTROL_PATTERN =
  /\[(?:\?\d+[hl]|(?:\d+(?:[;:]\d+)*)?[ABCDEFGHJKSTfm])/g
const C1_CSI = String.fromCharCode(0x9b)
const C1_OSC = String.fromCharCode(0x9d)
function stripControlCharacters(text: string): string {
  return [...text]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      )
    })
    .join("")
}

interface AnsiState {
  color?: string
  backgroundColor?: string
  fontWeight?: CSSProperties["fontWeight"]
  fontStyle?: CSSProperties["fontStyle"]
  opacity?: number
  textDecoration?: string
  inverse?: boolean
}

/** 仅解释终端 SGR 样式，其他 ANSI 控制序列会被安全移除。 */
export function parseAnsi(text: string): AnsiSegment[] {
  const normalized = normalizeAnsi(text)
  const segments: AnsiSegment[] = []
  const state: AnsiState = {}
  SGR_PATTERN.lastIndex = 0
  let offset = 0
  let match = SGR_PATTERN.exec(normalized)
  while (match) {
    pushSegment(segments, normalized.slice(offset, match.index), state)
    applySgr(state, parseCodes(match[1] ?? ""))
    offset = match.index + match[0].length
    match = SGR_PATTERN.exec(normalized)
  }
  pushSegment(segments, normalized.slice(offset), state)
  return segments
}

export function AnsiText({ text }: { text: string }): React.ReactElement {
  return (
    <span>
      {parseAnsi(text).map((segment, index) => (
        <span key={`${index}-${segment.text.length}`} style={segment.style}>
          {segment.text}
        </span>
      ))}
    </span>
  )
}

function pushSegment(
  segments: AnsiSegment[],
  text: string,
  state: AnsiState,
): void {
  const sanitized = stripControlCharacters(
    text
      .replace(OSC_PATTERN, "")
      .replace(CSI_PATTERN, "")
      .replace(/\r(?!\n)/g, "\n"),
  )
  if (!sanitized) return
  const { inverse, ...style } = state
  segments.push({
    text: sanitized,
    style: inverse
      ? {
          ...style,
          color: state.backgroundColor ?? "var(--bg)",
          backgroundColor: state.color ?? "var(--fg)",
        }
      : style,
  })
}

/** 兼容 JSON/日志转义、C1 CSI，以及上游过滤 ESC 后残留的终端序列。 */
function normalizeAnsi(text: string): string {
  let normalized = text
    .replaceAll(C1_CSI, `${ESC}[`)
    .replaceAll(C1_OSC, `${ESC}]`)
    .replace(ESCAPED_ESC_PATTERN, ESC)

  const bareControls = normalized.match(BARE_TERMINAL_CONTROL_PATTERN)
  if (!normalized.includes(ESC) && (bareControls?.length ?? 0) >= 2) {
    normalized = normalized.replace(BARE_CSI_PATTERN, `${ESC}[$1`)
  }
  return normalized
}

function parseCodes(raw: string): number[] {
  if (!raw) return [0]
  return raw
    .replaceAll(":", ";")
    .split(";")
    .map((value) => Number.parseInt(value || "0", 10))
}

function applySgr(state: AnsiState, codes: number[]): void {
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index] ?? 0
    if (code === 0) reset(state)
    else if (code === 1) state.fontWeight = 600
    else if (code === 2) state.opacity = 0.65
    else if (code === 3) state.fontStyle = "italic"
    else if (code === 4) state.textDecoration = "underline"
    else if (code === 7) state.inverse = true
    else if (code === 22) {
      delete state.fontWeight
      delete state.opacity
    } else if (code === 23) delete state.fontStyle
    else if (code === 24) delete state.textDecoration
    else if (code === 27) delete state.inverse
    else if (code >= 30 && code <= 37) state.color = NORMAL[code - 30]
    else if (code >= 90 && code <= 97) state.color = BRIGHT[code - 90]
    else if (code === 39) delete state.color
    else if (code >= 40 && code <= 47) state.backgroundColor = NORMAL[code - 40]
    else if (code >= 100 && code <= 107)
      state.backgroundColor = BRIGHT[code - 100]
    else if (code === 49) delete state.backgroundColor
    else if (code === 38 || code === 48) {
      const parsed = extendedColor(codes, index)
      if (parsed.color) {
        if (code === 38) state.color = parsed.color
        else state.backgroundColor = parsed.color
      }
      index += parsed.consumed
    }
  }
}

function extendedColor(
  codes: number[],
  index: number,
): { color?: string; consumed: number } {
  const mode = codes[index + 1]
  if (mode === 5 && codes[index + 2] !== undefined) {
    return { color: ansi256Color(codes[index + 2] ?? 0), consumed: 2 }
  }
  if (
    mode === 2 &&
    codes[index + 2] !== undefined &&
    codes[index + 3] !== undefined &&
    codes[index + 4] !== undefined
  ) {
    const channels = codes
      .slice(index + 2, index + 5)
      .map((channel) => Math.min(255, Math.max(0, channel)))
    return { color: `rgb(${channels.join(", ")})`, consumed: 4 }
  }
  return { consumed: 0 }
}

function ansi256Color(value: number): string {
  const color = Math.min(255, Math.max(0, value))
  if (color < 8) return NORMAL[color] ?? NORMAL[7] ?? "inherit"
  if (color < 16) return BRIGHT[color - 8] ?? BRIGHT[7] ?? "inherit"
  if (color >= 232) {
    const gray = 8 + (color - 232) * 10
    return `rgb(${gray}, ${gray}, ${gray})`
  }
  const cube = color - 16
  const channel = (part: number) => (part === 0 ? 0 : 55 + part * 40)
  const red = channel(Math.floor(cube / 36))
  const green = channel(Math.floor((cube % 36) / 6))
  const blue = channel(cube % 6)
  return `rgb(${red}, ${green}, ${blue})`
}

function reset(state: AnsiState): void {
  for (const key of Object.keys(state) as Array<keyof AnsiState>) {
    delete state[key]
  }
}
