import { describe, expect, test } from "bun:test"
import { StreamGate } from "./streamGate.mjs"

describe("StreamGate sentence quarantine", () => {
  test("streams a completed sentence only after the next sentence begins", () => {
    const gate = new StreamGate({ sentenceQuarantine: true })

    expect(gate.update("I am checking the workspace.").delta).toBe("")
    expect(gate.update("I am checking the workspace. The diff").delta).toBe("I am checking the workspace. ")
    expect(gate.update("I am checking the workspace. The diff is ready. Summary").delta).toBe("The diff is ready. ")
    expect(gate.trailingDiff("I am checking the workspace. The diff is ready. Summary follows.")).toBe("Summary follows.")
  })


  test("continues to suppress a raw tool call after streamed commentary", () => {
    const gate = new StreamGate({ sentenceQuarantine: true })
    const text = "I will inspect the tree.\n<function_calls><invoke name=\"bash\">"

    expect(gate.update(text).delta).toBe("I will inspect the tree.\n")
    expect(gate.state).toBe("suppressed")
  })
})
