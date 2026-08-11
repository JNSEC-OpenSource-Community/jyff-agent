import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import c from "highlight.js/lib/languages/c"
import cmake from "highlight.js/lib/languages/cmake"
import cpp from "highlight.js/lib/languages/cpp"
import csharp from "highlight.js/lib/languages/csharp"
import css from "highlight.js/lib/languages/css"
import dart from "highlight.js/lib/languages/dart"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import go from "highlight.js/lib/languages/go"
import graphql from "highlight.js/lib/languages/graphql"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import kotlin from "highlight.js/lib/languages/kotlin"
import less from "highlight.js/lib/languages/less"
import lua from "highlight.js/lib/languages/lua"
import makefile from "highlight.js/lib/languages/makefile"
import perl from "highlight.js/lib/languages/perl"
import php from "highlight.js/lib/languages/php"
import powershell from "highlight.js/lib/languages/powershell"
import protobuf from "highlight.js/lib/languages/protobuf"
import python from "highlight.js/lib/languages/python"
import r from "highlight.js/lib/languages/r"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import scss from "highlight.js/lib/languages/scss"
import sql from "highlight.js/lib/languages/sql"
import swift from "highlight.js/lib/languages/swift"
import typescript from "highlight.js/lib/languages/typescript"
import x86asm from "highlight.js/lib/languages/x86asm"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

const languages = {
  bash,
  c,
  cpp,
  csharp,
  cmake,
  css,
  dart,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  perl,
  php,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  x86asm,
  xml,
  yaml,
}

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language)
}

export function SyntaxHighlightedCode({ code, language }: { code: string; language?: string }) {
  const normalized = normalizeLanguage(language)
  const highlighted = normalized
    ? hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
    : hljs.highlightAuto(code).value
  return (
    <code
      className={`hljs${normalized ? ` language-${normalized}` : ""}`}
      // highlight.js 会先转义源代码，再生成受控 span 标记。
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  )
}

function normalizeLanguage(language?: string): string | undefined {
  if (!language) return undefined
  const aliases: Record<string, string> = {
    cxx: "cpp",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
  }
  const normalized = aliases[language.toLowerCase()] ?? language.toLowerCase()
  return hljs.getLanguage(normalized) ? normalized : undefined
}
