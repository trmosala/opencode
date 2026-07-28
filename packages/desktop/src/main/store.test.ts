import { expect, test } from "bun:test"
import { requireStoreName } from "./store-keys"

test("store names cannot escape the user-data directory", () => {
  expect(() => requireStoreName("opencode.workspace.safe.dat")).not.toThrow()
  expect(() => requireStoreName("../opencode.json")).toThrow("Invalid store name")
  expect(() => requireStoreName("C:\\opencode.json")).toThrow("Invalid store name")
})
