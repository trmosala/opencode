import { expect, test } from "bun:test"
import { transferRule, validateTransferRule } from "./transfer-policy"

test("defaults ask; site overrides match exact origins including ports", () => {
  expect(transferRule([], "https://example.com").downloads).toBe("ask")
  const rules = [validateTransferRule({ origin: "https://example.com/path", uploads: "block", downloads: "allow" })]
  expect(transferRule(rules, "https://example.com/other").downloads).toBe("allow")
  expect(transferRule(rules, "https://sub.example.com").downloads).toBe("ask")
  expect(transferRule(rules, "https://example.com:8443").uploads).toBe("ask")
  expect(transferRule(rules, "http://example.com").downloads).toBe("ask")
  expect(transferRule(rules, "about:blank").downloads).toBe("block")
})

test("default block, origin normalization and malformed rules", () => {
  expect(transferRule([{ origin: "*", uploads: "block", downloads: "block" }], "https://example.com").uploads).toBe(
    "block",
  )
  expect(validateTransferRule({ origin: "https://EXAMPLE.com:443/a", uploads: "ask", downloads: "ask" }).origin).toBe(
    "https://example.com",
  )
  for (const origin of ["file:///tmp/a", "javascript:alert(1)", "https://user:pass@example.com", "invalid"])
    expect(() => validateTransferRule({ origin, uploads: "ask", downloads: "ask" })).toThrow()
  expect(() => validateTransferRule({ origin: "*", uploads: "allow", downloads: "ask" })).toThrow()
})
