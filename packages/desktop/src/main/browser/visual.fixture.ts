import { screenshotsSmoke } from "./screenshots.fixture"

// Runs only inside native-smoke's isolated synthetic BrowserWindow profile.
export async function visualSmoke() {
  await screenshotsSmoke()
}
