// Runtime regression tests for the idle resting reset (the "sometimes it does
// not go back to Auto" cluster, 2026-11-18).
//
// The old gate demanded the transcript's newest `model-switched` row match the
// pin on BOTH ends, so a session with no readable context (or a drifted `from`)
// was stranded off its entry: routing disengaged, picker showing the real
// model. This harness is built to be exactly that hostile case - `session.context`
// always returns [] - so every assertion below fails against the old gate and
// passes only when provenance comes from the live selection plus a pin every
// plugin switch records.
//
// The judge endpoint is a refused port (fast failure, no network), so routing
// recovers through the last-resort switch, never a verdict.

import { afterAll, describe, expect, test } from "bun:test"

process.env.JEV_ENDPOINT = "http://127.0.0.1:1/"
process.env.OPENCODE_BIN = "/bin/false"
process.env.XDG_DATA_HOME = `/tmp/jev-nostore-${process.pid}`

const AUTO = { providerID: "opencode-decisions", id: "auto" }
const SESSION = "ses_rest"
const IDLE = { type: "session.execution.succeeded", data: { sessionID: SESSION } }

function makeHost(opts: { catalog?: any[]; candidates?: string[]; compaction?: boolean } = {}) {
  const calls: Array<{ providerID: string; id: string; variant?: string }> = []
  const store = new Map<string, any>()
  const hooks = new Map<string, (event: any) => Promise<void>>()
  let currentModel: any = AUTO
  let subscribeCount = 0

  // One independent stream per subscriber: several features subscribe at once
  // and must not steal each other's events.
  type Sub = { queue: any[]; wake?: () => void; closed: boolean }
  const subs: Sub[] = []
  const wakeAll = (): void => {
    for (const sub of subs) {
      const wake = sub.wake
      sub.wake = undefined
      wake?.()
    }
  }
  const endStreams = (): void => {
    for (const sub of subs) sub.closed = true
    wakeAll()
  }
  async function* newStream(): AsyncGenerator<any> {
    const sub: Sub = { queue: [], closed: false }
    subs.push(sub)
    try {
      while (true) {
        while (sub.queue.length > 0) yield sub.queue.shift()
        if (sub.closed) return
        await new Promise<void>((resolve) => {
          sub.wake = resolve
        })
      }
    } finally {
      const at = subs.indexOf(sub)
      if (at >= 0) subs.splice(at, 1)
    }
  }

  const noopEditor = {
    namespace: () => {},
    add: () => {},
    remove: () => {},
    set: () => {},
    update: () => {},
    list: () => [],
    get: () => undefined,
    default: () => {},
  }

  const ctx: any = {
    options: {
      screen: { enabled: false },
      routes: { default: { candidates: opts.candidates ?? ["munito/cheap"] } },
      ...(opts.compaction ? { compaction: { enabled: true } } : {}),
    },
    location: { directory: "/tmp/jev-rest-reset" },
    app: { version: "0.0.0-test" },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: any) => {
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
    },
    session: {
      hook: async (name: string, fn: any) => {
        hooks.set(name, fn)
        return undefined
      },
      // No transcript rows, ever: the reset must not need one.
      context: async () => [],
      get: async () => ({ data: { model: currentModel } }),
      switchModel: async (input: any) => {
        calls.push({ ...input.model })
        currentModel = { ...input.model }
      },
      synthetic: async () => {},
      prompt: async () => ({}),
      generate: async () => ({ text: "" }),
      command: async () => ({}),
      compact: async () => ({}),
      create: async () => ({}),
    },
    tool: {
      transform: async (cb: any) => cb(noopEditor),
      hook: async () => undefined,
      list: async () => [],
    },
    command: { transform: async (cb: any) => cb(noopEditor), list: async () => [] },
    model: {
      list: async () => ({ data: opts.catalog ?? [{ providerID: "munito", id: "cheap", variants: [] }] }),
      get: async () => null,
      transform: async (cb: any) => cb(noopEditor),
    },
    provider: {
      transform: async (cb: any) => cb({ ...noopEditor, add: () => {} }),
      get: async () => null,
      list: async () => [],
    },
    event: {
      subscribe: async () => {
        subscribeCount += 1
        return newStream()
      },
      hook: async () => undefined,
      publish: async () => {},
    },
    permission: { hook: async () => undefined, askDecision: async () => null },
    rpc: { call: async () => null },
  }

  return {
    ctx,
    store,
    calls,
    model: () => currentModel,
    setModel: (model: any) => {
      currentModel = model
    },
    subscribeCount: () => subscribeCount,
    push: (event: any) => {
      for (const sub of subs) sub.queue.push(event)
      wakeAll()
    },
    endStreams,
    firePrompt: async (text: string) => {
      const hook = hooks.get("prompt")
      if (!hook) throw new Error("prompt hook was not registered")
      await hook({ sessionID: SESSION, prompt: { text } })
    },
    fireCompaction: async (event: any) => {
      const hook = hooks.get("compaction")
      if (!hook) throw new Error("compaction hook was not registered")
      await hook(event)
    },
  }
}

const plugin = (await import("../src/index.ts")).default

