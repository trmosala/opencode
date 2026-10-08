import { describe, expect, test } from "bun:test"
import { createSchedulingClient, localDateTime, scheduleInstant, SchedulingError } from "./scheduling"

describe("scheduling client", () => {
  test("uses the selected server credentials and preserves the task body", async () => {
    const requests: Request[] = []
    const client = createSchedulingClient(
      { url: "http://localhost:4096", username: "user", password: "secret" },
      async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ schedules: [], occurrences: [], totalOccurrences: 0 })
      },
    )
    expect(await client.list()).toEqual({ schedules: [], occurrences: [], totalOccurrences: 0 })
    await client.manage({ action: "pause", id: "sch_example" })
    expect(requests.map((request) => request.url)).toEqual([
      "http://localhost:4096/schedule",
      "http://localhost:4096/schedule",
    ])
    expect(requests[0].headers.get("Authorization")).toBe("Basic " + btoa("user:secret"))
    expect(requests[1].method).toBe("POST")
    expect(await requests[1].json()).toEqual({ action: "pause", id: "sch_example" })
  })
  test("distinguishes unavailable scheduling and rejects invalid responses", async () => {
    const unavailable = createSchedulingClient({ url: "http://localhost:4096" }, async () =>
      Response.json({ message: "Desktop required" }, { status: 503 }),
    )
    await expect(unavailable.list()).rejects.toBeInstanceOf(SchedulingError)
    const malformed = createSchedulingClient({ url: "http://localhost:4096" }, async () =>
      Response.json({ schedules: [{}], occurrences: [] }),
    )
    await expect(malformed.list()).rejects.toThrow()
  })
  test("preserves an unchanged schedule anchor including seconds and timezone", () => {
    const original = "2030-10-08T09:00:37.123+02:00"
    expect(scheduleInstant(localDateTime(Date.parse(original)), original)).toBe(original)
    const edited = localDateTime(Date.parse(original) + 3600000)
    expect(Date.parse(scheduleInstant(edited, original))).toBe(new Date(edited).getTime())
    expect(scheduleInstant(edited, original)).not.toBe(original)
  })
})
