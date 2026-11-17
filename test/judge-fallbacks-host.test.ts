// Runtime test for the demoted primary's diagnostic: drive the plugin's real
// setup() with a fake host context and a stubbed fetch - no OpenCode, no
// network. The primary answers its init ping but fails every judged call
// with a 429; the fallback answers the first judged call and 500s on the
// second. The second call must exhaust on the fallback and still surface the
// primary's 429 wording (the fault stored when the primary was demoted),
// not the fallback's 500 - the invariant "an exhausted chain throws the
// primary's diagnostic" has to hold while the primary cools down.
//
// The fakeHost copy (test/provider-late.test.ts) is a minimal host: storage,
// session, event, model and transform namespaces; the endpoint comes from
// JEV_ENDPOINT so the provider registry is never consulted.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

const SCRATCH: string[] = []
const PINNED_ENV: Array<string> = []
let prevFetch: typeof globalThis.fetch | undefined

function pinEnv(pairs: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(pairs)) {
    if (!PINNED_ENV.includes(name)) PINNED_ENV.push(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

afterAll(() => {
  for (const name of PINNED_ENV) delete process.env[name]
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true })
  if (prevFetch) globalThis.fetch = prevFetch
})

function fakeHost() {
  const registeredTools: any[] = []
  const noop = () => undefined
  const asyncNoop = async () => undefined

  const makeEditor = () => ({
    namespace: (ns: any) => void ns,
    add: (tool: any) => registeredTools.push(tool),
    remove: noop,
    set: noop,
    update: noop,
  })

  const namespaces: Record<string, any> = {
    storage: {
      get: async () => undefined,
      set: asyncNoop,
      store: async (_key: string, shard: any) => shard?.initial,
    },
    session: {
      hook: async () => () => undefined,
      get: async () => undefined,
      context: async () => [],
      synthetic: asyncNoop,
      switchModel: asyncNoop,
    },
    event: { hook: async () => () => undefined, publish: asyncNoop },
    model: {
      list: async () => ({ data: [] }),
      get: async () => null,
      transform: async (fn: any) => {
        await fn(makeEditor())
      },
    },
    permission: {
      hook: async () => () => undefined,
      askDecision: async () => null,
    },
    integration: {
      transform: async (fn: any) => {
        await fn({ get: () => undefined, method: { update: noop }, update: noop })
      },
    },
    provider: {
      get: async () => {
        throw new Error("Provider not found: none")
      },
      list: async () => ({ data: [] }),
      transform: async (fn: any) => {
        await fn(makeEditor())
      },
      reload: asyncNoop,
    },
    command: { transform: async (fn: any) => { await fn(makeEditor()) } },
    agent: { transform: async (fn: any) => { await fn(makeEditor()) } },
    reference: { transform: async (fn: any) => { await fn(makeEditor()) } },
    skill: { transform: async (fn: any) => { await fn(makeEditor()) } },
    mcp: { transform: async (fn: any) => { await fn(makeEditor()) } },
    worktree: { transform: async (fn: any) => { await fn(makeEditor()) } },
    websearch: { transform: async (fn: any) => { await fn(makeEditor()) } },
    generate: { transform: async (fn: any) => { await fn(makeEditor()) } },
    credential: { transform: async (fn: any) => { await fn(makeEditor()) } },
    experimental: { transform: async (fn: any) => { await fn(makeEditor()) } },
    aisdk: { transform: async (fn: any) => { await fn(makeEditor()) } },
    vcs: { transform: async (fn: any) => { await fn(makeEditor()) } },
    shell: { transform: async (fn: any) => { await fn(makeEditor()) } },
    plugin: { transform: async (fn: any) => { await fn(makeEditor()) } },
    rpc: { call: asyncNoop },
    app: { info: async () => ({}) },
  }

  const ctx: any = {
    options: {
      model: "jev-primary",
      fallbacks: ["jev-fb"],
      screen: { enabled: true, mode: "annotate", tools: "all" },
    },
    location: { directory: "/tmp/jevtest" },
    client: undefined,
    tool: {
      transform: async (fn: any) => {
        await fn(makeEditor())
      },
      hook: async (_name: string, _listener: any) => () => undefined,
    },
  }
  for (const [name, ns] of Object.entries(namespaces)) ctx[name] = ns

  return { ctx, screenTool: () => registeredTools.find((t) => t?.name === "screen") }
}

describe("fallback chain across judged calls (host runtime)", () => {
  test("an exhausted chain throws the demoted primary's diagnostic", async () => {
    const home = mkdtempSync(join(tmpdir(), "jev-fallback-host-"))
    SCRATCH.push(home)
    pinEnv({
      PATH: "",
      HOME: home,
      XDG_DATA_HOME: home,
      TYPESAFE_API_KEY: "test-key",
      JEV_ENDPOINT: "http://127.0.0.1:8787",
      OPENCODE_BIN: undefined,
    })
    const judgedByModel: Record<string, number> = {}
    const reply = (questions: any) => ({
      answers: Object.fromEntries(
        Object.keys(questions ?? {}).map((id) => [id, { noul: 0.8 }]),
      ),
      usage: {},
    })
    prevFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      const target = String(url)
      if (target.startsWith("https://models.dev/")) {
        return new Response(JSON.stringify({ providers: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      const body = JSON.parse(init?.body ?? "{}")
      // The init ping is one noul availability question; it must answer ok
      // for both members so the judged path, not a ping skip, does the work.
      if (body?.questions?.["deploy-check"] !== undefined) {
        return new Response(JSON.stringify(reply(body.questions)), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      judgedByModel[body.model] = (judgedByModel[body.model] ?? 0) + 1
      if (body.model === "jev-primary") {
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      }
      // The fallback answers the first judged call, 500s on the second.
      if ((judgedByModel["jev-fb"] ?? 0) === 1) {
        return new Response(JSON.stringify(reply(body.questions)), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ message: "upstream error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }) as any

    const host = fakeHost()
    const setup = (plugin as any)?.setup
    expect(typeof setup).toBe("function")
    await setup(host.ctx)

    // First judged call: primary 429s, the fallback answers, the primary is
    // demoted for the cooldown with its own fault stored.
    await host.screenTool().execute(
      { summary: "probe one", content: "hello world one" },
      { sessionID: "ses_test" },
    )

    // Second judged call: the primary is cooling down and filtered, the
    // fallback 500s retryably, the chain is exhausted - the primary's 429
    // wording must surface, not the fallback's 500.
    let thrown = ""
    try {
      await host.screenTool().execute(
        { summary: "probe two", content: "hello world two" },
        { sessionID: "ses_test" },
      )
    } catch (err: any) {
      thrown = String(err?.message ?? err)
    }
    expect(thrown).toContain("429")
    expect(thrown).toContain("rate limited")
    expect(thrown).not.toContain("upstream error")
    // Both members were actually judged (no ping skip, no cache shortcut).
    expect(judgedByModel["jev-primary"]).toBe(1)
    expect(judgedByModel["jev-fb"]).toBe(2)
  })
})
