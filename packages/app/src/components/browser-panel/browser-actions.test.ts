import { expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { addImage, appendText, imagePart } from "./browser-actions"

test("browser context appends text and PNG attachments to the captured prompt", () => {
  let parts: Prompt = [{ type: "text", content: "existing", start: 0, end: 8 }]
  const prompt = {
    capture: () => ({
      current: () => parts,
      cursor: () => 0,
      set: (next: Prompt) => {
        parts = next
      },
    }),
  }
  appendText(prompt, "added")
  expect(parts[1]).toMatchObject({ content: "\n\nadded" })
  const image = imagePart("data:image/png;base64,AAAA")!
  addImage(prompt, image)
  expect(parts[2]).toMatchObject({ type: "image", mime: "image/png" })
  expect(image.filename).toMatch(/^browser-screenshot-\d+\.png$/)
  expect(imagePart("data:image/jpeg;base64,AAAA")).toBeUndefined()
  expect(imagePart("")).toBeUndefined()
})
