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

// g1 maxes at 20 inside the window, which lifts Q's g1 share to 1, so the
// window-relative scores rank Q over P; on the full catalog P would win.
const P = benched("p", 10, 60)
const Q = benched("q", 20, 50)
const R = benched("r", 5, 5)
// Not on the leaderboard, so outside the window; its benchmark would top the
// full catalog (0.6) but the ranking must not show it.
const T = benched("t", 100, 30)
const POOL = [P, Q, R, T]

const noReview = { cheap: 0, popular: 0, strong: 0, topK: 18, minContext: 0 }

describe("rankPoolOrders", () => {
  test("ranks only the routing window: outside-window models are invisible", () => {
    const orders = rankPoolOrders(POOL, ["p", "q", "r"], { review: noReview })
    // The window is the leaderboard top 18; T is unranked and must not appear
    // even though its catalog-wide benchmark score is the pool's highest.
    expect(orders.cheap.map((m) => m.modelID)).toEqual(["p", "q", "r"])
    expect(orders.popular.map((m) => m.modelID)).toEqual(["p", "q", "r"])
    expect(orders.strong.map((m) => m.modelID)).toEqual(["q", "p", "r"])
  })

  test("the first strong entry equals poolCut's pick over the same window", () => {
    const orders = rankPoolOrders(POOL, ["p", "q", "r"], { review: noReview })
    const cut = poolCut(POOL, ["p", "q", "r"], { cheap: 0, popular: 0, strong: 1, topK: 18, minContext: 0 })
    expect(cut.map(candidateKey)).toEqual([candidateKey(orders.strong[0]!)])
  })

  test("ranks the full window: other cuts' picks stay visible", () => {
    // Six equal-cost models; the built-in review cut (1 popular + 2 strong)
    // takes a, d and e, but the ranking is over the whole window, so the
    // review picks keep their strength positions.
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
    expect(orders.cheap.map((m) => m.modelID)).toEqual(["a", "b", "c", "d", "e", "f"])
    expect(orders.popular.map((m) => m.modelID)).toEqual(["a", "b", "c", "d", "e", "f"])
    expect(orders.strong.map((m) => m.modelID)).toEqual(["d", "e", "a", "b", "c", "f"])
    // The default cut still subtracts the review picks from its own window,
    // so its strong pick stays the strongest of the remainder.
    expect(split.default.filter((m) => m.poolSlot === "strong").map((m) => m.modelID)).toEqual(["f"])
    expect(orders.strong[5]!.modelID).toBe("f")
  })

  test("cheap ties by model id and orders unknown costs last", () => {
    const b = benched("b", 1, 1)
    const a = benched("a", 1, 1)
    const c = benched("c", 1, 1, { inputCost: 2 })
    const noPrice = { providerID: "opencode", modelID: "z" }
    // No leaderboard: the window fails open to the whole pool by cost.
    const orders = rankPoolOrders([b, a, c, noPrice], [], { review: noReview })
    expect(orders.cheap.map((m) => m.modelID)).toEqual(["a", "b", "c", "z"])
    expect(orders.strong.map((m) => m.modelID)).toEqual(["a", "b", "c", "z"])
  })

  test("popular is the window in leaderboard order, canonical ids matched", () => {
    const x = benched("mx", 1, 1, { canonicalID: "lab/mx-upstream" })
    const y = benched("other", 1, 1)
    const z = benched("mz", 1, 1)
    const orders = rankPoolOrders([z, x, y], ["mx-upstream", "other"], { review: noReview })
    // The window matches x through its canonical id; z is unranked and stays
    // out of every list.
    expect(orders.popular.map((m) => m.modelID)).toEqual(["mx", "other"])
    expect(orders.cheap.map((m) => m.modelID)).toEqual(["mx", "other"])
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
    expect(orders.consentBlocked.map((m) => m.modelID)).toEqual(["p-free"])
  })

  test("an empty pool ranks nothing", () => {
    const orders = rankPoolOrders([], ["p"])
    expect(orders.cheap).toEqual([])
    expect(orders.popular).toEqual([])
    expect(orders.strong).toEqual([])
    expect(orders.consentBlocked).toEqual([])
  })
})
