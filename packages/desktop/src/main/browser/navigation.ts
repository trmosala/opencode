import type { WebContents } from "electron"

const navigations = new WeakMap<WebContents, { settled: Promise<void> }>()

// Electron's pending loadURL listeners must settle before a replacement installs its own.
export async function navigateBrowser(contents: WebContents, url: string) {
  const previous = navigations.get(contents)
  const completion = Promise.withResolvers<void>()
  const current = { settled: completion.promise }
  navigations.set(contents, current)
  try {
    const stopped = contents.isLoading()
      ? new Promise<void>((resolve) => {
          const finish = () => {
            contents.removeListener("did-stop-loading", finish)
            contents.removeListener("destroyed", finish)
            resolve()
          }
          contents.once("did-stop-loading", finish)
          contents.once("destroyed", finish)
        })
      : undefined
    contents.stop()
    if (previous) await previous.settled
    if (stopped) await stopped
    if (navigations.get(contents) !== current || contents.isDestroyed()) return
    await contents.loadURL(url)
  } finally {
    if (navigations.get(contents) === current) navigations.delete(contents)
    completion.resolve()
  }
}

export function cancelBrowserNavigation(contents: WebContents) {
  navigations.delete(contents)
  if (!contents.isDestroyed()) contents.stop()
}
