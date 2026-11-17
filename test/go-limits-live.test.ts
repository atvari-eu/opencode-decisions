// Live contract check for the OpenCode Go allowance source.
//
// The plugin's ONLY source for monthly limits is the Go models endpoint
// (GO_LIMITS_URL -> parseGoMonthlyLimits): the docs page it used to scrape
// dropped its limits table without any test noticing - observed in this
// repo, 2026-11-17, when every load failed and Go models ranked by list
// price. A hermetic fixture can pin our parser, never upstream's shape, so
// this file reads the real endpoint and pins what both sides depend on.
//
// Opt-in like test/route-live.test.ts: run with
//   JEV_LIVE=1 bun test ./test/go-limits-live.test.ts
// No credential is needed - the endpoint is public - unlike route-live's
// judged POSTs, so this file is safe to run on its own.

import { describe, expect, test } from "bun:test"
import {
  GO_LIMITS_URL,
  GO_PLANS,
  modelNameKey,
  parseGoMonthlyLimits,
  type GoPlan,
} from "../src/logic"

const RUN = process.env.JEV_LIVE === "1"
const TIMEOUT = 30_000

describe.skipIf(!RUN)("live Go allowance source", () => {
  test("every plan parses a non-empty allowance map", async () => {
    const response = await fetch(GO_LIMITS_URL, { signal: AbortSignal.timeout(15_000) })
    expect(response.ok).toBe(true)
    const body = await response.json()
    const ids = (body?.data ?? []).map((entry: any) => entry?.id).filter((id: any) => typeof id === "string")
    expect(ids.length).toBeGreaterThan(0)

    const plans = Object.keys(GO_PLANS) as GoPlan[]
    for (const plan of plans) {
      const limits = parseGoMonthlyLimits(body, plan)
      // An empty map here means every routed Go model silently falls back
      // to list price - the exact degradation this file exists to catch.
      expect(limits.size).toBeGreaterThan(0)
    }
  }, TIMEOUT)

  test("every allowance is reachable from a Go catalog id", async () => {
    // The plugin looks allowances up as GO_LIMITS.get(modelNameKey(id)) with
    // the id its catalog lists, so an id rename on either side drops the
    // allowance without any error anywhere.
    const [body, catalog] = await Promise.all([
      fetch(GO_LIMITS_URL, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()),
      fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()),
    ])
    const catalogKeys = new Set(
      Object.keys(catalog?.["opencode-go"]?.models ?? {}).map((id) => modelNameKey(id)),
    )
    expect(catalogKeys.size).toBeGreaterThan(0)

    const limits = parseGoMonthlyLimits(body, "go")
    expect(limits.size).toBeGreaterThan(0)
    const unreachable = [...limits.keys()].filter((key) => !catalogKeys.has(key))
    expect(unreachable).toEqual([])
  }, TIMEOUT)
})
