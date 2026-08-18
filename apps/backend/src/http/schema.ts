import { parseProjectConfig } from "@ctf-agent/core"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "./context.ts"
import { errorText, HttpError } from "./errors.ts"

/** 思考强度档位全集（与 pi ThinkingLevel 一致，不含 off——off 由 thinkingEnabled 表达）。 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

export const projectArchiveSchema = z.object({ archived: z.boolean() })

/** 独立审计项目必须引用已由上传端点保存的归档，不接受服务端任意路径。 */
export const codeAuditCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    archiveName: z.string().trim().min(1).max(255),
    archiveSize: z
      .number()
      .int()
      .min(1)
      .max(250 * 1024 * 1024),
    archivePath: z.string().trim().min(1).max(2_048),
  })
  .strict()

export const builtInPluginStateSchema = z.object({ enabled: z.boolean() })

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

const httpUrl = (value: string) => {
  if (!value) return true
  try {
    const parsed = new URL(value)
    return ["http:", "https:"].includes(parsed.protocol)
  } catch {
    return false
  }
}

/** 模型池单条目的完整校验（与旧版 requiredString/requiredPositiveInteger 语义一致）。 */
export const modelPoolEntrySchema = z.object({
  id: z
    .string({ message: "Models[?] ID 必须是字符串" })
    .trim()
    .min(1, { message: "模型配置 ID 不能为空" })
    .max(512, { message: "模型配置 ID 长度不能超过 512" })
    .refine((value) => !hasControlCharacter(value), {
      message: "模型配置 ID 不能包含控制字符",
    }),
  provider: z
    .string({ message: "Provider 必须是字符串" })
    .trim()
    .min(1, { message: "Provider 不能为空" })
    .max(128, { message: "Provider 长度不能超过 128" })
    .regex(ID_PATTERN, {
      message: "Provider 只能包含字母、数字、点、下划线和连字符",
    }),
  modelId: z
    .string({ message: "Model ID 必须是字符串" })
    .trim()
    .min(1, { message: "Model ID 不能为空" })
    .max(256, { message: "Model ID 长度不能超过 256" })
    .refine((value) => !hasControlCharacter(value), {
      message: "Model ID 不能包含控制字符",
    }),
  contextWindow: z.number({ message: "Context Window 必须是整数" }).int().min(1).max(2_000_000),
  thinkingEnabled: z.boolean(),
  passthroughThinking: z.boolean(),
  reasoningEffort: z.enum([...THINKING_LEVELS, "off"], {
    message: `Reasoning Effort 必须是 ${[...THINKING_LEVELS, "off"].join("/")} 之一`,
  }),
})

export interface ModelPoolEntryOutput {
  id: string
  provider: string
  modelId: string
  contextWindow: number
  thinkingEnabled: boolean
  passthroughThinking: boolean
  reasoningEffort: string
}

const endpointUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(httpUrl, { message: "请求 Endpoint 不是有效 URL" })
  .refine(
    (value) => {
      const parsed = new URL(value)
      return !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    },
    { message: "请求 Endpoint 不能包含凭据、查询参数或片段" },
  )
  .transform((value) => value.replace(/\/+$/, ""))

export const customModelProviderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  baseUrl: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .refine(httpUrl, { message: "Base URL 不是有效 URL" })
    .transform((value) => value.replace(/\/+$/, "")),
  endpointUrl: endpointUrl.optional(),
  apiKey: z.string().trim().min(1).max(8_192),
})

export const customModelProviderEditSchema = customModelProviderSchema.extend({
  apiKey: z.string().trim().min(1).max(8_192).optional(),
})

const optionalBinding = (label: string) =>
  z
    .string({ message: `${label} 必须是字符串` })
    .trim()
    .max(512, { message: `${label} 长度不能超过 512` })

