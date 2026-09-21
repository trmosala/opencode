import type { Session } from "electron"

export async function clearCookies(profile: Pick<Session, "clearStorageData" | "clearAuthCache">) {
  await profile.clearStorageData({ storages: ["cookies"] })
  await profile.clearAuthCache()
}
