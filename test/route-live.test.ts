// Live routing tests: the plugin's REAL setup() rides a REAL judged turn.
// One routed prompt goes through candidate resolution, candidate facts, the
// System One POST, and the switch the answer applies against a fake OpenCode
// host - no judged fetch is stubbed anywhere.
//
// Opt-in: bun test runs hermetically by default. Run these with
//   JEV_LIVE=1 [JEV_ENDPOINT=...] [TYPESAFE_API_KEY / OPENCODE_API_KEY=...] bun test ./test/route-live.test.ts
// Without JEV_LIVE every test below is skipped and `plugin` is never
// imported, so no credential store is touched at all.
//
// Credential reality (what the operator chose by running this): HOME is
// pinned to scratch, so the `opencode auth export` subprocess reads an
// empty store; inside a nono-sandboxed bun process the nested CLI refuses
// outright (its own snapshot error). The plugin then falls back to its
// db-backed store read, which uses this file's real XDG_DATA_HOME: the
// freshly-refreshed Console session key, exactly the deployment the live
// run intends. The key itself is never logged or printed here.
//
// Model: the run command decides (JEV_MODEL), never the fixture; the
// plugin reads it from env or the `model` plugin option (jev-1.13-free
// stays the baked default).
//
// Every test owns explicit timeouts: bun's default 5s is far below a live
// turn's cost (models.dev catalog, leaderboard, benchmark pages, Go
// allowance table, the judged POST itself).
//
// Fixture-independent asserts (what these tests own):
//  - the judged POST is shaped { model, state, questions } and carries a
//    Bearer credential when the chain resolved one
//  - the outbound state carries the <candidate-models> rows for the
//    offered models: explicit candidates without slot text, a built pool
//    with "pool pick: <slot>" rows, and real catalog prices either way
//  - the plugin's restore contract is live: route-pool/<entry> is
//    persisted with exactly the pool the prompt built, and every apply
//    switch targets a member of that pool
//
// What is NOT pinned: which model the judge picks. A live judgment is not
// a fixture. Go-plan allowance text is likewise not pinned: that table
// loads as a background fetch after setup, so the first prompt may ride
// list prices instead - the plugin's own degraded-source contract (its
// pure-logic side is asserted in test/routing-defaults.test.ts).

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const RUN = process.env.JEV_LIVE === "1"
// HOME pin: even when the operator half-configures and the credential chain
// reaches the CLI store branch, the subprocess channel sees a scratch home,
// never the operator's own store.
const HOME = RUN ? mkdtempSync(join(tmpdir(), "jev-live-test-")) : ""
const PREV_HOME = process.env.HOME
if (RUN) {
  // XDG_DATA_HOME must stay UNPINNED: the db-backed store fallback is
  // the live credential channel the operator runs on (its env-var pin
  // would force the chain onto the expired legacy auth.json key
  // instead - observed live in this repo, 2026-11-06).
  process.env.HOME = HOME
}
// Every test file runs in one bun process, so the pin is undone here rather
// than in a test's finally: a per-test cleanup would delete the scratch dir
// while the later tests still run against it, and would leave HOME pointed
// at a dead path for every file loaded afterwards.
afterAll(() => {
  if (!RUN) return
  process.env.HOME = PREV_HOME
  rmSync(HOME, { recursive: true, force: true })
})

const plugin: any = RUN ? (await import("../src/index.ts")).default : undefined