/** 全局模型池更新：条目级校验 + 跨条目引用/一致性校验。 */
export const modelConfigurationUpdateSchema = z
  .object({
    models: z
      .array(modelPoolEntrySchema, {
        message: "Models 必须是数组",
      })
      .max(64, { message: "Models 必须是最多包含 64 项的数组" }),
    solverModelId: optionalBinding("Solver Model"),
    tldrModelId: optionalBinding("TLDR Model"),
    fatherModelId: optionalBinding("Father Model").optional(),
    subagentModels: z
      .record(z.string(), z.string(), { message: "SubAgent Models 必须是对象" })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const { models, solverModelId, tldrModelId, fatherModelId, subagentModels = {} } = value
    const ids = new Set(models.map((model) => model.id))
    const issue = (message: string) => ctx.addIssue({ code: "custom", message })

    if (ids.size !== models.length) issue("模型配置 ID 不能重复")
    if (models.length === 0) {
      if (solverModelId || tldrModelId || fatherModelId || Object.keys(subagentModels).length > 0) {
        issue("空模型池不能包含 Agent 模型绑定")
      }
      return
    }
    if (solverModelId && !ids.has(solverModelId)) issue(`Solver 模型不存在: ${solverModelId}`)
    if (tldrModelId && !ids.has(tldrModelId)) issue(`TLDR 模型不存在: ${tldrModelId}`)
    if (fatherModelId && !ids.has(fatherModelId)) issue(`Father 模型不存在: ${fatherModelId}`)
    for (const [role, modelId] of Object.entries(subagentModels)) {
      if (!ids.has(modelId)) issue(`SubAgent ${role} 的模型不存在: ${modelId}`)
    }
    const references = new Set<string>()
    for (const model of models) {
      const reference = `${model.provider}/${model.modelId}`
      if (references.has(reference)) issue(`模型不能重复: ${reference}`)
      references.add(reference)
    }
  })
  .transform((value) => ({
    ...value,
    subagentModels: value.subagentModels ?? {},
  }))

export interface ModelConfigurationUpdateOutput {
  models: ModelPoolEntryOutput[]
  solverModelId: string
  tldrModelId: string
  fatherModelId?: string
  subagentModels: Record<string, string>
}

const subagentModelsSchema = z
  .record(
    z.string(),
    z
      .string({ message: "SubAgent Model 必须是字符串" })
      .trim()
      .min(1, { message: "SubAgent Model 不能为空" })
      .max(512, { message: "SubAgent Model 长度不能超过 512" }),
    { message: "SubAgent Models 必须是对象" },
  )
  .optional()

/** Project 运行配置更新。 */
export const projectRuntimeConfigurationSchema = z
  .object({
    solverModelId: optionalBinding("Solver Model"),
    tldrModelId: optionalBinding("TLDR Model"),
    subagentModels: subagentModelsSchema,
    maxConcurrent: z.number({ message: "调度并发量必须是整数" }).int().min(1).max(64),
    maxRemoteEnvironments: z.number({ message: "远程环境并发量必须是整数" }).int().min(1).max(64),
  })
  .transform((value) => ({
    ...value,
    subagentModels: value.subagentModels ?? {},
  }))

/** 调度并发量。 */
export const schedulerConcurrencySchema = z.object({
  maxConcurrent: z.number({ message: "调度并发量必须是整数" }).int().min(1).max(64),
})

/** 队列重排（position/expectedVersion 需要各自独立的错误码）。 */
export const queueMoveSchema = z.object({
  position: z.number({ message: "队列位置必须是整数" }).int().min(1),
  expectedVersion: z.number({ message: "队列版本必须是整数" }).int().min(1),
  overrideBlockedLane: z.boolean().optional(),
})

/** 人工派发/取消。 */
export const dispatchSchema = z.object({ force: z.boolean().optional() })

export const challengeSchedulingSchema = z.object({
  disposition: z.enum(["default", "excluded", "solved"]),
})

export const fatherSessionCreateSchema = z.object({
  parentSessionId: z.string().trim().min(1).max(128).optional(),
})

export const fatherMessageSchema = z.object({
  message: z.string().trim().min(1).max(32_000),
})

