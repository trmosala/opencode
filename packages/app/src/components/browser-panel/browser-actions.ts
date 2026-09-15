import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import { createLegacyBlobReference } from "@/utils/draft-store"
import { uuid } from "@/utils/uuid"

type PromptTarget = {
  current: () => Prompt
  cursor: () => number | undefined
  set: (prompt: Prompt, cursor?: number) => void
}
type PromptInput = { capture: () => PromptTarget }

export function appendText(prompt: PromptInput, text: string) {
  const target = prompt.capture()
  const current = target.current()
  const last = current[current.length - 1]
  const prefix = last && "content" in last && last.content.trim() ? "\n\n" : ""
  const content = `${prefix}${text}`
  target.set([...current, { type: "text", content, start: 0, end: content.length }], target.cursor())
}

export function addImage(prompt: PromptInput, part: ImageAttachmentPart) {
  const target = prompt.capture()
  target.set([...target.current(), part], target.cursor())
}

export function imagePart(dataUrl: string): ImageAttachmentPart | undefined {
  if (!dataUrl.startsWith("data:image/png;base64,")) return
  return {
    type: "image",
    id: uuid(),
    filename: `browser-screenshot-${Date.now()}.png`,
    mime: "image/png",
    blob: createLegacyBlobReference(dataUrl),
  }
}
