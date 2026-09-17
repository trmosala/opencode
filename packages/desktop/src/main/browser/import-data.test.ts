import { expect, test } from "bun:test"
import { loginOrigin, mergeLogins, parseCookieJSON, parsePasswordCSV } from "./import-data"

test("password batches keep IDs, skip exact duplicates, and use the last source row", () => {
  const saved = { id: "stable", origin: "https://example.com", username: "user", password: "old" }
  const changed = { ...saved, password: "new" }
  const plan = mergeLogins([saved], [saved, changed, changed])
  expect(plan).toMatchObject({ valid: 3, duplicate: 2, add: 0, replace: 1, unchanged: 0 })
  expect(plan.rows).toEqual([changed])
  expect(mergeLogins(plan.rows, [changed, changed])).toMatchObject({ add: 0, replace: 0, unchanged: 1, duplicate: 1 })
  expect(() => mergeLogins([saved], [{ ...changed, password: "" }])).toThrow()
})

test("imports browser CSV exports using quoted fields and BOM without trimming secrets", async () => {
  expect(
    await parsePasswordCSV(
      '\uFEFFname,url,username,password\r\nExample,https://example.com/login,"a,b"," line1\nline2 "\r\n',
    ),
  ).toEqual([{ origin: "https://example.com", username: "a,b", password: " line1\nline2 " }])
  expect(await parsePasswordCSV("url,username,password,httpRealm\nhttps://example.com:443/,user,secret,\n")).toEqual([
    { origin: "https://example.com", username: "user", password: "secret" },
  ])
})

test("rejects unusable credential imports and insecure or credential-bearing origins", async () => {
  for (const value of ["javascript:alert(1)", "http://example.com/", "https://user:pass@example.com/"])
    expect(() => loginOrigin(value)).toThrow()
  expect(loginOrigin("http://localhost:5000/login")).toBe("http://localhost:5000")
  for (const csv of [
    "url,username,password",
    "url,username,password\nhttps://example.com,a,",
    'url,username,password\nhttps://example.com,a,"broken',
  ])
    await expect(parsePasswordCSV(csv)).rejects.toThrow()
})

test("cookie JSON preserves flags and expiry and rejects invalid domains and paths", () => {
  const cookie = parseCookieJSON(
    JSON.stringify([
      {
        domain: ".example.com",
        name: "session",
        value: "token",
        secure: true,
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        expirationDate: 2000000000,
      },
    ]),
  )[0]
  expect(cookie).toEqual({
    url: "https://example.com/",
    domain: ".example.com",
    name: "session",
    value: "token",
    secure: true,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    expirationDate: 2000000000,
  })
  for (const domain of ["example.com/path", "example.com@evil.com", "", "../"])
    expect(() => parseCookieJSON(JSON.stringify([{ domain, name: "s", value: "x" }]))).toThrow()
  expect(() => parseCookieJSON("{}")).toThrow()
  expect(() => parseCookieJSON('[{"domain":"example.com","name":"s","value":"x","path":"bad"}]')).toThrow()
})

test("IPv4 cookie exports normalize to one host-only representation without broadening DNS scope", () => {
  const row = { name: "s", value: "x", secure: true, httpOnly: true, sameSite: "lax", session: true }
  const expected = parseCookieJSON(JSON.stringify([{ ...row, domain: "127.0.0.1", hostOnly: true }]))[0]
  expect(expected.url).toBe("https://127.0.0.1/")
  expect(expected).not.toHaveProperty("domain")
  for (const domain of ["127.0.0.1", ".127.0.0.1"])
    for (const hostOnly of [undefined, false, true])
      expect(parseCookieJSON(JSON.stringify([{ ...row, domain, hostOnly }]))[0]).toEqual(expected)
  expect(parseCookieJSON(JSON.stringify([{ ...row, domain: ".example.com" }]))[0].domain).toBe(".example.com")
  expect(parseCookieJSON(JSON.stringify([{ ...row, domain: "example.com", hostOnly: true }]))[0]).not.toHaveProperty(
    "domain",
  )
  for (const domain of ["127.1", "127.000.0.1", "[::1]"])
    expect(() => parseCookieJSON(JSON.stringify([{ ...row, domain }]))).toThrow()
})

test("cookie errors are sanitized and unsupported scopes never become ordinary cookies", () => {
  expect(() => parseCookieJSON('[{"value":"PRIVATE_SECRET"')).toThrow(/^Invalid cookie import$/)
  for (const scope of [
    { partitionKey: { topLevelSite: "https://example.com" } },
    { partitioned: true },
    { firstPartyDomain: "example.com" },
    { sameSite: "unexpected" },
  ])
    expect(() =>
      parseCookieJSON(JSON.stringify([{ domain: "example.com", name: "s", value: "PRIVATE_SECRET", ...scope }])),
    ).toThrow()
})

test("malformed CSV errors never include credential records", async () => {
  await expect(parsePasswordCSV('url,username,password\nhttps://example.com,user,secret"invalid')).rejects.toThrow(
    /^Invalid password import$/,
  )
})
