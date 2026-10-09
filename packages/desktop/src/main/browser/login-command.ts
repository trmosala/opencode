import type { MessageBoxOptions, WebContents } from "electron"
import { nativeT } from "../native-translations"
import { browserProfile, pageLogin, saveLogins } from "./profile"
import { vaultAccess } from "./vault-session"

type LoginTarget = {
  contents: WebContents
  begin(validate: () => void): {
    check(attached?: boolean): void
    release(): void
  }
  confirm(options: () => MessageBoxOptions, check: () => void): Promise<boolean>
}

export async function runBrowserLogin(
  command: { op: "save-login" | "fill-login"; id?: string; field?: "username" | "password" },
  target: LoginTarget,
) {
  const contents = target.contents
  const ticket = vaultAccess.require()
  const lease = target.begin(() => {
    vaultAccess.require(ticket)
  })
  const check = (attached = false) => lease.check(attached)
  try {
    const login =
      command.op === "save-login"
        ? await pageLogin(contents, undefined, check)
        : browserProfile().credentials.find(
            (row) => "id" in command && row.id === command.id && row.origin === new URL(contents.getURL()).origin,
          )
    if (!login) throw new Error("No matching login")
    check(true)
    const confirm = async () => {
      check(true)
      return target.confirm(
        () => ({
          type: "question",
          message: nativeT(
            command.op === "save-login"
              ? "desktop.browser.saveLogin"
              : "field" in command && command.field === "username"
                ? "desktop.browser.fillUsername"
                : "field" in command && command.field === "password"
                  ? "desktop.browser.fillPassword"
                  : "desktop.browser.fillLogin",
          ),
          detail: nativeT(
            command.op === "save-login" ? "desktop.browser.saveLoginDetail" : "desktop.browser.fillLoginDetail",
            { origin: login.origin, username: login.username },
          ),
          buttons: [
            nativeT("desktop.browser.cancel"),
            nativeT(command.op === "save-login" ? "desktop.browser.save" : "desktop.browser.fill"),
          ],
          defaultId: 0,
          cancelId: 0,
        }),
        () => check(),
      )
    }
    if (command.op === "fill-login") await pageLogin(contents, command.id, () => check(true), command.field, confirm)
    else if (await confirm()) {
      check(true)
      if ("password" in login) saveLogins([login])
    }
  } finally {
    lease.release()
  }
}
