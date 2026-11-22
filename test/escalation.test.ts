// Escalation tests: pure waiver/grant logic (no plugin host, no jev). The
// request_approval tool and the permission-event wiring in index.ts are thin
// wrappers; these own the fail-closed semantics of the escalation channel.

import { describe, expect, test } from "bun:test"
import {
  ESCALATION_GRANT_CAP,
  ESCALATION_GRANT_TTL_MS,
  ESCALATION_WAIVER_TTL_MS,
  escalationAction,
  escalationGrantsCover,
  escalationGrantsKey,
  escalationHash,
  escalationNote,
  escalationWaiverMatches,
  parseEscalation,
  pruneEscalationGrants,
} from "../src/logic"

const NOW = 1_700_000_000_000

const waiver = (overrides: Partial<Parameters<typeof escalationWaiverMatches>[0]> = {}) => ({
  action: "shell",
  hash: escalationHash("shell", "rm -rf dist"),
  reason: "routine build cleanup",
  at: NOW - 1000,
  ...overrides,
})

describe("parseEscalation", () => {
  test("on by default; only false disables, wrong types fail closed", () => {
    expect(parseEscalation(undefined)).toBe(true)
    expect(parseEscalation(true)).toBe(true)
    expect(parseEscalation(false)).toBe(false)
    expect(parseEscalation("yes")).toBe(false)
    expect(parseEscalation("false")).toBe(false)
    expect(parseEscalation({})).toBe(false)
    expect(parseEscalation(1)).toBe(false)
  })
})

describe("escalationHash", () => {
  test("deterministic and exact to (action, resource)", () => {
    expect(escalationHash("shell", "rm -rf dist")).toBe(escalationHash("shell", "rm -rf dist"))
    expect(escalationHash("shell", "rm -rf dist")).not.toBe(escalationHash("edit", "rm -rf dist"))
    expect(escalationHash("shell", "rm -rf dist")).not.toBe(escalationHash("shell", "rm -rf dist2"))
    // the same resource under different actions never shares a grant
    expect(escalationHash("shell", "x\ny")).not.toBe(escalationHash("shel", "lx\ny"))
  })

  test("bash and shell are the same action", () => {
    expect(escalationAction("bash")).toBe("shell")
    expect(escalationAction("edit")).toBe("edit")
    expect(escalationHash("bash", "rm -rf dist")).toBe(escalationHash("shell", "rm -rf dist"))
    expect(escalationWaiverMatches(waiver({ action: "bash" }), "shell", ["rm -rf dist"], NOW)).toBe(true)
    expect(escalationWaiverMatches(waiver(), "bash", ["rm -rf dist"], NOW)).toBe(true)
  })
})

describe("escalationGrantsKey", () => {
  test("scoped per location; empty locations share a fail-safe default", () => {
    expect(escalationGrantsKey("/repo/a")).toBe("jev-approval-grants//repo/a")
    expect(escalationGrantsKey("/repo/b")).not.toBe(escalationGrantsKey("/repo/a"))
    expect(escalationGrantsKey(undefined)).toBe("jev-approval-grants/default")
    expect(escalationGrantsKey("")).toBe("jev-approval-grants/default")
  })
})

describe("escalationWaiverMatches", () => {
  test("matches the exact action + resource", () => {
    const w = waiver()
    expect(escalationWaiverMatches(w, "shell", ["rm -rf dist"], NOW)).toBe(true)
    expect(escalationWaiverMatches(w, "shell", ["rm -rf dist", "other"], NOW)).toBe(true)
  })

  test("never matches a different action, resource, or an expired waiver", () => {
    const w = waiver()
    expect(escalationWaiverMatches(w, "edit", ["rm -rf dist"], NOW)).toBe(false)
    expect(escalationWaiverMatches(w, "shell", ["rm -rf src"], NOW)).toBe(false)
    expect(escalationWaiverMatches(waiver({ at: NOW - ESCALATION_WAIVER_TTL_MS - 1 }), "shell", ["rm -rf dist"], NOW)).toBe(false)
  })

  test("a converted waiver cannot convert a second identical denial", () => {
    const w = waiver({ converted: true })
    expect(escalationWaiverMatches(w, "shell", ["rm -rf dist"], NOW)).toBe(false)
  })

  test("undefined waiver never matches (fail closed)", () => {
    expect(escalationWaiverMatches(undefined, "shell", ["rm -rf dist"], NOW)).toBe(false)
  })
})

