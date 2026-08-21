export interface ProcessShutdownLogger {
  log(message: string): void
  error(message: string, cause?: unknown): void
}

export interface ProcessShutdownOptions {
  close(reason: string): Promise<void>
  logger?: ProcessShutdownLogger
  exit?: (code: number) => void
}

export interface ProcessShutdown {
  shutdown(reason: string): Promise<void>
  fatal(reason: string, cause: unknown): void
}

/**
 * 串行化进程关闭：所有信号和致命错误共享同一次资源回收；致命错误只在回收结束后退出。
 * SIGKILL/OOM 无法运行 JavaScript，遗留资源由下次启动时的 Project/Father 恢复清理兜底。
 */
export function createProcessShutdown(options: ProcessShutdownOptions): ProcessShutdown {
  const logger = options.logger ?? console
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let closing: Promise<void> | undefined
  let fatalExitScheduled = false

  const shutdown = (reason: string): Promise<void> => {
    if (closing) return closing
    logger.log(`收到 ${reason}，正在正常停止 Agent 并回收运行环境…`)
    closing = options.close(reason)
    return closing
  }

  const fatal = (reason: string, cause: unknown): void => {
    logger.error(`进程发生致命错误（${reason}）`, cause)
    if (fatalExitScheduled) return
    fatalExitScheduled = true
    void shutdown(reason)
      .catch((cleanupError: unknown) => {
        logger.error("Agent 进程退出前的资源回收不完整", cleanupError)
      })
      .finally(() => exit(1))
  }

  return { shutdown, fatal }
}
