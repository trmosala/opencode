import { fileURLToPath } from "node:url"
import { stageCmAeBundle } from "../src/cm-ae"

stageCmAeBundle(process.env.CM_AE_ARTIFACT_DIR, fileURLToPath(new URL("../", import.meta.url)))
