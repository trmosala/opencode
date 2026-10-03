export function createLeaveConfirmation(options: {
  check: () => void
  ask: (signal: AbortSignal) => Promise<boolean>
  signal?: AbortSignal
  deadline?: number
}) {
  let pending: Promise<boolean> | undefined
  return {
    confirm() {
      if (pending) return pending
      pending = (async () => {
        const controller = new AbortController()
        const cancel = () => controller.abort()
        const check = () => {
          try {
            options.check()
          } catch {
            cancel()
          }
        }
        options.signal?.addEventListener("abort", cancel, { once: true })
        const timer =
          options.deadline === undefined ? undefined : setTimeout(cancel, Math.max(0, options.deadline - Date.now()))
        // Some authorities are closures without an observable signal, such as task/document revisions.
        const monitor = setInterval(check, 100)
        monitor.unref()
        try {
          check()
          if (options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) cancel()
          if (controller.signal.aborted) return false
          // Abort dismisses the native dialog; retain the lease until that dialog actually settles.
          const leave = await options.ask(controller.signal)
          options.check()
          return (
            leave && !controller.signal.aborted && (options.deadline === undefined || Date.now() < options.deadline)
          )
        } catch {
          return false
        } finally {
          clearTimeout(timer)
          clearInterval(monitor)
          options.signal?.removeEventListener("abort", cancel)
        }
      })().finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}