const cleanups: Array<() => void> = []
async function boot(opts: Parameters<typeof makeHost>[0] = {}) {
  const host = makeHost(opts)
  const stop = await plugin.setup(host.ctx)
  cleanups.push(() => {
    if (typeof stop === "function") {
      try {
        stop()
      } catch {}
    }
    host.endStreams()
  })
  return host
}

const waitFor = async (predicate: () => boolean, ms = 3_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

// Back at the resting point: on the entry AND re-pinned to it. Waiting on the
// pin as well as the model means the next step never races the reset's
// storage write.
const atRest = (host: ReturnType<typeof makeHost>): boolean =>
  host.model().id === "auto" && host.store.get(`route-pin/${SESSION}`)?.to?.id === "auto"

afterAll(() => {
  for (const stop of cleanups) stop()
  delete process.env.JEV_ENDPOINT
  delete process.env.OPENCODE_BIN
})

describe("idle resting reset", () => {
  test("a routed session pulls back to its entry with no model-switched row at all", async () => {
    const host = await boot()

    await host.firePrompt("fix the failing test")
    // The judge is unreachable, so the last resort moved the session off the
    // entry onto its pool candidate - and pinned that exit.
    expect(host.calls).toEqual([{ providerID: "munito", id: "cheap" }])
    expect(host.model()).toMatchObject({ providerID: "munito", id: "cheap" })
    expect(host.store.get(`route-pin/${SESSION}`)).toMatchObject({
      to: { providerID: "munito", id: "cheap" },
      entry: { providerID: "opencode-decisions", modelID: "auto" },
    })

    host.push(IDLE)
    expect(await waitFor(() => atRest(host))).toBe(true)
    expect(host.calls[host.calls.length - 1]).toMatchObject({ providerID: "opencode-decisions", id: "auto" })
  })

  test("the pre-judge emergency exit records its own pin, so the next reset still finds the pick", async () => {
    const host = await boot()

    await host.firePrompt("first prompt")
    expect(host.model().id).toBe("cheap")
    host.push(IDLE)
    expect(await waitFor(() => atRest(host))).toBe(true)

    // Back on the entry, the turn is admitted and the fail-safe moves it off
    // before judging, pinning that exit through the shared helper. The reset
    // has to accept that pin with no transcript row to corroborate it: the old
    // two-sided row match skipped here (no row at all in this harness) and the
    // session stayed off Auto for good.
    await host.firePrompt("second prompt")
    expect(host.model()).toMatchObject({ providerID: "munito", id: "cheap" })
    expect(host.store.get(`route-pin/${SESSION}`)).toMatchObject({
      to: { providerID: "munito", id: "cheap" },
      entry: { providerID: "opencode-decisions", modelID: "auto" },
    })

    host.push(IDLE)
    expect(await waitFor(() => atRest(host))).toBe(true)
  })

  test("the compaction wake's exit pins the pick, so the reset still re-parks", async () => {
    const host = await boot({ compaction: true })

    await host.firePrompt("first prompt")
    expect(host.model().id).toBe("cheap")
    host.push(IDLE)
    expect(await waitFor(() => atRest(host))).toBe(true)

    // A compaction fires while the session rests on the entry: the hook steps
    // it off first (the summarizer would otherwise ride the pseudo-model), and
    // that exit is the switch that used to record no pin of its own. The next
    // reset then had nothing naming the pick to prove against.
    await host.fireCompaction({ sessionID: SESSION, messages: [] })
    expect(host.model()).toMatchObject({ providerID: "munito", id: "cheap" })
    expect(host.store.get(`route-pin/${SESSION}`)).toMatchObject({
      to: { providerID: "munito", id: "cheap" },
      entry: { providerID: "opencode-decisions", modelID: "auto" },
    })

    host.push(IDLE)
    expect(await waitFor(() => atRest(host))).toBe(true)
  })

  test("a manual pick still stands down and is never pulled back", async () => {
    const host = await boot()

    await host.firePrompt("first prompt")
    expect(host.model().id).toBe("cheap")
    host.push(IDLE)
    expect(await waitFor(() => atRest(host))).toBe(true)

    // The user picks a model of their own; the plugin's pin still names Auto
    // as its target, so the live selection is NOT the pin's own pick.
    const before = host.calls.length
    host.setModel({ providerID: "zeta", id: "flagship" })
    host.push(IDLE)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.calls.length).toBe(before)
    expect(host.model()).toMatchObject({ providerID: "zeta", id: "flagship" })
  })

  test("the idle subscription reattaches after its stream ends", async () => {
    const host = await boot()

    await host.firePrompt("first prompt")
    expect(host.model().id).toBe("cheap")
    expect(host.subscribeCount()).toBe(1)

    // A restart or transient error used to end the stream for good, taking the
    // reset down with it for the rest of the process lifetime.
    host.endStreams()
    expect(await waitFor(() => host.subscribeCount() >= 2, 12_000)).toBe(true)

    host.push(IDLE)
    expect(await waitFor(() => host.model().id === "auto", 5_000)).toBe(true)
  }, 20_000)
})
