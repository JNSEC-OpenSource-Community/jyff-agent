import { basename } from "node:path"

export const WORKSPACE_PREVIEW_MAX_BYTES = 256 * 1_024

export function workspacePreviewDescriptor(
  path: string,
): { kind: "markdown" | "code" | "text"; language: string } | null {
  const name = basename(path).toLowerCase()
  const extension = name.includes(".") ? (name.split(".").pop() ?? "") : ""
  if (["md", "markdown", "mdown"].includes(extension)) {
    return { kind: "markdown", language: "markdown" }
  }
  const language =
    WORKSPACE_CODE_LANGUAGES[extension] ?? WORKSPACE_FILE_LANGUAGES[name]
  if (language) return { kind: "code", language }
  if (["txt", "log", "csv", "tsv"].includes(extension)) {
    return { kind: "text", language: "text" }
  }
  return null
}

const WORKSPACE_FILE_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
}

const WORKSPACE_CODE_LANGUAGES: Readonly<Record<string, string>> = {
  asm: "x86asm",
  bash: "bash",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cjs: "javascript",
  cmake: "cmake",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cxx: "cpp",
  dart: "dart",
  env: "ini",
  fish: "bash",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  mjs: "javascript",
  php: "php",
  pl: "perl",
  pm: "perl",
  proto: "protobuf",
  ps1: "powershell",
  py: "python",
  pyw: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sol: "csharp",
  sql: "sql",
  svelte: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
}
