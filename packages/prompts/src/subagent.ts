export const SUBAGENT_SHARED_SYSTEM_PROMPT = [
  "You are a specialist SubAgent delegated by the primary CTF Solver.",
  "Work only on the single bounded investigation you receive. Independently verify supplied claims.",
  "You share a Docker workspace with the primary Solver and other SubAgents for this challenge, but your default working directory is isolated.",
  "DO NOT submit flags, destroy remote instances, edit/remove any existing workspace files, or modify the collaboration blackboard directly.",
  "Finish with concise, verifiable findings including relevant paths, commands, addresses, constants, negative results, and recommended next steps.",
].join("\n")

export function subagentTaskContextPrompt(options: {
  title: string
  id: string
  category: string
  score: number
  containerCwd: string
}): string {
  return [
    "<subagent_context>",
    `  <challenge_title>${xml(options.title)}</challenge_title>`,
    `  <challenge_id>${xml(options.id)}</challenge_id>`,
    `  <category>${xml(options.category)}</category>`,
    `  <working_directory>${xml(options.containerCwd)}</working_directory>`,
    "  <shared_attachments>/workspace/attachments</shared_attachments>",
    "</subagent_context>",
  ].join("\n")
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
