export function xml(value: string): string {
  let sanitized = ""
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    sanitized += code < 32 && code !== 9 && code !== 10 && code !== 13 ? "�" : character
  }
  return sanitized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
