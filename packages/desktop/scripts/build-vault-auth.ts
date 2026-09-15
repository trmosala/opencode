import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

if (process.platform === "win32") {
  const arch = process.env.npm_config_arch ?? process.arch
  if (arch !== "x64" && arch !== "arm64") throw new Error("Unsupported vault authenticator architecture")
  const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
  const result = spawnSync(
    join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  )
  const installation = result.stdout?.trim()
  if (result.status !== 0 || !installation)
    throw new Error("Visual Studio C++ build tools required for Windows vault authentication")
  const tools = join(installation, "VC", "Tools", "MSVC")
  const version = readdirSync(tools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
  const sdk = join(programFiles, "Windows Kits", "10")
  const sdkVersion = readdirSync(join(sdk, "Include"))
    .filter((v) => existsSync(join(sdk, "Include", v, "cppwinrt")))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
  if (!version || !sdkVersion) throw new Error("Windows SDK with C++/WinRT required")
  const output = resolve(import.meta.dir, "../resources/vault-auth")
  mkdirSync(output, { recursive: true })
  for (const name of ["windows", "windows-entry"]) {
    const build = spawnSync(
      join(tools, version, "bin", "Hostx64", arch, "cl.exe"),
      [
        "/nologo",
        "/std:c++17",
        "/EHsc",
        "/O2",
        "/MT",
        "/guard:cf",
        "/DUNICODE",
        "/D_UNICODE",
        resolve(import.meta.dir, `../native-vault/${name}.cpp`),
        `/Fo${join(output, `${name}-${arch}.obj`)}`,
        `/Fe${join(output, `${name}-${arch}.exe`)}`,
        "/link",
        "/DYNAMICBASE",
        "/NXCOMPAT",
        "windowsapp.lib",
        "user32.lib",
        "credui.lib",
      ],
      {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          INCLUDE: [
            join(tools, version, "include"),
            ...["ucrt", "shared", "um", "winrt", "cppwinrt"].map((name) => join(sdk, "Include", sdkVersion, name)),
          ].join(";"),
          LIB: [
            join(tools, version, "lib", arch),
            ...["ucrt", "um"].map((name) => join(sdk, "Lib", sdkVersion, name, arch)),
          ].join(";"),
        },
      },
    )
    if (build.status !== 0) throw new Error("Windows vault helper build failed")
  }
}
