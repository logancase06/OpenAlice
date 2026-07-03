import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HeliusPoolFeed, type DiscoveredPool } from './helius-pool-feed.js'

type Listener = (ev: unknown) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  private listeners: Record<string, Listener[]> = {}
  sentMessages: string[] = []
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb)
  }

  send(data: string): void {
    this.sentMessages.push(data)
  }

  close(): void {
    this.closed = true
    this.emit('close', {})
  }

  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev)
  }
}

const fetchSpy = vi.fn()

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubEnv('HELIUS_API_KEY', 'test-key-123')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function latestSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
}

function logsNotification(overrides: { signature?: string; logs?: string[]; err?: unknown } = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      result: {
        value: {
          signature: overrides.signature ?? 'sig1111111111111111111111111111111111111111111111111111111111111',
          logs: overrides.logs ?? ['Program log: Instruction: CreateV2'],
          err: overrides.err ?? null,
        },
      },
    },
  })
}

function getTransactionResponse(mint: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    result: {
      meta: {
        preTokenBalances: [],
        postTokenBalances: [{ mint }],
      },
    },
  }))
}

describe('HeliusPoolFeed', () => {
  it('sends logsSubscribe on the pump.fun program on open', () => {
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn() })
    feed.start()
    latestSocket().emit('open', {})

    const sent = JSON.parse(latestSocket().sentMessages[0]!)
    expect(sent.method).toBe('logsSubscribe')
    expect(sent.params[0].mentions).toEqual(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'])
    feed.stop()
  })

  it('calls onNewPool with the extracted mint address for a CreateV2 log notification', async () => {
    fetchSpy.mockResolvedValue(getTransactionResponse('NewMint11111111111111111111111111111111'))
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification() })
    await new Promise(resolve => setTimeout(resolve, 0)) // let the async getTransaction round-trip settle

    expect(onNewPool).toHaveBeenCalledTimes(1)
    const pool: DiscoveredPool = onNewPool.mock.calls[0][0]
    expect(pool.mintAddress).toBe('NewMint11111111111111111111111111111111')
    expect(typeof pool.discoveredAt).toBe('number')
    expect(feed.getTransactionCallsMade()).toBe(1)
    feed.stop()
  })

  it('ignores a log notification without the CreateV2 marker — no getTransaction call made', async () => {
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Buy'] }) })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onNewPool).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    feed.stop()
  })

  it('ignores a failed transaction (err set) without calling getTransaction', async () => {
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ err: { InstructionError: [0, 'Custom'] } }) })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onNewPool).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    feed.stop()
  })

  it('ignores the subscription ack message (no params.result.value) without crashing', () => {
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool })
    feed.start()
    latestSocket().emit('open', {})

    expect(() => latestSocket().emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 12345 }) })).not.toThrow()
    expect(onNewPool).not.toHaveBeenCalled()
    feed.stop()
  })

  it('ignores a malformed (non-JSON) message without crashing', () => {
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool })
    feed.start()
    latestSocket().emit('open', {})

    expect(() => latestSocket().emit('message', { data: 'not valid json {{{' })).not.toThrow()
    expect(onNewPool).not.toHaveBeenCalled()
    feed.stop()
  })

  it('skips silently when getTransaction resolves but no new mint is found in postTokenBalances', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', result: { meta: { preTokenBalances: [], postTokenBalances: [] } } })))
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification() })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onNewPool).not.toHaveBeenCalled()
    feed.stop()
  })

  it('does not crash and skips when getTransaction returns a network error', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'))
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool })
    feed.start()
    latestSocket().emit('open', {})

    expect(() => latestSocket().emit('message', { data: logsNotification() })).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onNewPool).not.toHaveBeenCalled()
    feed.stop()
  })

  it('reconnects after reconnectDelayMs on disconnect', async () => {
    vi.useFakeTimers()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), reconnectDelayMs: 100 })
    feed.start()
    expect(FakeWebSocket.instances).toHaveLength(1)

    latestSocket().emit('close', {})
    expect(FakeWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWebSocket.instances).toHaveLength(2)

    feed.stop()
  })

  it('does not reconnect after a voluntary stop()', async () => {
    vi.useFakeTimers()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), reconnectDelayMs: 50 })
    feed.start()
    expect(FakeWebSocket.instances).toHaveLength(1)

    feed.stop()

    await vi.advanceTimersByTimeAsync(200)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('gives up and calls onError after maxRetries consecutive failures', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), onError, reconnectDelayMs: 10, maxRetries: 3 })
    feed.start()

    for (let i = 0; i < 4; i++) {
      latestSocket().emit('close', {})
      await vi.advanceTimersByTimeAsync(10)
    }

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    feed.stop()
  })

  it('never leaks the Helius API key into a logged error message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchSpy.mockRejectedValue(new Error('fetch failed for wss://mainnet.helius-rpc.com/?api-key=test-key-123'))
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn() })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification() })
    await new Promise(resolve => setTimeout(resolve, 0))

    const loggedCalls = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(loggedCalls).not.toContain('test-key-123')
    expect(loggedCalls).toContain('REDACTED')
    feed.stop()
    warnSpy.mockRestore()
  })
})

