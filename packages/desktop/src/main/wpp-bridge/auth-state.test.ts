import { expect, test } from "bun:test"
import { createWppAuthState, readWppAuthResponse } from "./auth-state"

test("background checks preserve confirmed login status until the result changes it", async () => {
  const resolve: { probe?: (value: "signed-in" | "signed-out") => void } = {}
  let calls = 0
  const auth = createWppAuthState(() => {
    calls++
    return new Promise<"signed-in" | "signed-out">((done) => {
      resolve.probe = done
    })
  })
  auth.observe("signed-in")
  const seen: string[] = []
  auth.subscribe((state) => seen.push(state.status))
  void auth.check()
  const pending = auth.check()
  void auth.check()
  await Promise.resolve()
  expect(auth.get().status).toBe("signed-in")
  expect(calls).toBe(1)
  resolve.probe!("signed-in")
  await pending
  expect(seen).toEqual(["signed-in", "signed-in"])

  const logout = auth.check()
  await Promise.resolve()
  expect(auth.get().status).toBe("signed-in")
  resolve.probe!("signed-out")
  await logout
  expect(auth.get().status).toBe("signed-out")
})

test("checks only on demand, coalesces requests, and publishes state without credentials", async () => {
  const resolve: { probe?: (value: "signed-in") => void } = {}
  let calls = 0
  const auth = createWppAuthState(() => {
    calls++
    return new Promise<"signed-in">((done) => {
      resolve.probe = done
    })
  })
  const seen: string[] = []
  const unsubscribe = auth.subscribe((state) => seen.push(state.status))
  expect(calls).toBe(0)
  const first = auth.check()
  expect(auth.check()).toBe(first)
  await Promise.resolve()
  expect(calls).toBe(1)
  resolve.probe!("signed-in")
  await first
  auth.setLoginVisible(true)
  expect(auth.get()).toEqual({ status: "signed-in", checkedAt: expect.any(Number), loginVisible: true })
  expect(seen).toEqual(["unknown", "checking", "signed-in", "signed-in"])
  unsubscribe()
  auth.observe("signed-out")
  expect(seen).toHaveLength(4)
  expect(calls).toBe(1)
})

test("a late check cannot overwrite a newer authentication failure", async () => {
  const resolve: { probe?: (value: "signed-in") => void } = {}
  const auth = createWppAuthState(
    () =>
      new Promise<"signed-in">((done) => {
        resolve.probe = done
      }),
  )
  const pending = auth.check()
  await Promise.resolve()
  auth.refresh()
  auth.observe("signed-out")
  resolve.probe!("signed-in")
  await pending
  expect(auth.get().status).toBe("signed-out")
})

test("cookie invalidation discards a pending check and performs one fresh check", async () => {
  const resolve: { probe?: (value: "signed-in") => void } = {}
  let calls = 0
  const auth = createWppAuthState(() => {
    calls++
    if (calls === 1)
      return new Promise<"signed-in">((done) => {
        resolve.probe = done
      })
    return Promise.resolve("signed-out")
  })
  const pending = auth.check()
  await Promise.resolve()
  auth.refresh()
  auth.invalidate()
  auth.invalidate()
  resolve.probe!("signed-in")
  await pending
  await auth.check()
  expect(calls).toBe(2)
  expect(auth.get().status).toBe("signed-out")
})

test("cookie additions during a signed-out check refresh without publishing the stale result", async () => {
  const resolve: { probe?: (value: "signed-out") => void } = {}
  let calls = 0
  const auth = createWppAuthState(() => {
    calls++
    if (calls === 1)
      return new Promise<"signed-out">((done) => {
        resolve.probe = done
      })
    return Promise.resolve("signed-in")
  })
  const seen: string[] = []
  auth.subscribe((state) => seen.push(state.status))
  const pending = auth.check()
  await Promise.resolve()
  auth.refresh()
  auth.refresh()
  resolve.probe!("signed-out")
  await pending
  await auth.check()
  expect(calls).toBe(2)
  expect(auth.get().status).toBe("signed-in")
  expect(seen).not.toContain("signed-out")
})

test("successful probes that set cookies stay authoritative without probing again", async () => {
  let calls = 0
  const auth = createWppAuthState(async () => {
    calls++
    auth.refresh()
    return "signed-in"
  })
  expect((await auth.check()).status).toBe("signed-in")
  expect(calls).toBe(1)
})

test("inconclusive probes that set cookies refresh once and leave status unknown", async () => {
  let calls = 0
  const auth = createWppAuthState(async () => {
    calls++
    auth.refresh()
    return "signed-out"
  })
  await auth.check()
  await auth.check()
  expect(calls).toBe(2)
  expect(auth.get().status).toBe("unknown")
})

test("network failure and permission denial are unavailable, not signed out", async () => {
  const auth = createWppAuthState(() => Promise.reject(new Error("offline")))
  expect((await auth.check()).status).toBe("unknown")
  expect(await readWppAuthResponse(new Response(null, { status: 403 }))).toBe("unknown")
  expect(await readWppAuthResponse(new Response(null, { status: 401 }))).toBe("signed-out")
})

test("signed in requires a valid identity response rather than a successful HTML page", async () => {
  for (const value of [{ id: "user-1" }, { email: "user@example.test" }, { user: { id: "user-1" } }]) {
    expect(await readWppAuthResponse(Response.json(value))).toBe("signed-in")
  }
  for (const value of [{}, [], { id: " " }, { error: "not authorized" }]) {
    expect(await readWppAuthResponse(Response.json(value))).toBe("unknown")
  }
  expect(
    await readWppAuthResponse(new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })),
  ).toBe("unknown")
  expect(await readWppAuthResponse(new Response("invalid", { headers: { "content-type": "application/json" } }))).toBe(
    "unknown",
  )
})
