import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import { CM_AE_FILES, stageCmAeBundle } from "./src/cm-ae"

// Fork CI has no Apple certificate and no Azure Trusted Signing account. CM_UNSIGNED=1 strips every
// signing and notarization step so electron-builder emits unsigned installers instead of failing on
// absent credentials. Upstream release builds leave it unset and keep signing exactly as before.
const unsigned = process.env.CM_UNSIGNED === "1"
const branded = process.env.CM_BRAND === "1"
const systemCli = branded && (process.platform === "win32" || process.platform === "darwin")

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return
  if (unsigned) return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "opencode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/opencode-cli*",
    "!resources/cli{,/**/*}",
    "!resources/cm-ae{,/**/*}",
  ],
  extraResources: [
    ...(process.platform === "win32" ? [{ from: "resources/vault-auth", to: "vault-auth", filter: ["*.exe"] }] : []),
    {
      from: "resources/icons",
      to: "icons",
    },
    ...(channel === "dev" || branded
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    ...(systemCli
      ? [
          {
            from: "resources/cli",
            to: "cli",
            filter: [process.platform === "win32" ? "opencode.exe" : "opencode"],
          },
          ...(process.platform === "win32"
            ? [
                {
                  from: "resources/windows/cli-path.ps1",
                  to: "cli/register-path.ps1",
                },
              ]
            : []),
        ]
      : []),
    {
      from: "../cm-browser/dist/plugin.mjs",
      to: "cm-browser/plugin.mjs",
    },
    {
      from: "resources/cm-ae",
      to: "cm-ae",
      filter: [...CM_AE_FILES],
    },
    // native/ is produced by `bun run native:build` and is not committed. electron-builder treats a
    // missing extraResources source as a hard error, so only declare it when it is actually present.
    ...(existsSync(path.join(packageDir, "native"))
      ? [
          {
            from: "native/",
            to: "native/",
            filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
          },
        ]
      : []),
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "OpenCode",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

// Optional fork branding (CM_BRAND=1): rename the app so it never collides with a real OpenCode
// install and strip publish so a fork build can never auto-update to upstream.
function applyBranding(cfg: Configuration): Configuration {
  if (!branded) return cfg
  return {
    ...cfg,
    appId: "com.ogilvy.cookiemonster",
    productName: "CookieMonster",
    extraMetadata: { ...cfg.extraMetadata, cmUserInstall: true },
    mac: { ...cfg.mac, target: ["pkg", "dmg", "zip"] },
    pkg: {
      installLocation: "/Applications",
      allowAnywhere: false,
      allowCurrentUserHome: false,
      allowRootDirectory: true,
      isRelocatable: false,
      scripts: "macos/pkg-scripts",
      conclusion: "macos/pkg-conclusion.txt",
    },
    nsis: { ...cfg.nsis, include: "resources/windows/cli-install.nsh" },
    dmg: {
      ...cfg.dmg,
      backgroundColor: "#ffffff",
      window: { width: 540, height: 360 },
      contents: [
        { x: 160, y: 160, type: "file" },
        { x: 380, y: 160, type: "file", path: path.join(packageDir, "resources", "Install CookieMonster.txt") },
      ],
    },
    artifactName: "cookiemonster-${os}-${arch}.${ext}",
    publish: null,
  }
}

// Signing is all-or-nothing per platform: a hardened runtime or a notarization request without a
// real identity fails the build outright, so drop them together rather than individually.
function applyUnsigned(cfg: Configuration): Configuration {
  if (!unsigned) return cfg
  return {
    ...cfg,
    mac: { ...cfg.mac, identity: null, hardenedRuntime: false, notarize: false },
    dmg: { ...cfg.dmg, sign: false },
    win: { ...cfg.win, signtoolOptions: undefined },
  }
}

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "OpenCode Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "opencode", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

// Re-stage for direct package commands too; fail rather than package a stale or missing bundle.
stageCmAeBundle(process.env.CM_AE_ARTIFACT_DIR, packageDir)

export default applyUnsigned(applyBranding(getConfig() as Configuration))