/** Mirrors the real getTransaction shape (accountIndex-keyed), used for Migrate extraction tests — distinct from getTransactionResponse's simpler by-value shape used for CreateV2. */
function migrateTransactionResponse(pre: Array<{ accountIndex: number; mint: string }>, post: Array<{ accountIndex: number; mint: string }>): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    result: { meta: { preTokenBalances: pre, postTokenBalances: post } },
  }))
}

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112'

describe('HeliusPoolFeed — graduation (Migrate) detection', () => {
  it('calls onGraduation with the extracted mint for a Migrate log notification', async () => {
    // Real shape captured live 2026-07-02 (sig 39jNwHWiA9...): pre had only
    // the pre-existing mint account; post added two new accounts — the
    // migrated mint and wrapped SOL.
    fetchSpy.mockResolvedValue(migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [
        { accountIndex: 3, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
        { accountIndex: 4, mint: WRAPPED_SOL },
        { accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
      ],
    ))
    const onGraduation = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Migrate'] }) })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onGraduation).toHaveBeenCalledTimes(1)
    const event = onGraduation.mock.calls[0][0]
    expect(event.mintAddress).toBe('f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump')
    expect(event.source).toBe('helius_logs')
    expect(typeof event.graduatedAt).toBe('number')
    feed.stop()
  })

  it('a CreateV2 log notification never calls onGraduation (unchanged, mutually exclusive)', async () => {
    fetchSpy.mockResolvedValue(getTransactionResponse('NewMint11111111111111111111111111111111'))
    const onGraduation = vi.fn()
    const onNewPool = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool, onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification() }) // default = CreateV2
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onNewPool).toHaveBeenCalledTimes(1)
    expect(onGraduation).not.toHaveBeenCalled()
    feed.stop()
  })

  it('a log notification with neither CreateV2 nor Migrate is ignored — no RPC call, neither callback fires', async () => {
    const onNewPool = vi.fn()
    const onGraduation = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool, onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Buy'] }) })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onNewPool).not.toHaveBeenCalled()
    expect(onGraduation).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    feed.stop()
  })

  it('skips the getTransaction call entirely for Migrate when no onGraduation listener is configured', async () => {
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn() }) // no onGraduation
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Migrate'] }) })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchSpy).not.toHaveBeenCalled()
    feed.stop()
  })

  it('extraction (accountIndex diff): incomplete accountKeys/balances — no new non-SOL account — returns no mint after exhausting retries, no onGraduation call', async () => {
    // post only repeats what was already in pre — nothing new — extraction fails on every attempt.
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
    ))
    const onGraduation = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Migrate'] }) })
    await vi.advanceTimersByTimeAsync(2000 + 4000) // both retry delays

    expect(fetchSpy).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
    expect(onGraduation).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls.some(c => c.join(' ').includes('failed after 3 attempts'))).toBe(true)
    feed.stop()
    warnSpy.mockRestore()
  })

  it('extraction: only a new wrapped-SOL account appears (no meme-coin account) — returns no mint after exhausting retries', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [
        { accountIndex: 4, mint: WRAPPED_SOL },
        { accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
      ],
    ))
    const onGraduation = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Migrate'] }) })
    await vi.advanceTimersByTimeAsync(2000 + 4000)

    expect(onGraduation).not.toHaveBeenCalled()
    feed.stop()
  })

  it('retries once and succeeds on the 2nd attempt — logs "extracted on attempt 2"', async () => {
    vi.useFakeTimers()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const failingBalances = migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
    )
    const succeedingBalances = migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [
        { accountIndex: 3, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
        { accountIndex: 4, mint: WRAPPED_SOL },
        { accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
      ],
    )
    fetchSpy.mockResolvedValueOnce(failingBalances).mockResolvedValueOnce(succeedingBalances)
    const onGraduation = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Migrate'] }) })
    await vi.advanceTimersByTimeAsync(2000)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(onGraduation).toHaveBeenCalledTimes(1)
    expect(onGraduation.mock.calls[0][0].mintAddress).toBe('f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump')
    expect(logSpy.mock.calls.some(c => c.join(' ').includes('extracted on attempt 2'))).toBe(true)
    feed.stop()
  })

  it('retries twice and succeeds on the 3rd attempt', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const failingBalances = migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
    )
    const succeedingBalances = migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [
        { accountIndex: 3, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
        { accountIndex: 4, mint: WRAPPED_SOL },
        { accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
      ],
    )
    fetchSpy.mockResolvedValueOnce(failingBalances).mockResolvedValueOnce(failingBalances).mockResolvedValueOnce(succeedingBalances)
    const onGraduation = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Migrate'] }) })
    await vi.advanceTimersByTimeAsync(2000 + 4000)

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(onGraduation).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('succeeds on the 1st attempt — no retry delay, single fetch call', async () => {
    fetchSpy.mockResolvedValueOnce(migrateTransactionResponse(
      [{ accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' }],
      [
        { accountIndex: 3, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
        { accountIndex: 4, mint: WRAPPED_SOL },
        { accountIndex: 7, mint: 'f5cgJ6CG3C3VWD8Jy58YCJgFcWjNZJpvfpGiJHPpump' },
      ],
    ))
    const onGraduation = vi.fn()
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn(), onGraduation })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: logsNotification({ logs: ['Program log: Instruction: Migrate'] }) })
    await new Promise(resolve => setTimeout(resolve, 0)) // real timers — proves no delay was needed

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(onGraduation).toHaveBeenCalledTimes(1)
    feed.stop()
  })
})