export const fatherValidationSchema = z.object({
  schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  config: z.unknown(),
  secrets: z.record(z.string(), z.string().max(8_192).optional()).optional(),
  expected: z
    .object({
      contestId: z.string().max(256).optional(),
      contestName: z.string().max(256).optional(),
      challengeId: z.string().max(256).optional(),
      attachmentChallengeId: z.string().max(256).optional(),
      environmentChallengeId: z.string().max(256).optional(),
    })
    .optional(),
  mutations: z
    .object({
      invalidFlag: z.string().max(2_048).optional(),
      testEnvironmentLifecycle: z.boolean().optional(),
    })
    .optional(),
})

/** 向活跃 Solver 发送人工消息。 */
export const challengeMessageSchema = z.object({
  text: z
    .string({ message: "Text 必须是字符串" })
    .trim()
    .min(1, { message: "Text 不能为空" })
    .max(4_000, { message: "Text 长度不能超过 4000" }),
})

/** 切换思考强度。 */
export const thinkingLevelSchema = z.object({
  level: z
    .string({ message: "Level 必须是字符串" })
    .trim()
    .min(1, { message: "Level 不能为空" })
    .max(32, { message: "Level 长度不能超过 32" })
    .refine(
      (value) =>
        THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number]) || value === "off",
      {
        message: `思考强度必须是 ${[...THINKING_LEVELS, "off"].join("/")} 之一`,
      },
    ),
})

/** 审计 follow-up：会创建一轮新的隔离运行，并在扫描后执行该提示词。 */
export const auditFollowUpSchema = z.object({
  prompt: z
    .string({ message: "Prompt 必须是字符串" })
    .trim()
    .min(1, { message: "Prompt 不能为空" })
    .max(32_000, { message: "Prompt 长度不能超过 32000" }),
})

/** Run 重试（可选人工继续提示词）。 */
export const retryAttemptSchema = z.object({
  prompt: z
    .string({ message: "Prompt 必须是字符串" })
    .trim()
    .max(32_000, { message: "Prompt 长度不能超过 32000" })
    .optional(),
})

/** SubAgent steer。 */
export const subagentMessageSchema = z.object({
  message: z
    .string({ message: "Message 必须是字符串" })
    .trim()
    .min(1, { message: "Message 不能为空" })
    .max(4_000, { message: "Message 长度不能超过 4000" }),
})

/** 公告审核。 */
export const announcementReviewSchema = z.object({
  challengeId: z.string().trim().min(1).max(512),
  announcementKey: z.string().trim().min(1).max(512),
  status: z.enum(["approved", "rejected"]),
})

/** WebUI 登录。 */
export const webUiLoginSchema = z.object({
  username: z
    .string({ message: "用户名必须是字符串" })
    .trim()
    .min(1, { message: "用户名不能为空" })
    .max(128, { message: "用户名长度不能超过 128" }),
  password: z
    .string({ message: "密码必须是字符串" })
    .min(1, { message: "密码不能为空" })
    .max(1_024, { message: "密码长度不能超过 1024" }),
})

/** 平台连接配置（ProjectConfig + 命名空间凭据）。 */
export const projectSetupSchema = z.object({
  config: z
    .unknown()
    .refine((value) => typeof value === "object" && value !== null && !Array.isArray(value), {
      message: "config 必须是对象",
    }),
  secrets: z.record(z.string(), z.string(), { message: "secrets 必须是字符串键值对象" }).optional(),
})

export interface ProjectSetupInput {
  config: import("@ctf-agent/core").ProjectConfig
  secrets?: Readonly<Record<string, string | undefined>>
}

/** 解析平台连接配置：ProjectConfig 解析失败 → 400 invalid_project_config。 */
export function parseProjectSetup(body: Record<string, unknown>): ProjectSetupInput {
  let config: import("@ctf-agent/core").ProjectConfig
  try {
    config = parseProjectConfig(body.config)
  } catch (error) {
    throw new HttpError(400, "invalid_project_config", errorText(error))
  }
  if (body.secrets === undefined) return { config }
  if (typeof body.secrets !== "object" || body.secrets === null || Array.isArray(body.secrets)) {
    throw new HttpError(400, "invalid_secrets", "secrets 必须是字符串键值对象")
  }
  const secrets: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(body.secrets)) {
    if (typeof value !== "string") {
      throw new HttpError(400, "invalid_secrets", `密钥 ${name} 必须是字符串`)
    }
    secrets[name] = value.length > 0 ? value : undefined
  }
  return { config, secrets }
}

