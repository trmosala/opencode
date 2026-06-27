// Counting semaphore that bounds how many worker spawns run at once. Split out from
// worker-pool.ts (like worker-slot.ts) so it loads without the Electron runtime and unit-tests
// directly. Leak-free: release() hands the permit straight to the next waiter, otherwise returns
// it to the pool. Waiters are FIFO.

export class SpawnGate {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    this.permits = Math.max(1, max)
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.permits++
  }
}
