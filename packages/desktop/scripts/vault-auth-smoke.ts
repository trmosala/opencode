import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import electron from "electron"

// Interactive test of the real OS verifier; never opens or decrypts the password vault.
const directory = await mkdtemp(join(tmpdir(), "cm-vault-auth-"))
try {
  const entry = join(directory, "entry.ts")
  await Bun.write(
    entry,
    `
    import { app, BrowserWindow } from "electron"
    import { writeFileSync } from "node:fs"
    import { vaultAuthentication } from ${JSON.stringify(resolve(import.meta.dir, "../src/main/browser/vault-auth.ts"))}
    app.setPath("userData", ${JSON.stringify(directory)})
    app.getAppPath = () => ${JSON.stringify(resolve(import.meta.dir, ".."))}
    async function run() {
    await app.whenReady()
    const win = new BrowserWindow({width: 500, height: 180, webPreferences: {sandbox:true, contextIsolation:true, nodeIntegration:false}})
    await win.loadURL("data:text/html,<title>CookieMonster authentication test</title><p>Verify with Windows Hello. This test does not access saved passwords.</p>")
    try {
      await vaultAuthentication.verify(win)
      writeFileSync(${JSON.stringify(join(directory, "result"))}, "VERIFIED")
    } catch {
      writeFileSync(${JSON.stringify(join(directory, "result"))}, "NOT VERIFIED")
    } finally { app.exit() }
    }
    run().catch(() => { writeFileSync(${JSON.stringify(join(directory, "result"))}, "TEST FAILED"); app.exit(1) })
  `,
  )
  const built = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", external: ["electron"] })
  if (!built.success) throw new Error("Authentication test build failed")
  const script = join(directory, "entry.mjs")
  await Bun.write(script, built.outputs[0])
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([electron, script], { env, stdout: "inherit", stderr: "inherit" })
  const timeout = setTimeout(() => child.kill(), 150_000)
  await child.exited
  clearTimeout(timeout)
  const result = await Bun.file(join(directory, "result"))
    .text()
    .catch(() => "NO RESULT")
  console.log(result)
  if (result !== "VERIFIED") throw new Error("Device authentication was not verified")
} finally {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("cm-vault-auth-"))
    throw new Error("Unexpected test directory")
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
