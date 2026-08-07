export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export async function apiRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init)
  const contentType = response.headers.get("content-type") ?? ""
  const data = contentType.includes("application/json")
    ? ((await response.json()) as { error?: string; message?: string })
    : undefined
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error ?? "request_failed",
      data?.message ?? `请求失败（HTTP ${response.status}）`,
    )
  }
  return data as T
}

export function apiMutation<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown = {},
): Promise<T> {
  return apiRequest<T>(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function projectApi(projectId: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`
}
