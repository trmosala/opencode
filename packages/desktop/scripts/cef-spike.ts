// Throwaway native-browser feasibility probe. Not imported by the desktop app.
// Run: bun scripts/cef-spike.ts [--prepare | --serve-only]
// Only use the dummy credentials below. cefclient uses a mock Keychain on macOS.
// Stock CEF on macOS forces Alloy for parent_view or OSR; this is a separate window.
// Evidence: https://github.com/chromiumembedded/cef/blob/564dd6c/include/internal/cef_types_mac.h
import { createHash } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const version = "154.0.28+g564dd6c+chromium-154.0.8037.58"
const builds = {
  "win32-x64": { platform: "windows64", sha1: "8e5980c6f5b923ce3c04d4ffae36fefe9988ed70", size: 170071641 },
  "darwin-arm64": { platform: "macosarm64", sha1: "bdf559ed4267045dd925fd43c554b94575d6fe04", size: 132801237 },
  "darwin-x64": { platform: "macosx64", sha1: "57027949d5457ba1ca1175e0e01d0518772a4565", size: 139324510 },
}
const build = Object.entries(builds).find(([key]) => key === `${process.platform}-${process.arch}`)?.[1]
if (!build) throw new Error("This spike supports Windows x64 and macOS arm64/x64 only.")
const mode = process.argv[2]
if (process.argv.length > 3 || (mode && !["--prepare", "--serve-only"].includes(mode))) {
  throw new Error("Usage: bun scripts/cef-spike.ts [--prepare | --serve-only]")
}

const root = fileURLToPath(new URL("../out/cef-spike/", import.meta.url))
await mkdir(root, { recursive: true })
const name = `cef_binary_${version}_${build.platform}_client`
const archive = join(root, `${name}.tar.bz2`)
const executable = join(
  root,
  name,
  process.platform === "win32" ? "Release/cefclient.exe" : "Release/cefclient.app/Contents/MacOS/cefclient",
)
if (mode !== "--serve-only") {
  if (!(await Bun.file(archive).exists())) {
    console.log(`Downloading official CEF client, ${(build.size / 1_000_000).toFixed(0)} MB.`)
    const response = await fetch(`https://cef-builds.spotifycdn.com/${encodeURIComponent(name)}.tar.bz2`)
    if (!response.ok) throw new Error(`CEF download failed: ${response.status}`)
    await Bun.write(archive, response)
  }
  // The upstream index publishes SHA-1, not a release signature. This checks
  // transfer integrity against the pinned HTTPS index, not publisher signing.
  // Reopen after writing: Bun can cache an absent file's zero length.
  const bytes = await Bun.file(archive).arrayBuffer()
  if (
    bytes.byteLength !== build.size ||
    createHash("sha1").update(new Uint8Array(bytes)).digest("hex") !== build.sha1
  ) {
    throw new Error(`CEF archive integrity check failed. Remove ${archive} before retrying.`)
  }
  console.log(`Verified pinned archive: ${name}`)
  if (!(await Bun.file(executable).exists())) {
    const unpack = Bun.spawn(["tar", "-xjf", archive, "-C", root], { stdout: "inherit", stderr: "inherit" })
    if ((await unpack.exited) !== 0) throw new Error("CEF extraction failed.")
  }
  if (!(await Bun.file(executable).exists())) throw new Error(`CEF sample executable missing: ${executable}`)
  console.log(`Executable: ${executable}`)
}
if (mode === "--prepare") process.exit(0)

const run = await mkdtemp(join(root, "run-"))
const profile = join(run, "profile")
await mkdir(profile)
const credentials = { username: "demo.user@example.test", password: "CEF-spike-only-42!" }
const counts = { loginPage: 0, submitted: 0, successPage: 0 }
const document = (content: string) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>CEF native browser spike</title>
<body><h1>CEF native browser spike</h1>
<p>Disposable test profile. Do not enter real credentials or browse signed-in sites.</p>
${content}</body></html>`
const login = document(`<p>Enter <code>${credentials.username}</code> and <code>${credentials.password}</code>.
These are fake, local-only credentials.</p>
<form method="post" action="/login">
<p><label>Username <input id="username" name="username" autocomplete="username" required></label></p>
<p><label>Password <input id="password" name="password" type="password" autocomplete="current-password" required></label></p>
<button type="submit">Sign in to test site</button>
</form>
<h2>Manual checks</h2>
<ol><li>Submit the form. Look for Chromium's native Save password bubble.</li>
<li>Save the dummy credential, then return to the login form and test autofill.</li>
<li>Close all CEF windows. Press Enter in the terminal to restart the same profile.</li>
<li>Return to the form and verify the credential survived restart.</li>
<li>Inspect chrome://password-manager/passwords and chrome://extensions manually.</li></ol>
<p>Record native popup anchoring, keyboard focus and resize behaviour separately.
A loaded web page does not prove that a native password bubble appeared.</p>`)
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 4096,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.host !== `${server.hostname}:${server.port}`) return new Response(null, { status: 403 })
    if (request.method === "GET" && url.pathname === "/") {
      counts.loginPage++
      return new Response(login, { headers })
    }
    if (request.method === "POST" && url.pathname === "/login") {
      if (request.headers.get("origin") !== url.origin) return new Response(null, { status: 403 })
      const form = new URLSearchParams(await request.text())
      if (form.get("username") !== credentials.username || form.get("password") !== credentials.password) {
        return new Response(document('<p>Use the dummy credentials only.</p><a href="/">Try again</a>'), {
          status: 401,
          headers,
        })
      }
      counts.submitted++
      console.log(`Dummy login accepted. Submissions: ${counts.submitted}. Check the native password bubble.`)
      return new Response(null, { status: 303, headers: { Location: "/success", "Cache-Control": "no-store" } })
    }
    if (request.method === "GET" && url.pathname === "/success") {
      counts.successPage++
      return new Response(document('<p>Dummy sign-in succeeded.</p><a href="/">Return to login to test autofill</a>'), {
        headers,
      })
    }
    return new Response(null, { status: 404 })
  },
})
console.log(`Fixture: ${server.url}`)
console.log(`Profile: ${profile}`)
console.log("No remote-debugging port, agent connection, profile import, or real account required.")
if (process.platform === "darwin")
  console.log("WARNING: upstream cefclient enables use-mock-keychain. Dummy data only.")

if (mode !== "--serve-only") {
  const { createInterface } = await import("node:readline/promises")
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      console.log("Launching stock CEF in a separate Chrome-style window.")
      const child = Bun.spawn(
        [
          executable,
          "--use-views",
          "--show-chrome-toolbar",
          `--cache-path=${profile}`,
          `--url=${server.url}`,
          `--log-file=${join(run, "cef.log")}`,
        ],
        { cwd: dirname(executable), stdout: "inherit", stderr: "inherit" },
      )
      const stop = () => child.kill()
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
      const code = await child.exited
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      console.log(`CEF exited ${code}. Fixture counters: ${JSON.stringify(counts)}`)
      if (code !== 0) {
        process.exitCode = 1
        break
      }
      if (!process.stdin.isTTY || (await input.question("Enter to restart the SAME profile, or q to finish: ")).trim())
        break
    }
  } finally {
    input.close()
    await server.stop(true)
  }
}
