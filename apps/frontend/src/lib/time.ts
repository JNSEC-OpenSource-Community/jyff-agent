export function relativeTime(value: string | null | undefined): string {
  if (!value) return "暂无"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000)
  const absolute = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })
  if (absolute < 60) return formatter.format(seconds, "second")
  if (absolute < 3_600)
    return formatter.format(Math.round(seconds / 60), "minute")
  if (absolute < 86_400)
    return formatter.format(Math.round(seconds / 3_600), "hour")
  return formatter.format(Math.round(seconds / 86_400), "day")
}

export function absoluteTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  const currentYear = new Date().getFullYear()
  return new Intl.DateTimeFormat("zh-CN", {
    ...(date.getFullYear() === currentYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)
}