describe("escalationGrantsCover", () => {
  const hash = escalationHash("shell", "rm -rf dist")
  const hash2 = escalationHash("shell", "bun run build")
  const session = new Map([[`ses_a|${hash}`, NOW + 1000]])

  test("covers every resource via session, project, or a mix", () => {
    expect(escalationGrantsCover(session, "ses_a", {}, "shell", ["rm -rf dist"], NOW)).toBe(true)
    expect(escalationGrantsCover(new Map(), "ses_a", { [hash]: NOW + 1000 }, "shell", ["rm -rf dist"], NOW)).toBe(true)
    expect(
      escalationGrantsCover(session, "ses_a", { [hash2]: NOW + 1000 }, "shell", ["rm -rf dist", "bun run build"], NOW),
    ).toBe(true)
    // the shell action alias reaches the same grants
    expect(escalationGrantsCover(session, "ses_a", {}, "bash", ["rm -rf dist"], NOW)).toBe(true)
  })

  test("fails closed on a missing, expired, or wrong-session grant", () => {
    expect(escalationGrantsCover(session, "ses_b", {}, "shell", ["rm -rf dist"], NOW)).toBe(false)
    expect(
      escalationGrantsCover(new Map([[`ses_a|${hash}`, NOW - 1]]), "ses_a", {}, "shell", ["rm -rf dist"], NOW),
    ).toBe(false)
    expect(escalationGrantsCover(new Map(), "ses_a", { [hash]: NOW - 1 }, "shell", ["rm -rf dist"], NOW)).toBe(false)
    expect(escalationGrantsCover(new Map(), "ses_a", {}, "shell", ["rm -rf dist"], NOW)).toBe(false)
    // one uncovered resource keeps the whole request denied
    expect(escalationGrantsCover(session, "ses_a", {}, "shell", ["rm -rf dist", "bun run build"], NOW)).toBe(false)
  })

  test("no session or no resources is never covered", () => {
    expect(escalationGrantsCover(session, undefined, {}, "shell", ["rm -rf dist"], NOW)).toBe(false)
    expect(escalationGrantsCover(session, "ses_a", {}, "shell", [], NOW)).toBe(false)
  })
})

describe("pruneEscalationGrants", () => {
  test("drops expired and malformed entries", () => {
    const pruned = pruneEscalationGrants(
      { keep: NOW + 1000, stale: NOW - 1, junk: "no", "also-junk": Number.NaN },
      NOW,
    )
    expect(pruned).toEqual({ keep: NOW + 1000 })
  })

  test("caps at the limit, evicting the soonest-expiring", () => {
    const blob: Record<string, number> = {}
    for (let i = 0; i < ESCALATION_GRANT_CAP + 5; i++) blob[`h${i}`] = NOW + i * 1000
    const pruned = pruneEscalationGrants(blob, NOW)
    expect(Object.keys(pruned)).toHaveLength(ESCALATION_GRANT_CAP)
    expect(pruned.h0).toBeUndefined()
    expect(pruned[`h${ESCALATION_GRANT_CAP + 4}`]).toBe(NOW + (ESCALATION_GRANT_CAP + 4) * 1000)
  })

  test("unknown shapes rebuild to empty", () => {
    expect(pruneEscalationGrants(undefined, NOW)).toEqual({})
    expect(pruneEscalationGrants([1, 2], NOW)).toEqual({})
    expect(pruneEscalationGrants("blob", NOW)).toEqual({})
  })
})

describe("escalationNote", () => {
  test("carries the redacted reason and the enforcement point", () => {
    expect(escalationNote("routine build cleanup", "approval gate")).toBe(
      "[jev] escalated by agent (approval gate): routine build cleanup",
    )
  })

  test("collapses whitespace, caps length, and survives an empty reason", () => {
    expect(escalationNote("  a\n\nb  ", "gate")).toBe("[jev] escalated by agent (gate): a b")
    expect(escalationNote("x".repeat(500), "gate").length).toBeLessThanOrEqual("[jev] escalated by agent (gate): ".length + 400)
    expect(escalationNote("   ", "gate")).toBe("[jev] escalated by agent (gate): (no reason given)")
  })

  test("grant TTL is a bounded day", () => {
    expect(ESCALATION_GRANT_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
