import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ReactNode } from "react"
import { cn } from "../../lib/utils.ts"
import { SyntaxHighlightedCode } from "./SyntaxHighlightedCode.tsx"

function safeUrlTransform(url: string): string {
  const normalized = defaultUrlTransform(url)
  if (!normalized) return ""
  if (/^(?:https?:|mailto:)/i.test(normalized)) return normalized
  if (/^(?:[./#?]|$)/.test(normalized)) return normalized
  return ""
}

function markdownText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(markdownText).join("")
  return ""
}

/** 渲染 Agent 生成的 Markdown；忽略原始 HTML 并限制可点击 URL 协议。 */
export function MarkdownContent({
  children,
  className,
}: {
  children: string
  className?: string
}): React.ReactElement {
  return (
    <div
      className={cn(
        "min-w-0 max-w-full break-words text-sm leading-7 text-foreground/90 [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrlTransform}
        components={{
          h1: ({ children }) => <h1 className="mt-6 mb-3 text-xl font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-5 mb-2 text-lg font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-2!">{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noopener noreferrer nofollow" : undefined}
              className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-primary/40 pl-4 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ className: codeClassName, children }) => {
            const language = /(?:^|\s)language-([\w-]+)/.exec(codeClassName ?? "")?.[1]
            return codeClassName ? (
              <SyntaxHighlightedCode
                code={markdownText(children).replace(/\n$/, "")}
                language={language}
              />
            ) : (
              <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-primary">
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="my-3 max-w-full overflow-x-auto rounded-lg border border-border bg-background/70 p-4 font-mono text-xs leading-6">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-muted px-3 py-2 font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/70 px-3 py-2 align-top">{children}</td>
          ),
          img: ({ alt }) => (
            <span className="text-muted-foreground">[图片：{alt || "未命名"}]</span>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export { safeUrlTransform }
