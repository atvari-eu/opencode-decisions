import { describe, expect, test } from "bun:test"
import { candidateKey, defaultPoolSplit, poolCut, rankPoolOrders } from "../src/logic"

/** Benchmarked models with a flat token cost, so the cheap axis ties by id
 * and the strong axis is the only thing that separates them. */
const benched = (
  modelID: string,
  g1: number,
  g2: number,
  extra: { canonicalID?: string; inputCost?: number; outputCost?: number } = {},
) => ({
  providerID: "opencode",
  modelID,
  ...(extra.canonicalID ? { canonicalID: extra.canonicalID } : {}),
  inputCost: extra.inputCost ?? 1,
  outputCost: extra.outputCost ?? 1,
  benchmarks: [
    { name: "g1", score: g1 },
    { name: "g2", score: g2 },
  ],
})

// g2 tops at 60 inside the window, so P (10/20 + 60/60) outscores Q (20/20 +
// 50/60) on the full catalog, but the window-relative scores flip them: g1
// maxes at 20, which lifts Q's g1 share to 1.
const P = benched("p", 10, 60)
const Q = benched("q", 20, 50)
const R = benched("r", 5, 5)
// Not on the leaderboard, so outside every window, yet catalog-wide its
// benchmark tops the pool (0.6).
const T = benched("t", 100, 30)
const POOL = [P, Q, R, T]

const noReview = { cheap: 0, popular: 0, strong: 0, topK: 18, minContext: 0 }

describe("rankPoolOrders", () => {
  test("strong is window-first: outside-window strength cannot jump the line", () => {
    const orders = rankPoolOrders(POOL, ["p", "q", "r"], { review: noReview })
    // The window is the leaderboard top 18; T is unranked and stays last even
    // though its catalog-wide benchmark score is the pool's highest.
    expect(orders.strongWindow).toBe(3)
    expect(orders.strong.map((m) => m.modelID)).toEqual(["q", "p", "r", "t"])
  })

  test("the first strong entry equals poolCut's pick over the same window", () => {
    const orders = rankPoolOrders(POOL, ["p", "q", "r"], { review: noReview })
    const cut = poolCut(POOL, ["p", "q", "r"], { cheap: 0, popular: 0, strong: 1, topK: 18, minContext: 0 })
    expect(cut.map(candidateKey)).toEqual([candidateKey(orders.strong[0]!)])
  })

  test("review picks are subtracted from the strong window like the cut does", () => {
    // Six equal-cost models; the built-in review cut (1 popular + 2 strong)
    // takes a, d and e, so the default window the strong axis scores is
    // b, c and f.
    const mk = (modelID: string, g: number) => ({
      providerID: "opencode",
      modelID,
      inputCost: 1,
      outputCost: 1,
      benchmarks: [{ name: "g", score: g }],
    })
    const pool = ["a:50", "b:40", "c:30", "d:100", "e:90", "f:20"].map((row) => {
      const [id, score] = row.split(":")
      return mk(id!, Number(score))
    })
    const board = ["a", "b", "c", "d", "e", "f"]
    const orders = rankPoolOrders(pool, board)
    const split = defaultPoolSplit(pool, board)
    expect(orders.strongWindow).toBe(3)
    expect(orders.strong.map((m) => m.modelID)).toEqual(["b", "c", "f", "d", "e", "a"])
    // The default cut's strong pick is the strongest of its window's
    // remainder, so it sits at its window-relative strength position.
    expect(split.default.filter((m) => m.poolSlot === "strong").map((m) => m.modelID)).toEqual(["f"])
    expect(orders.strong.findIndex((m) => m.modelID === "f")).toBeLessThan(orders.strongWindow)
  })

  test("cheap ties by model id and orders unknown costs last", () => {
    const b = benched("b", 1, 1)
    const a = benched("a", 1, 1)
    const c = benched("c", 1, 1, { inputCost: 2 })
    const noPrice = { providerID: "opencode", modelID: "z" }
    const orders = rankPoolOrders([b, a, c, noPrice], [])
    expect(orders.cheap.map((m) => m.modelID)).toEqual(["a", "b", "c", "z"])
  })

  test("popular matches the leaderboard through canonical ids", () => {
    const x = benched("mx", 1, 1, { canonicalID: "lab/mx-upstream" })
    const y = benched("other", 1, 1)
    const z = benched("mz", 1, 1)
    const orders = rankPoolOrders([z, x, y], ["mx-upstream", "other"])
    expect(orders.popular.map((m) => m.modelID)).toEqual(["mx", "other", "mz"])
  })

  test("consent-blocked models are listed, never ranked", () => {
    const free = benched("p-free", 1, 1, { inputCost: 0, outputCost: 0 })
    const orders = rankPoolOrders([P, free], ["p", "p-free"], {
      review: noReview,
      consent: { paid: true, free: false },
    })
    expect(orders.cheap.map((m) => m.modelID)).toEqual(["p"])
    expect(orders.popular.map((m) => m.modelID)).toEqual(["p"])
    expect(orders.strong.map((m) => m.modelID)).toEqual(["p"])
    expect(orders.strongWindow).toBe(1)
    expect(orders.consentBlocked.map((m) => m.modelID)).toEqual(["p-free"])
  })

  test("an empty pool ranks nothing", () => {
    const orders = rankPoolOrders([], ["p"])
    expect(orders.cheap).toEqual([])
    expect(orders.popular).toEqual([])
    expect(orders.strong).toEqual([])
    expect(orders.strongWindow).toBe(0)
    expect(orders.consentBlocked).toEqual([])
  })
})