/** WebUI 鉴权配置。 */
export const webUiAuthenticationSchema = z
  .object({
    enabled: z.boolean({ message: "enabled 必须是布尔值" }),
    username: optionalBinding("用户名").optional(),
    password: z
      .string({ message: "密码必须是字符串" })
      .max(1_024, { message: "密码长度不能超过 1024" })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !value.username) {
      ctx.addIssue({ code: "custom", message: "用户名不能为空" })
    }
  })

/** 模型凭据登录启动。 */
export const modelLoginSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  method: z.string().trim().min(1).max(128),
  secret: z.string().trim().max(16_384).optional(),
})

/** 交互式登录提交。 */
export const modelPromptSchema = z.object({
  value: z.string().trim().min(1).max(16_384),
})

/** web-access 插件全局配置。 */
export const webAccessConfigurationSchema = z
  .object({
    enabled: z.boolean({ message: "enabled 必须是布尔值" }).optional(),
    providers: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    workflow: z.enum(["none", "auto-summary"]).optional(),
    summaryModel: z
      .object({
        provider: z.string().trim().min(1).max(128),
        id: z.string().trim().min(1).max(256),
      })
      .nullable()
      .optional(),
    ssrf: z
      .object({
        allowRanges: z.array(z.string().trim().min(1).max(256)).optional(),
        trustEnvProxy: z.boolean().optional(),
      })
      .optional(),
    providerConfig: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  })
  .strict()

/** web-access 某 provider 的密钥写入。 */
export const webAccessKeySchema = z
  .object({
    apiKey: z.string().trim().max(16_384).nullable().optional(),
  })
  .strict()

/** auth.json 导入。 */
export const modelImportSchema = z.object({
  json: z.string().trim().min(1).max(250_000),
})

/** 校验失败 → HttpError(400, code, 首条错误信息)；perFieldCodes 按字段路径映射错误码。 */
export function parseSchema<T>(
  schema: z.ZodType<T>,
  body: unknown,
  code: string,
  perFieldCodes?: Record<string, string>,
): T {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const first = result.error.issues[0]
  const path = first?.path[0]
  const fieldCode = typeof path === "string" ? perFieldCodes?.[path] : undefined
  throw new HttpError(400, fieldCode ?? code, first?.message ?? "请求体校验失败")
}

/** 要求 JSON Content-Type。 */
export function requireJson(c: Context<AppEnv>): void {
  const contentType = c.req.header("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "控制操作必须使用 application/json")
  }
}

/** 读取 JSON 请求体（带大小上限，超限 413）。 */
export async function readJsonBody(
  c: Context<AppEnv>,
  maximumSize = 16_384,
): Promise<Record<string, unknown>> {
  requireJson(c)
  const declaredLength = Number(c.req.header("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maximumSize) {
    throw new HttpError(413, "payload_too_large", "请求体过大")
  }
  const buffer = Buffer.from(await c.req.raw.arrayBuffer())
  if (buffer.byteLength > maximumSize) {
    throw new HttpError(413, "payload_too_large", "请求体过大")
  }
  if (buffer.byteLength === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(buffer.toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是有效 JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "请求体必须是 JSON 对象")
  }
  return parsed as Record<string, unknown>
}

/** 读取并校验 JSON 请求体。 */
export async function parseJsonBody<T>(
  c: Context<AppEnv>,
  schema: z.ZodType<T>,
  options: {
    code: string
    maximumSize?: number
    perFieldCodes?: Record<string, string>
  },
): Promise<T> {
  const body = await readJsonBody(c, options.maximumSize)
  return parseSchema(schema, body, options.code, options.perFieldCodes)
}

/** URL 路径参数解码（hono 已解码，这里防御非法编码）。 */
export function decodedParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) {
    throw new HttpError(400, `invalid_${name}`, `${name} 不能为空`)
  }
  return value
}
