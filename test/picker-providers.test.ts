// Runtime integration test for the multi-provider /jev-models picker: drive
// the plugin's real setup() with a fake host context - no OpenCode, no
// network (fetch is stubbed to canned catalog + System One bodies), no host
// credential store (PATH is emptied so no CLI binary spawns, XDG_DATA_HOME
// points at a fresh scratch dir so the db-backed store channel is empty).
//
// Simulated providers, each with its own System One route and key chain:
//  - "opencode" (Console): decision catalog record at console.test, key
//    OPENCODE_API_KEY
//  - "opencode-go": decision rows on the Go models endpoint at go.test, key
//    OPENCODE_GO_API_KEY
//  - "otherp" (host-registered): decision catalog record at host.test, key
//    TYPESAFE_API_KEY
//
// What the scenarios pin down:
//  1. describe() lists the deployment's models bare (group OpenCode) plus
//     every other configured provider's models as "<provider>/<id>" under its
//     own group
//  2. a pinned ref pings and judges on that provider's route with that
//     provider's key, and the request body carries the bare model id
//  3. the judgment cache keys stay per (endpoint, model)
//  4. a provider without a credential never appears
//  5. a custom "models" option stays one flat list
//  6. under JEV_ENDPOINT every ref keeps the override: the ref id goes in the
//     request body verbatim and fails closed at the endpoint's own diagnostic

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

interface Fetch {
  url: string
  auth: string | undefined
  model: unknown
  ping: boolean
}
const FETCHES: Fetch[] = []
const SANDLE_ENV: Array<string> = []
const SCRATCH: string[] = []

function pinEnv(pairs: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(pairs)) {
    if (!SANDLE_ENV.includes(name)) SANDLE_ENV.push(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

afterAll(() => {
  for (const name of SANDLE_ENV) delete process.env[name]
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true })
})

const DECISION_CATALOG = {
  providers: {
    opencode: {
      models: { "jev-c1": { type: "decision", provider: { api: "https://console.test/api" } } },
    },
    otherp: {
      models: {
        "jev-h1": { type: "decision", provider: { api: "https://host.test/v1" } },
        "jev-h2": { type: "decision", provider: { api: "https://host.test/v1" } },
      },
    },
  },
}

const GO_CATALOG = {
  data: [
    {
      id: "jev-1.14",
      type: "decision",
      api: { systemone: { base_url: "https://go.test/sysone/v1" } },
      go: { monthly_usage: { go: 10 } },
    },
    { id: "glm-5.3", type: "chat" },
  ],
}