// The pool fixture: eight real opencode-go entries (same models.dev source,
// 2026-11-06 15:14 UTC, cost/limit/variants lifted from that body). Eight
// matters: defaultPoolSplit hands the review split the whole window first,
// so a smaller pool starves the default kind into zero picks and the prompt
// logs "no usable candidates" - observed live in this repo, 2026-11-06.
// Variants list the levels each candidate offers; together the pool's picks
// cover the full routable effort order minus the "none" toggle.
const POOL_CATALOG = [
  {
    providerID: "opencode-go",
    id: "glm-5.3-flash",
    variants: ["low", "high", "max"],
    limit: { context: 1000000, output: 131072 },
    cost: { text: { input: { price: 0.15, cache: { read: 0.03 } }, output: { price: 0.5 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high", "max"] } },
  },
  {
    providerID: "opencode-go",
    id: "claude-haiku-5-5",
    variants: ["minimal", "low", "medium", "high"],
    limit: { context: 1000000, output: 128000 },
    cost: { text: { input: { price: 0.1, cache: { read: 0.01, write: 0.125 } }, output: { price: 0.5 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    providerID: "opencode-go",
    id: "qwen3.7-plus",
    variants: [],
    limit: { context: 1000000, output: 65536 },
    cost: { text: { input: { price: 0.4, cache: { read: 0.04, write: 0.5 } }, output: { price: 1.6 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    providerID: "opencode-go",
    id: "mimo-v2.6-flash",
    variants: ["low", "high"],
    limit: { context: 1048576, output: 131072 },
    cost: { text: { input: { price: 0.14, cache: { read: 0.0028 } }, output: { price: 0.28 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
    variants: ["medium"],
    limit: { context: 1000000, output: 384000 },
    cost: { text: { input: { price: 0.15, cache: { read: 0.003 } }, output: { price: 0.6 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    providerID: "opencode-go",
    id: "minimax-m3.1-flash",
    variants: ["medium", "high"],
    limit: { context: 1000000, output: 512000 },
    cost: { text: { input: { price: 0.15, cache: { read: 0.015 } }, output: { price: 0.6 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    providerID: "opencode-go",
    id: "gpt-6-luna",
    variants: ["medium", "high", "xhigh"],
    limit: { context: 1050000, output: 65536 },
    cost: { text: { input: { price: 0.1, cache: { read: 0.01 } }, output: { price: 0.5 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    providerID: "opencode-go",
    id: "deepseek-v4-pro",
    variants: ["xhigh"],
    limit: { context: 1000000, output: 65536 },
    cost: { text: { input: { price: 0.15, cache: { read: 0.03 } }, output: { price: 0.9 } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
]

type Outbound = { url: string; auth?: string; body?: string }

function makeHost(options: Record<string, any>, catalog: any[], contextRows: any[] = []) {
  const outbounds: Outbound[] = []
  const switchCalls: Array<{ providerID: string; id: string; variant?: string }> = []
  const kv = new Map<string, any>()
  let promptHook: ((event: any) => Promise<void>) | undefined

  const noopEditor = {
    namespace: () => undefined,
    add: () => undefined,
    set: () => undefined,
    update: () => undefined,
    remove: () => undefined,
    list: () => [],
    get: () => undefined,
    default: () => undefined,
  }

  const ctx: any = {
    options,
    location: { directory: "/tmp/jev-live" },
    app: { version: "0.0.0-live-test" },
    storage: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: any) => {
        kv.set(key, value)
      },
      remove: async (key: string) => {
        kv.delete(key)
      },
    },
    session: {
      hook: async (name: string, fn: any) => {
        if (name === "prompt") promptHook = fn
        return undefined
      },
      get: async () => ({ data: { model: { providerID: "opencode-decisions", id: "auto" } } }),
      context: async () => contextRows,
      switchModel: async (input: any) => {
        switchCalls.push({ ...input.model })
      },
      synthetic: async () => undefined,
      prompt: async () => ({}),
      generate: async () => ({ text: "" }),
      command: async () => ({}),
      compact: async () => ({}),
      create: async () => ({}),
    },
    tool: { transform: async (cb: any) => cb(noopEditor), hook: async () => undefined, list: async () => [] },
    command: { transform: async (cb: any) => cb(noopEditor), list: async () => [] },
    model: {
      list: async () => ({ data: catalog }),
      get: async () => null,
      transform: async (cb: any) => cb(noopEditor),
    },
    provider: { transform: async (cb: any) => cb(noopEditor), get: async () => null, list: async () => [] },
    event: { subscribe: async function* () {}, hook: async () => undefined, publish: async () => {} },
    permission: { hook: async () => undefined, askDecision: async () => null },
    rpc: { call: async () => null },
  }

  const prevFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(init?.method ?? "").toUpperCase() === "POST") {
      outbounds.push({
        url: String(url),
        auth: (init?.headers as any)?.Authorization,
        body: typeof init?.body === "string" ? init.body : undefined,
      })
    }
    return prevFetch(url, init)
  }) as any

  return {
    ctx,
    outbounds,
    switchCalls,
    kv,
    restore: () => {
      globalThis.fetch = prevFetch
    },
    firePrompt: async (text: string) => {
      if (!promptHook) throw new Error("prompt hook was not registered")
      await promptHook({ sessionID: "ses_live", prompt: { text } })
    },
  }
}

describe.skipIf(!RUN)("live routing: real System One endpoint", () => {
  // Floor scenario: explicit candidates, Console pool OFF. The judged call
  // happens, the judge reads a candidate row per offered model, and any
  // apply switch targets one of the offered models.
  test("explicit candidates reach the judged state; switches stay on the list", async () => {
    // Real catalog shapes lifted from the opencode-go models.dev body of
    // 2026-11-06 15:14 UTC. cost/limit matter: without them catalogModelFacts
    // drops the row (its >2-fields guard) and the judged state carries no
    // <candidate-models> block at all - observed live in this repo,
    // 2026-11-06. Variants span the whole routable effort order across the
    // three models (the routing pair's "#none" toggle is deliberately never
    // present): six levels, one fixture model per high-band step.
    const CAND = [
      {
        providerID: "opencode-go",
        id: "glm-5.3-flash",
        variants: ["high", "xhigh", "max"],
        limit: { context: 1000000, output: 131072 },
        cost: { text: { input: { price: 0.15, cache: { read: 0.03 } }, output: { price: 0.5 } } },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high", "max"] } },
      },
      {
        providerID: "opencode-go",
        id: "claude-haiku-5-5",
        variants: ["minimal", "low", "medium", "high"],
        limit: { context: 1000000, output: 128000 },
        cost: { text: { input: { price: 0.1, cache: { read: 0.01, write: 0.125 } }, output: { price: 0.5 } } },
        capabilities: { tools: { supported: true }, reasoning: { supported: true } },
      },
      {
        providerID: "opencode-go",
        id: "mimo-v2.6-flash",
        variants: [],
        limit: { context: 1048576, output: 131072 },
        cost: { text: { input: { price: 0.14, cache: { read: 0.0028 } }, output: { price: 0.28 } } },
        capabilities: { tools: { supported: true }, reasoning: { supported: true } },
      },
    ]
    const DOCKED = CAND.map((c) => `${c.providerID}/${c.id}`)
    const host = makeHost({ provider: "opencode-go", routes: { default: { candidates: DOCKED, pool: false } } }, CAND)
    try {
      await plugin.setup(host.ctx)
      await host.firePrompt("add a log line to the service")
      const call = host.outbounds.find((o) => o.body && o.body.includes("<candidate-models>"))
      expect(call).toBeDefined()
      expect(call!.auth ?? "").toMatch(/^Bearer /)
      const body = JSON.parse(call!.body!)
      expect(typeof body.model).toBe("string")
      expect(typeof body.state).toBe("string")
      expect(Object.keys(body.questions)).toContain("route")
      for (const c of DOCKED) expect(body.state).toContain(c)
      expect(body.state).not.toContain("pool pick: ")
      // Every offered pair must be exactly a listing-level pair of a
      // fixture candidate, and each fixture candidate must have its FULL
      // listed set offered: the pair question never partially trims a
      // model's levels and never offers the "none" toggle id (router
      // contract) or the auto pseudo entry (autoMode keeps current out).
      const offered = Object.keys(body.questions.route.criteria)
      for (const c of CAND) {
        const prefix = `${c.providerID}/${c.id}`
        const levels = c.variants.length > 0 ? c.variants : ["default"]
        for (const level of levels) expect(offered).toContain(`${prefix}#${level}`)
        for (const key of offered) if (key.startsWith(prefix)) expect(levels).toContain(key.slice(prefix.length + 1))
      }
      expect(offered.some((key) => key.includes("#none"))).toBe(false)
      expect(offered.some((key) => key.includes("opencode-decisions/"))).toBe(false)
      for (const sw of host.switchCalls) {
        expect(sw.providerID).not.toBe("opencode-decisions")
        expect(DOCKED).toContain(`${sw.providerID}/${sw.id}`)
      }
    } finally {
      host.restore()
    }
  }, 45_000)

  // Console pool ON with real opencode-go entries: defaultPoolSplit ranks
  // them by the live public data, tags its picks, the judged state carries
  // slot rows (and Go-plan facts when the background allowance table has
  // landed), and route-pool/<entry> is persisted with exactly the pool the
  // prompt used. Every apply switch must be a member of that pool, which
  // is the restore contract this plugin ships today.
  test("the Go pool is built live; slot rows and the persisted pool ride", async () => {
    const host = makeHost({ provider: "opencode-go", routes: { default: { pool: true } } }, POOL_CATALOG)
    try {
      await plugin.setup(host.ctx)
      await host.firePrompt("debug the failing test across two modules")
      const persisted = await host.kv.get("route-pool/opencode-decisions/auto")
      expect(Array.isArray(persisted)).toBe(true)
      expect(persisted.length).toBeGreaterThan(0)
      const call = host.outbounds.find((o) => o.body && o.body.includes("<candidate-models>"))
      expect(call).toBeDefined()
      expect(call!.auth ?? "").toMatch(/^Bearer /)
      const body = JSON.parse(call!.body!)
      expect(body.state).toContain("pool pick: ")
      // Real catalog prices ride the block in the facts-row form
      // `in $X/Mtok, out $Y/Mtok`, with the Go-plan effective prices when
      // the background allowance table has landed.
      expect(body.state).toContain("/Mtok, out")
      for (const sw of host.switchCalls) {
        expect(sw.providerID).not.toBe("opencode-decisions")
        expect(persisted).toContain(`${sw.providerID}/${sw.id}`)
      }
    } finally {
      host.restore()
    }
  }, 60_000)

  // The three model decisions the router owns, each live against the same
  // built pool:
  //  - switch: minConfidence at the clamp floor (0.26), so any judged pick
  //    with real confidence applies; the "route: ... -> ... (jev pick ..."
  //    log and the applied (model, level) pair are decision evidence
  //  - keep: minConfidence at the clamp ceiling (0.99), so any judged pick
  //    below it is kept; the "uncertain ... - keeping" log is deterministic
  //  - stand-down (manual): the transcript's newest real model-switched row
  //    is a foreign pick, so auto stands down, no judged call runs, and the
  //    judged state carries no options
  // Every switch these paths apply targets a member of the persisted pool,
  // and any (model, level) pair it applies is a pair the judged question
  // itself offered ("all effort levels" per pick, and no "#none" toggle or
  // auto-entry key anywhere).
  test("covers switch, keep and manual stand-down over the built pool", async () => {
    const captured: string[] = []
    const origLog = console.log
    console.log = (...parts: any[]) => {
      captured.push(String(parts[0] ?? ""))
      origLog(...parts)
    }
    try {
      // -- switch host: pool on, floor minConfidence ----------------------
      const host = makeHost(
        { provider: "opencode-go", routes: { default: { pool: true, minConfidence: 0.26 } } },
        POOL_CATALOG,
      )
      try {
        await plugin.setup(host.ctx)
        for (const prompt of [
          "one-line formatting cleanup in the service",
          "refactor the session parser into two modules",
          "debug the failing scheduler test",
        ]) {
          const before = host.switchCalls.length
          const logsAt = captured.length
          await host.firePrompt(prompt)
          const judged = host.outbounds.some((o) => o.body?.includes("<user>"))
          expect(judged).toBe(true)
          const switched = host.switchCalls.slice(before)
          const logs = captured.slice(logsAt)
          const pickLog = logs.some((l) => l.includes("jev pick"))
          const keepLog = logs.some((l) => l.includes("uncertain"))
          expect(pickLog || keepLog).toBe(true)
          expect(pickLog && keepLog).toBe(false) // one outcome per prompt
          const persisted = await host.kv.get("route-pool/opencode-decisions/auto")
          expect(Array.isArray(persisted)).toBe(true)
          expect(persisted.length).toBeGreaterThan(0)
          for (const call of switched) {
            expect(call.providerID).not.toBe("opencode-decisions")
            expect(persisted).toContain(`${call.providerID}/${call.id}`)
          }
          if (pickLog) {
            // an applied pair is a listed pair of the switched model
            for (const call of switched) {
              const row = POOL_CATALOG.find((c) => c.id === call.id)
              expect(row).toBeDefined()
              expect(row!.variants.length > 0 ? row!.variants : ["default"]).toContain(call.variant ?? "default")
            }
          }
        }
      } finally {
        host.restore()
      }

      // -- keep host: pool on, ceiling minConfidence ----------------------
      const keep = makeHost({ provider: "opencode-go", routes: { default: { pool: true, minConfidence: 0.99 } } }, POOL_CATALOG)
      try {
        const logsAt = captured.length
        await plugin.setup(keep.ctx)
        await keep.firePrompt("write a summary of the change so far")
        const judged = keep.outbounds.some((o) => o.body?.includes("<user>"))
        expect(judged).toBe(true)
        // A judged call happened, and the router's answer was kept: its
        // uncertainty log is deterministic at a ceiling threshold.
        const keepLog = captured.slice(logsAt).some((l) => l.includes("uncertain"))
        expect(keepLog).toBe(true)
        const persisted = await keep.kv.get("route-pool/opencode-decisions/auto")
        for (const call of keep.switchCalls) {
          expect(call.providerID).not.toBe("opencode-decisions")
          expect(persisted).toContain(`${call.providerID}/${call.id}`)
          // The fail-safe's own last-resort switch is a plain model switch
          // (no variant, or the canonical "default" spelling), never a
          // judged pair pick.
          expect(call.variant === undefined || call.variant === "default").toBe(true)
        }
      } finally {
        keep.restore()
      }

      // -- stand-down host: the newest row is a foreign manual pick -------
      const MANUAL_ROWS = [
        {
          type: "model-switched",
          model: { providerID: "opencode-go", id: "mimo-v2.6-flash", variant: "low" },
          previous: { providerID: "opencode-decisions", id: "auto" },
        },
      ]
      const stand = makeHost(
        { provider: "opencode-go", routes: { default: { pool: true, minConfidence: 0.26 } } },
        POOL_CATALOG,
        MANUAL_ROWS,
      )
      try {
        const logsAt = captured.length
        await plugin.setup(stand.ctx)
        await stand.firePrompt("refactor the session parser")
        // Stand-down: the judged call does not run at all.
        expect(stand.outbounds.some((o) => o.body?.includes("<user>"))).toBe(false)
        const logs = captured.slice(logsAt)
        expect(logs.some((l) => l.includes("manual pick"))).toBe(true)
        expect(logs.some((l) => l.includes("stood down"))).toBe(true)
        // Whatever the fail-safe applies while parked is still pool-legal.
        const persisted = await stand.kv.get("route-pool/opencode-decisions/auto")
        for (const call of stand.switchCalls) {
          expect(call.providerID).not.toBe("opencode-decisions")
          expect(Array.isArray(persisted)).toBe(true)
          expect(persisted).toContain(`${call.providerID}/${call.id}`)
        }
      } finally {
        stand.restore()
      }
    } finally {
      console.log = origLog
    }
  }, 90_000)
})
