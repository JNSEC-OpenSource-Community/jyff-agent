import { Component, type ErrorInfo, type ReactNode } from "react"

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("WebUI 渲染异常", error, errorInfo)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <main className="flex min-h-full items-center justify-center p-6">
        <section className="surface w-full max-w-md p-6" role="alert">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            页面异常
          </p>
          <h1 className="mt-2 text-lg font-semibold tracking-tight">无法显示当前页面</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            请刷新页面后重试；若问题持续出现，请将发生时间和操作步骤反馈给管理员。
          </p>
          <button
            type="button"
            className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => globalThis.location.reload()}
          >
            刷新页面
          </button>
        </section>
      </main>
    )
  }
}
