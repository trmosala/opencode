<p align="center">
  <img src="packages/desktop/icons/prod/cm-logos/CookieMonster-01.svg" width="112" alt="CookieMonster cookie logo" />
</p>

<p align="center">
  <img src="packages/desktop/icons/prod/cm-logos/CookieMonster-02.svg" width="354" alt="CookieMonster" />
</p>
<p align="center">A desktop AI agent for creative production and development at Ogilvy One.</p>
<p align="center">
  <a href="https://github.com/trmosala/opencode/releases/latest">Download for macOS</a> ·
  <a href="docs/training/cookiemonster/README.md">Training</a> ·
  <a href="packages/desktop/SYSTEM_CLI.md">Installation guide</a>
</p>

---

CookieMonster brings OpenCode's agent tools into an Electron desktop app connected to **WPP Open** through your employee SSO. Work in local projects, turn briefs into files and code, and review what the agent changes.

## What you can do

- Plan work, edit files, run commands, and review changes in your project.
- Use WPP-hosted AI models with your existing WPP sign-in.
- Browse alongside your work and give the agent access to selected browser tabs.
- Save images and videos generated through WPP into your project.

## Get started

1. Download the macOS DMG from the [releases page](https://github.com/trmosala/opencode/releases/latest).
2. Open CookieMonster in the DMG and choose **Install for My User**.
3. Open the installed app, sign in to WPP Open, and select a project folder.

The app installs to `~/Applications/CookieMonster.app`. Your WPP sign-in persists across restarts. See the [installation guide](packages/desktop/SYSTEM_CLI.md) for manual installation and troubleshooting.

> [!NOTE]
> CookieMonster is internal Ogilvy One tooling. WPP-backed models require employee SSO. External distribution requires written approval from the WPP Open platform owner.

## Develop locally

Use Bun **1.3.14**. The default branch is `dev`.

```bash
bun install
bun run dev:desktop
```

To debug WPP requests with visible worker windows:

```bash
O1_CODE_SHOW_WORKERS=1 bun run dev:desktop
```

| Area                        | Location                                     |
| --------------------------- | -------------------------------------------- |
| Electron app and WPP bridge | [`packages/desktop`](packages/desktop)       |
| Shared UI and browser panel | [`packages/app`](packages/app)               |
| Agent browser tools         | [`packages/cm-browser`](packages/cm-browser) |

Read [AGENTS.md](AGENTS.md) before making changes. Run bridge tests from `packages/desktop` with `bun test src/main/wpp-bridge/`. macOS builds must use `CM_BRAND=1`; signing and packaging instructions are in the [installation guide](packages/desktop/SYSTEM_CLI.md).

---

Built on [OpenCode](https://github.com/anomalyco/opencode), with a custom desktop app and WPP integration maintained by Ogilvy One. This fork is independently maintained and is not affiliated with the OpenCode team. Upstream code is [MIT licensed](LICENSE).
