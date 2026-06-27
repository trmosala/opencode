import { describe, expect, test } from "bun:test"
import { SpawnGate } from "./spawn-gate"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("SpawnGate", () => {
  test("never lets more than `max` tasks run concurrently", async () => {
    const gate = new SpawnGate(3)
    let running = 0
    let peak = 0

    const task = async () => {
      await gate.acquire()
      try {
        running++
        peak = Math.max(peak, running)
        await tick()
      } finally {
        running--
        gate.release()
      }
    }

    await Promise.all(Array.from({ length: 12 }, task))
    expect(peak).toBe(3)
  })

  test("wakes waiters FIFO as permits release", async () => {
    const gate = new SpawnGate(1)
    const order: number[] = []
    await gate.acquire() // hold the only permit

    const waiters = [1, 2, 3].map(async (n) => {
      await gate.acquire()
      order.push(n)
      gate.release()
    })

    await tick()
    gate.release() // releasing the held permit starts the chain
    await Promise.all(waiters)
    expect(order).toEqual([1, 2, 3])
  })

  test("release with no waiters returns the permit so the next acquire is immediate", async () => {
    const gate = new SpawnGate(1)
    await gate.acquire()
    gate.release()

    let acquired = false
    await gate.acquire().then(() => {
      acquired = true
    })
    expect(acquired).toBe(true)
  })

  test("clamps a non-positive max up to 1", async () => {
    const gate = new SpawnGate(0)
    let acquired = false
    await gate.acquire().then(() => {
      acquired = true
    })
    expect(acquired).toBe(true)
  })
})
