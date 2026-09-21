import { expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

const source = await Bun.file(new URL("./tray.ts", import.meta.url)).text()
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
  source
    .replace(/^import .*$/gm, "")
    .replace("import.meta.url", JSON.stringify(new URL("./tray.ts", import.meta.url).href))
    .replace(/^export /gm, ""),
)

for (const platform of ["darwin", "win32", "linux"]) {
  for (const packaged of [false, true]) {
    test(`tray image on ${platform}, packaged=${packaged}`, () => {
      const loaded: string[] = []
      const resized: object[] = []
      const image = {
        resize(options: object) {
          resized.push(options)
          return small
        },
      }
      const small = {}
      const received: unknown[] = []
      runInNewContext(`${compiled}\ncreateTray(() => {})`, {
        dirname,
        join,
        fileURLToPath,
        process: { platform, resourcesPath: "/packaged/resources" },
        app: { isPackaged: packaged, getName: () => "CookieMonster" },
        Menu: { buildFromTemplate: () => [] },
        nativeImage: {
          createFromPath(path: string) {
            loaded.push(path)
            return image
          },
        },
        Tray: class {
          constructor(value: unknown) {
            received.push(value)
          }
          setToolTip() {}
          setContextMenu() {}
          on() {}
        },
      })
      const directory = packaged
        ? "/packaged/resources/icons"
        : join(dirname(fileURLToPath(new URL("./tray.ts", import.meta.url))), "../../resources/icons")
      expect(loaded).toEqual([
        join(directory, platform === "darwin" ? "32x32.png" : platform === "win32" ? "icon.ico" : "icon.png"),
      ])
      expect(resized).toEqual(platform === "darwin" ? [{ width: 16, height: 16 }] : [])
      expect(received).toEqual([platform === "darwin" ? small : image])
    })
  }
}

test("every build channel includes the small tray asset", async () => {
  for (const channel of ["dev", "beta", "prod"]) {
    const bytes = await Bun.file(new URL(`../../icons/${channel}/32x32.png`, import.meta.url)).bytes()
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(header.getUint32(16)).toBe(32)
    expect(header.getUint32(20)).toBe(32)
  }
})
