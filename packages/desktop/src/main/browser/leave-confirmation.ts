export function createLeaveConfirmation(options: { check: () => void; ask: () => Promise<boolean> }) {
  let pending: Promise<boolean> | undefined
  return {
    confirm() {
      if (pending) return pending
      pending = (async () => {
        options.check()
        const leave = await options.ask()
        try {
          options.check()
        } catch {
          return false
        }
        return leave
      })().finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}
