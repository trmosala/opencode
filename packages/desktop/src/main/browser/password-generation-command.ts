import { randomUUID } from "node:crypto"
import type { MessageBoxOptions, MessageBoxReturnValue, WebContents } from "electron"
import { nativeT } from "../native-translations"
import { loginOrigin } from "./import-data"
import { loginOfferExclusions } from "./login-offers"
import { browserPreferencesState } from "./preferences"
import { readLogins } from "./vault"
import { vaultAccess } from "./vault-session"
import {
  passwordOptions,
  generatePassword,
  prepareGenerationScript,
  completeGenerationScript,
  clearGenerationScript,
} from "./password-generation"

// Main owns tab authority and layout; the workflow owns consent, secret delivery and cleanup.
type GenerationTarget = {
  contents: WebContents
  begin(
    validate: () => void,
    revoke: () => void,
  ): {
    check(attached?: boolean): void
    readyLoginOffers(check: () => void): Promise<number>
    unwatch(): void
    release(): void
  }
  showDialog(options: MessageBoxOptions, check?: () => void): Promise<MessageBoxReturnValue>
  canShowFeedback(): boolean
}

export async function generateBrowserPassword(
  command: { length?: unknown; symbols?: unknown },
  target: GenerationTarget,
) {
  const contents = target.contents
  // Recovery copy is selected in main, never derived from execution errors.
  let detail = nativeT("desktop.browser.generation.settings")
  try {
    const options = passwordOptions(command)
    detail = nativeT("desktop.browser.generation.failed")
    if (
      !browserPreferencesState().offerSaveLogins ||
      loginOfferExclusions().includes(new URL(contents.getURL()).origin)
    ) {
      detail = nativeT("desktop.browser.generation.offers")
      throw new Error()
    }
    const ticket = vaultAccess.require()
    const origin = loginOrigin(contents.getURL())
    const consent = new AbortController()
    const expires = Date.now() + Math.min(120_000, vaultAccess.remaining())
    const validate = () => {
      vaultAccess.require(ticket)
      if (
        consent.signal.aborted ||
        Date.now() >= expires ||
        loginOrigin(contents.getURL()) !== origin ||
        !browserPreferencesState().offerSaveLogins ||
        loginOfferExclusions().includes(origin)
      )
        throw new Error("Generation revoked")
    }
    const revoke = () => consent.abort()
    const lease = target.begin(validate, revoke)
    const check = (attached = false) => lease.check(attached)
    const token = randomUUID()
    const unsubscribe = vaultAccess.subscribe(revoke)
    const timer = setTimeout(revoke, Math.max(0, expires - Date.now()))
    contents.on("did-start-navigation", revoke)
    try {
      const constraints = await contents.executeJavaScriptInIsolatedWorld(999, [
        { code: prepareGenerationScript(origin, token, expires) },
      ])
      check(true)
      if (
        !constraints ||
        typeof constraints !== "object" ||
        typeof constraints.min !== "number" ||
        typeof constraints.max !== "number" ||
        !Number.isInteger(constraints.min) ||
        !Number.isInteger(constraints.max) ||
        constraints.min < 16 ||
        constraints.max > 64 ||
        constraints.min > constraints.max ||
        typeof constraints.hasUsername !== "boolean"
      )
        throw new Error("Invalid constraints")
      if (options.length < constraints.min || options.length > constraints.max) {
        detail = nativeT("desktop.browser.generation.length", {
          length: options.length,
          min: constraints.min,
          max: constraints.max,
        })
        throw new Error()
      }
      passwordOptions(options, constraints.min, constraints.max)
      if (!constraints.hasUsername) {
        const accounts = readLogins().filter((row) => row.origin === origin)
        if (
          !accounts.length ||
          accounts.length > 5 ||
          new Set(accounts.map((row) => row.username)).size !== accounts.length ||
          accounts.some(
            (row) => !row.username.trim() || row.username.length > 80 || /[\p{Cc}\p{Cf}]/u.test(row.username),
          )
        )
          throw new Error("No usable saved account")
      }
      const answer = await target.showDialog(
        {
          type: "question",
          message: nativeT("desktop.browser.generation.title"),
          detail: nativeT("desktop.browser.generation.detail", {
            origin,
            length: options.length,
            min: constraints.min,
            max: constraints.max,
            characters: nativeT(
              options.symbols ? "desktop.browser.generation.symbols" : "desktop.browser.generation.alphanumeric",
            ),
          }),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.generation.fill")],
          defaultId: 0,
          cancelId: 0,
          signal: consent.signal,
        },
        () => check(),
      )
      if (answer.response === 1) {
        check(true)
        const captureUntil = await lease.readyLoginOffers(() => check(true))
        check(true)
        // Arm before fields become submittable; never outlive the acknowledged capture grant.
        // Dispatched code still cannot be recalled. No generated-secret cache is retained.
        await contents.executeJavaScriptInIsolatedWorld(999, [
          {
            code: completeGenerationScript(
              origin,
              token,
              generatePassword(options),
              Math.min(expires, captureUntil, Date.now() + Math.min(5000, vaultAccess.remaining())),
            ),
          },
        ])
        check(true)
      }
    } finally {
      clearTimeout(timer)
      unsubscribe()
      contents.removeListener("did-start-navigation", revoke)
      lease.unwatch()
      try {
        if (!contents.isDestroyed())
          await contents.executeJavaScriptInIsolatedWorld(999, [{ code: clearGenerationScript(token) }])
      } catch {
        // A departed document already discarded its ticket.
      } finally {
        lease.release()
      }
    }
  } catch {
    // Cleanup has finished. A handled failure returns state, avoiding a second generic app toast.
    try {
      if (!target.canShowFeedback()) throw new Error()
      await target.showDialog({
        type: "warning",
        message: nativeT("desktop.browser.operationUnavailable"),
        detail,
        buttons: [nativeT("desktop.browser.cancel")],
        defaultId: 0,
        cancelId: 0,
      })
    } catch {
      // Never forward page exceptions, secrets or native dialog errors through IPC.
      throw new Error(nativeT("desktop.browser.generation.failed"))
    }
  }
}
