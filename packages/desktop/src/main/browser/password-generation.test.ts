import { expect, test } from "bun:test"
import { generatePassword, passwordOptions } from "./password-generation"

test("generation uses bounded settings and satisfies every selected character class", () => {
  expect(passwordOptions({})).toEqual({ length: 20, symbols: true })
  for (const length of [16, 20, 64]) {
    for (const symbols of [false, true]) {
      const values = new Set(Array.from({ length: 32 }, () => generatePassword({ length, symbols })))
      expect(values.size).toBe(32)
      for (const value of values) {
        expect(value.length).toBe(length)
        expect(/^[a-zA-Z0-9!@#$%^&*()\-_=+\[\]{}:,.?]+$/.test(value)).toBe(true)
        expect(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)).toBe(true)
        expect(/[^a-zA-Z0-9]/.test(value)).toBe(symbols)
      }
    }
  }
  for (const length of [null, "20", NaN, Infinity, 0, 15, 65, 20.5]) {
    expect(() => passwordOptions({ length })).toThrow()
  }
  for (const symbols of [null, "true", 1]) expect(() => passwordOptions({ symbols })).toThrow()
  for (const [min, max] of [
    [21, 64],
    [16, 19],
    [65, 64],
    [16, 15],
    [NaN, 64],
    [16, Infinity],
  ]) {
    expect(() => passwordOptions({}, min, max)).toThrow()
  }
  expect(passwordOptions({ length: 24, symbols: false }, 24, 24)).toEqual({ length: 24, symbols: false })
})
