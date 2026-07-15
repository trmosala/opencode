import { describe, expect, test } from "bun:test"
import { renderStatusPage } from "./statusPage.mjs"
import { WPP_COOKIE_MONSTER_PROJECT_URL } from "./wppProject.mjs"

describe("CookieMonster WPP project target", () => {
  test("points workers and operator links at the CookieMonster project agent roster", () => {
    expect(WPP_COOKIE_MONSTER_PROJECT_URL).toBe(
      "https://ogilvy.os.wpp.com/orchestration/project/096d5921-ad5a-4ffd-a0c7-35a1009fa2a0/agents",
    )
    expect(renderStatusPage()).toContain(WPP_COOKIE_MONSTER_PROJECT_URL)
    expect(renderStatusPage()).not.toContain("/agent/workspace")
  })
})