function stubFetch(): void {
  const prev = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    const target = String(url)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
    if (target.startsWith("https://models.dev/")) {
      return new Response(JSON.stringify(DECISION_CATALOG), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (target.startsWith("https://opencode.ai/inference/go/v1/models")) {
      return new Response(JSON.stringify(GO_CATALOG), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (target.startsWith("https://opencode.ai/data/")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    // Record every deployment-shaped request before answering: discovery
    // fetches are helpers, not pings, so only these land in FETCHES.
    FETCHES.push({
      url: target,
      auth: (init?.headers as any)?.Authorization,
      model: body.model,
      // toQuestionMap serializes questions keyed by id, not as an array.
      ping: body?.questions?.["deploy-check"] !== undefined,
    })
    // The JEV_ENDPOINT override knows no provider-prefixed ids: it answers
    // with the endpoint's own model diagnostic, fail-closed.
    if (target.startsWith("https://override.test/") && String(body?.model ?? "").includes("/")) {
      return new Response(JSON.stringify({ error: { message: "unknown model" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ answers: { q: "yes" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  ;(stubFetch as any).restore = () => {
    globalThis.fetch = prev
  }
}

async function boot(options: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  const home = mkdtempSync(join(tmpdir(), "jev-picker-test-"))
  SCRATCH.push(home)
  pinEnv({
    PATH: "",
    XDG_DATA_HOME: home,
    JEV_ENDPOINT: undefined,
    OPENCODE_BIN: undefined,
    OPENCODE_API_KEY: undefined,
    OPENCODE_GO_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  })
  pinEnv(env)
  const storage = new Map<string, any>()
  const registeredTools: any[] = []
  const registeredRpc: Array<{ descriptor: any; methods: any }> = []
  const noop = () => undefined
  const makeEditor = () => ({
    namespace: noop,
    add: (tool: any) => registeredTools.push(tool),
    remove: noop,
    set: noop,
    update: noop,
  })
  const transformNs = async (fn: any) => {
    await fn(makeEditor())
  }
  const ctx: any = {
    options,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: any) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      store: async (_key: string, shard: any) => shard?.initial,
    },
    rpc: {
      register: async (descriptor: any, methods: any) => {
        registeredRpc.push({ descriptor, methods })
        return {}
      },
    },
    tool: { transform: transformNs, hook: async () => () => undefined },
    model: { transform: transformNs, list: async () => ({ data: [] }), get: async () => null },
    provider: { transform: transformNs, get: async () => null, list: async () => ({ data: [] }) },
    session: {
      hook: async () => () => undefined,
      get: async () => undefined,
      context: async () => [],
      synthetic: async () => undefined,
      switchModel: async () => undefined,
    },
    event: { hook: async () => () => undefined, publish: async () => undefined },
    permission: { hook: async () => () => undefined, askDecision: async () => null },
    integration: { transform: transformNs },
    command: { transform: transformNs },
    agent: { transform: transformNs },
    reference: { transform: transformNs },
    skill: { transform: transformNs },
    mcp: { transform: transformNs },
    worktree: { transform: transformNs },
    websearch: { transform: transformNs },
    generate: { transform: transformNs },
    credential: { transform: transformNs },
    experimental: { transform: transformNs },
    client: {},
  }
  stubFetch()
  // Pin the deployment explicitly: other test files leave module state
  // (OPTIONS_PROVIDER) pointing at their own fake provider, and this file
  // must not inherit it.
  await (plugin as any).setup({ ...ctx, options: { provider: "opencode", ...options } })
  const rpc = registeredRpc.find((r) => r.descriptor?.id === "jev-config")
  expect(rpc).toBeDefined()
  const decide = registeredTools.find((t) => t?.name === "decide")
  expect(decide).toBeDefined()
  return { ctx, storage, describe: rpc!.methods.describe, set: rpc!.methods.set, decide }
}

const KEYS = {
  OPENCODE_API_KEY: "console-key",
  OPENCODE_GO_API_KEY: "go-key",
  TYPESAFE_API_KEY: "host-key",
}

const JUDGE_QUESTIONS = [{ id: "q1", type: "noul", instructions: "Test judgment - not a real one." }]

async function judge(
  decide: any,
  sessionID: string,
): Promise<{ fetches: number; content: any }> {
  const before = FETCHES.length
  const result = await decide.execute(
    { summary: "integration probe", state: { probe: "state" }, questions: JUDGE_QUESTIONS },
    { sessionID, signal: AbortSignal.timeout(10_000) },
  )
  return { fetches: FETCHES.length - before, content: JSON.parse(result.content) }
}

describe("multi-provider /jev-models picker (fake host, no network)", () => {
  test("describe lists every configured provider's decision models in groups", async () => {
    const boot1 = await boot({}, KEYS)
    try {
      const info = await boot1.describe({ sessionID: "ses_x" })
      expect(info.models).toEqual([
        { id: "jev-c1", group: "OpenCode" },
        { id: "opencode-go/jev-1.14", group: "OpenCode Go" },
        { id: "otherp/jev-h1", group: "otherp" },
        { id: "otherp/jev-h2", group: "otherp" },
      ])
    } finally {
      ;(stubFetch as any).restore()
    }
  })

  test("a pinned ref pings and judges on that provider's route with its own key", async () => {
    const boot1 = await boot({}, KEYS)
    try {
      const hostPings = () => FETCHES.filter((f) => f.url === "https://host.test/v1/systemone")
      const goPings = () => FETCHES.filter((f) => f.url === "https://go.test/sysone/v1/systemone")

      // The pin's ping goes to the host provider's route with its key, and
      // the request body carries the bare model id.
      expect(await boot1.set({ sessionID: "ses_a", model: "otherp/jev-h1" })).toEqual({ ok: true })
      expect(hostPings().length).toBe(1)
      expect(hostPings()[0]!.auth).toBe("Bearer host-key")
      expect(hostPings()[0]!.model).toBe("jev-h1")
      expect(hostPings()[0]!.ping).toBe(true)

      // The judged call rides the same route and key.
      const first = await judge(boot1.decide, "ses_a")
      expect(first.fetches).toBe(1)
      const judged = hostPings().at(-1)!
      expect(judged.auth).toBe("Bearer host-key")
      expect(judged.model).toBe("jev-h1")
      expect(judged.ping).toBe(false)
      expect(first.content.answers).toEqual({ q: "yes" })
      expect(first.content.cached).toBe(false)

      // A repeat is served from the judgment cache without a fetch.
      const again = await judge(boot1.decide, "ses_a")
      expect(again.fetches).toBe(0)
      expect(again.content.cached).toBe(true)

      // The Go ref judges on the Go route with the Go key - never the
      // Console key, and its cache key stays separate.
      expect(await boot1.set({ sessionID: "ses_b", model: "opencode-go/jev-1.14" })).toEqual({ ok: true })
      expect(goPings().length).toBe(1)
      expect(goPings()[0]!.auth).toBe("Bearer go-key")
      expect(goPings()[0]!.model).toBe("jev-1.14")
      const goJudged = await judge(boot1.decide, "ses_b")
      expect(goJudged.fetches).toBe(1)
      const goCall = goPings().at(-1)!
      expect(goCall.auth).toBe("Bearer go-key")
      expect(goCall.model).toBe("jev-1.14")
      expect(goCall.ping).toBe(false)

      const cacheKeys = [...boot1.storage.keys()].filter((k) => k.startsWith("judgment/"))
      expect(cacheKeys.length).toBe(2)
      expect(new Set(cacheKeys).size).toBe(2)
    } finally {
      ;(stubFetch as any).restore()
    }
  })

  test("describe reports the pick it served", async () => {
    const boot1 = await boot({}, KEYS)
    try {
      await boot1.set({ sessionID: "ses_c", model: "otherp/jev-h2" })
      const info = await boot1.describe({ sessionID: "ses_c" })
      expect(info.pick).toBe("otherp/jev-h2")
    } finally {
      ;(stubFetch as any).restore()
    }
  })

  test("a provider without a credential never appears", async () => {
    const boot1 = await boot({}, { ...KEYS, TYPESAFE_API_KEY: undefined })
    try {
      const info = await boot1.describe({ sessionID: "ses_x" })
      expect(info.models.map((m: any) => m.id)).toEqual(["jev-c1", "opencode-go/jev-1.14"])
    } finally {
      ;(stubFetch as any).restore()
    }
  })

  test("a custom models option stays one flat list", async () => {
    const boot1 = await boot({ models: ["jev-x"] }, KEYS)
    try {
      const info = await boot1.describe({ sessionID: "ses_x" })
      expect(info.models).toEqual([{ id: "jev-x" }])
    } finally {
      ;(stubFetch as any).restore()
    }
  })

  test("under JEV_ENDPOINT every ref keeps the override and fails closed", async () => {
    const boot1 = await boot(
      {},
      { ...KEYS, JEV_ENDPOINT: "https://override.test/v1/systemone" },
    )
    try {
      // The ref is sent verbatim; the endpoint's own model diagnostic is the
      // failure, never a silently wrong route.
      const result = await boot1.set({ sessionID: "ses_d", model: "otherp/jev-h1" })
      expect(result.ok).toBe(false)
      const refPing = FETCHES.filter((f) => f.url === "https://override.test/v1/systemone" && f.model === "otherp/jev-h1")
      expect(refPing.length).toBe(1)
      expect(refPing[0]!.ping).toBe(true)
    } finally {
      ;(stubFetch as any).restore()
    }
  })
})
