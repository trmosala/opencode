import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import electron from "../../packages/desktop/node_modules/electron"
const output = resolve("node_modules/.cache/cm-browser-native-ui/root-review/issue58-native")
const build = await Bun.build({entrypoints:["tmp/browser-implementation/issue58-native.ts"],target:"node",format:"cjs",external:["electron"]})
if(!build.success) throw Error(build.logs.join("\n"))
for(const scale of process.argv.slice(2).length ? process.argv.slice(2) : ["1","1.25","2"]) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),"cm-browser-corners-")))
  const entry=join(directory,"corners.cjs")
  await Bun.write(entry,build.outputs[0])
  const env={...process.env,CM_BROWSER_STATE_DIR:directory,CM_BROWSER_SMOKE_PROFILE:directory,CM_CORNER_OUTPUT:output,CM_CORNER_SCALE:scale}
  delete env.ELECTRON_RUN_AS_NODE
  const child=Bun.spawn([electron,entry],{env,stdout:"inherit",stderr:"inherit"})
  const timeout=process.env.CM_CORNER_HOLD==='1' ? undefined : setTimeout(()=>child.kill(),90000)
  const code=await child.exited
  if(timeout)clearTimeout(timeout)
  console.log("Owned fixture",directory,"exited",code)
  if(code!==0)throw Error("Native corner review failed")
}
