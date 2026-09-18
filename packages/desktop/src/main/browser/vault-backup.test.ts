import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteNewFile } from "./atomic-export"

test("backup publication is exclusive and cleans its private temporary file", () => {
  const directory = mkdtempSync(join(tmpdir(), "cm-backup-"))
  const path = join(directory, "passwords.cmbvault")
  try {
    atomicWriteNewFile(path, Buffer.from("complete"))
    expect(readFileSync(path, "utf8")).toBe("complete")
    expect(readdirSync(directory)).toEqual(["passwords.cmbvault"])
    writeFileSync(path, "existing")
    expect(() => atomicWriteNewFile(path, Buffer.from("replacement"))).toThrow()
    expect(readFileSync(path, "utf8")).toBe("existing")
    expect(readdirSync(directory)).toEqual(["passwords.cmbvault"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("interruption before publication leaves no backup or temporary file", () => {
  const directory = mkdtempSync(join(tmpdir(), "cm-backup-"))
  const path = join(directory, "passwords.cmbvault")
  try {
    expect(() =>
      atomicWriteNewFile(path, Buffer.from("complete"), () => {
        throw new Error("synthetic interruption")
      }),
    ).toThrow("synthetic interruption")
    expect(readdirSync(directory)).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
