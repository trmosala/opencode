import { expect, test } from "bun:test"
import { chooseIconName } from "./file-icon"
import { icons, paths } from "./phosphor"

test("Phosphor aliases preserve control meanings and file categories", () => {
  expect(icons["outline-copy"]).toBe(paths.copy)
  expect(icons["terminal-active"]).toBe(paths["terminal-window"])
  expect(icons["circle-ban-sign"]).toBe(paths.prohibit)
  expect(icons["sidebar-right"]).toBe(paths["sidebar-simple"])
  expect(icons["caret-right"]).toBe(paths["caret-right"])
  expect(chooseIconName("C:\\project\\IMAGE.PNG", "file", false)).toBe("file-image")
  expect(chooseIconName("/project/src/app.tsx", "file", false)).toBe("file-ts")
  expect(chooseIconName("/project/report.pdf", "file", false)).toBe("file-pdf")
  expect(chooseIconName("/project/README.md", "file", false)).toBe("file-text")
  expect(chooseIconName("/project/unknown", "file", false)).toBe("file")
  expect(chooseIconName("/project/src", "directory", true)).toBe("folder-open")
  expect(chooseIconName("/project/src", "directory", false)).toBe("folder")
})
