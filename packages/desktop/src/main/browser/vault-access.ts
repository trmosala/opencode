export function createVaultAccess<T>(
  verify: (context: T) => Promise<void>,
  now = () => performance.now(),
  lifetime = 300_000,
) {
  let generation = 0
  let expires = 0
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach((listener) => listener())
  const lock = () => {
    generation++
    expires = 0
    pending = false
    clearTimeout(timer)
    changed()
  }
  const status = () => {
    if (expires && now() >= expires) lock()
    return pending ? ("unlocking" as const) : expires ? ("unlocked" as const) : ("locked" as const)
  }
  return {
    status,
    lock,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    require(ticket?: number) {
      if (status() !== "unlocked" || (ticket !== undefined && ticket !== generation))
        throw new Error("Vault is locked or access expired")
      return generation
    },
    remaining() {
      return status() === "unlocked" ? Math.max(0, expires - now()) : 0
    },
    async unlock(context: T) {
      if (status() === "unlocked") return
      if (pending) throw new Error("Vault authentication already pending")
      const ticket = generation
      pending = true
      changed()
      try {
        await verify(context)
        if (ticket !== generation) throw new Error("Vault authentication invalidated")
        expires = now() + lifetime
        timer = setTimeout(lock, lifetime)
        timer.unref?.()
      } finally {
        if (ticket === generation) {
          pending = false
          changed()
        }
      }
    },
  }
}
