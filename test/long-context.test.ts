// Long context: the opt-in header, the pre-flight request size check, and
// the compaction budgets that ride on it.

import { describe, expect, test } from "bun:test"
import {
  DEFAULTS,
  JEV_DEFAULT_CONTEXT_LIMIT,
  JEV_LONG_CONTEXT_LIMIT,
  LONG_CONTEXT_BUDGETS,
  LONG_CONTEXT_HEADER,
  longContextHeaders,
  oversizedRequest,
} from "../src/compaction"

describe("longContextHeaders", () => {
  test("sends the Danger Zone header only when on", () => {
    expect(longContextHeaders(true)).toEqual({ "TypeSafe-Danger-Zone-Long-Context": "true" })
    expect(LONG_CONTEXT_HEADER).toBe("TypeSafe-Danger-Zone-Long-Context")
    expect(longContextHeaders(false)).toEqual({})
  })
})

describe("oversizedRequest", () => {
  // Each "word" is one estimated token.
  const words = (n: number) => "word ".repeat(n)

  test("passes a request under the default limit", () => {
    expect(oversizedRequest(words(50_000), false)).toBeUndefined()
  })

  test("refuses a request over the default limit without long context", () => {
    const message = oversizedRequest(words(70_000), false)
    expect(message).toMatch(/^jev: request is ~\d+ tokens, over the default limit of ~60000$/)
  })

  test("passes a request over the default limit when long context is on", () => {
    expect(oversizedRequest(words(70_000), true)).toBeUndefined()
  })

  test("refuses a request over the long-context limit", () => {
    const message = oversizedRequest(words(JEV_LONG_CONTEXT_LIMIT + 10_000), true)
    expect(message).toMatch(/over the long-context limit of ~250000$/)
  })
})

describe("limits", () => {
  test("stay below Jev's documented caps (64k per request, 262k with long context)", () => {
    expect(JEV_DEFAULT_CONTEXT_LIMIT).toBeLessThanOrEqual(64_000)
    expect(JEV_LONG_CONTEXT_LIMIT).toBeLessThanOrEqual(262_144)
  })

  test("long-context compaction budgets fit under the long-context request limit", () => {
    expect(LONG_CONTEXT_BUDGETS.maxStateTokens).toBeLessThanOrEqual(JEV_LONG_CONTEXT_LIMIT)
    expect(LONG_CONTEXT_BUDGETS.maxRequestTokens).toBeLessThanOrEqual(JEV_LONG_CONTEXT_LIMIT)
  })

  test("long-context budgets are larger than the default compaction budgets", () => {
    expect(LONG_CONTEXT_BUDGETS.maxStateTokens).toBeGreaterThan(DEFAULTS.maxStateTokens)
    expect(LONG_CONTEXT_BUDGETS.maxRequestTokens).toBeGreaterThan(DEFAULTS.maxRequestTokens)
  })
})
