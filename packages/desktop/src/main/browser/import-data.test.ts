import { expect, test } from "bun:test"
import { loginOrigin, parseCookieJSON, parsePasswordCSV } from "./import-data"

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

test("malformed CSV errors never include credential records", async () => {
  await expect(parsePasswordCSV('url,username,password\nhttps://example.com,user,secret"invalid')).rejects.toThrow(
    /^Invalid password import$/,
  )
})
