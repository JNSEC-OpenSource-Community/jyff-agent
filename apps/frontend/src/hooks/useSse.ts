import { useEffect, useRef } from "react"

/**
 * 订阅 SSE 事件流。
 * handlers 的 key 为事件名（"message" 表示默认事件），回调收到解析后的 JSON 数据。
 * 组件卸载或 url 变化时自动断开。
 */
export function useSse(
  url: string,
  handlers: Record<string, (data: unknown) => void>,
): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const source = new EventSource(url)
    for (const [type, handler] of Object.entries(handlersRef.current)) {
      source.addEventListener(type, (event) => {
        try {
          const data = (event as MessageEvent<string>).data
          handler(data ? (JSON.parse(data) as unknown) : undefined)
        } catch {
          // 忽略无法解析的 SSE 帧。
        }
      })
    }
    return () => source.close()
  }, [url])
}
