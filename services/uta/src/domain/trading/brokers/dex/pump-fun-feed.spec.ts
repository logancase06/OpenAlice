import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PumpFunFeed, getSolPriceUsd, __resetSolPriceCacheForTests, type PumpFunToken } from './pump-fun-feed.js'

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
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ solana: { usd: 150 } })))
  vi.stubGlobal('fetch', fetchSpy)
  __resetSolPriceCacheForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function latestSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
}

describe('getSolPriceUsd', () => {
  it('fetches and caches the SOL/USD price', async () => {
    const price = await getSolPriceUsd()
    expect(price).toBe(150)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await getSolPriceUsd() // within TTL — should not re-fetch
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns null (not throw) when the price is unavailable and nothing was ever cached', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 500 }))
    const price = await getSolPriceUsd()
    expect(price).toBeNull()
  })
})

describe('PumpFunFeed', () => {
  it('sends subscribeNewToken on open', () => {
    const feed = new PumpFunFeed({ onNewToken: vi.fn() })
    feed.start()

    latestSocket().emit('open', {})

    expect(latestSocket().sentMessages).toEqual([JSON.stringify({ method: 'subscribeNewToken' })])
    feed.stop()
  })

  it('calls onNewToken with the correct fields for a valid create message', async () => {
    const onNewToken = vi.fn()
    const feed = new PumpFunFeed({ onNewToken })
    feed.start()
    latestSocket().emit('open', {})

    const raw = JSON.stringify({
      mint: '7YzVyW4HM7JwAJk4qGFsWdcX2q2HGSLWmRNUt2Yppump',
      name: 'bull',
      symbol: 'BULL',
      traderPublicKey: '9AxqETqF96VeL2aKfjJbVa6pNd1C2yGV9tKXcGPJxVMn',
      txType: 'create',
      uri: 'https://ipfs.io/ipfs/QmXdAvVu4WKNNoqQGKVKwQWbbAZXKUpX2YdVEws8yTMh9g',
      vSolInBondingCurve: 30.25,
      pool: 'pump',
    })
    latestSocket().emit('message', { data: raw })
    await new Promise(resolve => setTimeout(resolve, 0)) // let the async handler (SOL price fetch) settle

    expect(onNewToken).toHaveBeenCalledTimes(1)
    const token: PumpFunToken = onNewToken.mock.calls[0][0]
    expect(token.mintAddress).toBe('7YzVyW4HM7JwAJk4qGFsWdcX2q2HGSLWmRNUt2Yppump')
    expect(token.symbol).toBe('BULL')
    expect(token.name).toBe('bull')
    expect(token.creatorAddress).toBe('9AxqETqF96VeL2aKfjJbVa6pNd1C2yGV9tKXcGPJxVMn')
    expect(token.metadataUri).toBe('https://ipfs.io/ipfs/QmXdAvVu4WKNNoqQGKVKwQWbbAZXKUpX2YdVEws8yTMh9g')
    expect(token.initialLiquidityUsd).toBeCloseTo(30.25 * 150, 5)
    expect(typeof token.createdAt).toBe('number')
    feed.stop()
  })

  it('ignores the initial subscribe-ack message (no mint field) without calling onNewToken', () => {
    const onNewToken = vi.fn()
    const feed = new PumpFunFeed({ onNewToken })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: JSON.stringify({ message: 'Successfully subscribed to token creation events.' }) })

    expect(onNewToken).not.toHaveBeenCalled()
    feed.stop()
  })

  it('ignores a malformed (non-JSON) message without crashing', () => {
    const onNewToken = vi.fn()
    const feed = new PumpFunFeed({ onNewToken })
    feed.start()
    latestSocket().emit('open', {})

    expect(() => latestSocket().emit('message', { data: 'not valid json {{{' })).not.toThrow()
    expect(onNewToken).not.toHaveBeenCalled()
    feed.stop()
  })

  it('ignores a message missing symbol/name without crashing', () => {
    const onNewToken = vi.fn()
    const feed = new PumpFunFeed({ onNewToken })
    feed.start()
    latestSocket().emit('open', {})

    // A plausibly-shaped (valid-length base58) mint, so this exercises the
    // missing-symbol/name check specifically, not the mint-format check below.
    latestSocket().emit('message', { data: JSON.stringify({ mint: '7YzVyW4HM7JwAJk4qGFsWdcX2q2HGSLWmRNUt2Yppump', txType: 'create' }) })

    expect(onNewToken).not.toHaveBeenCalled()
    feed.stop()
  })

  it('ignores a message whose mint is not a plausible Solana address (too short) without crashing', () => {
    const onNewToken = vi.fn()
    const feed = new PumpFunFeed({ onNewToken })
    feed.start()
    latestSocket().emit('open', {})

    expect(() => latestSocket().emit('message', { data: JSON.stringify({ mint: 'not-valid!!!', name: 'x', symbol: 'X', txType: 'create' }) })).not.toThrow()

    expect(onNewToken).not.toHaveBeenCalled()
    feed.stop()
  })

  it('processes a message with a valid 44-character base58 mint normally', () => {
    const onNewToken = vi.fn()
    const feed = new PumpFunFeed({ onNewToken })
    feed.start()
    latestSocket().emit('open', {})

    latestSocket().emit('message', { data: JSON.stringify({
      mint: '7YzVyW4HM7JwAJk4qGFsWdcX2q2HGSLWmRNUt2Yppump',
      name: 'bull', symbol: 'BULL', txType: 'create',
    }) })

    expect(onNewToken).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('reconnects after reconnectDelayMs on disconnect', async () => {
    vi.useFakeTimers()
    const feed = new PumpFunFeed({ onNewToken: vi.fn(), reconnectDelayMs: 100 })
    feed.start()
    expect(FakeWebSocket.instances).toHaveLength(1)

    latestSocket().emit('close', {})
    expect(FakeWebSocket.instances).toHaveLength(1) // not yet — waiting on the delay

    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWebSocket.instances).toHaveLength(2) // reconnected

    feed.stop()
  })

  it('does not reconnect after a voluntary stop()', async () => {
    vi.useFakeTimers()
    const feed = new PumpFunFeed({ onNewToken: vi.fn(), reconnectDelayMs: 50 })
    feed.start()
    expect(FakeWebSocket.instances).toHaveLength(1)

    feed.stop() // this itself emits 'close' on the fake socket

    await vi.advanceTimersByTimeAsync(200)
    expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect attempt
  })

  it('gives up and calls onError after maxRetries consecutive failures', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const feed = new PumpFunFeed({ onNewToken: vi.fn(), onError, reconnectDelayMs: 10, maxRetries: 3 })
    feed.start()

    for (let i = 0; i < 4; i++) {
      latestSocket().emit('close', {})
      await vi.advanceTimersByTimeAsync(10)
    }

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    feed.stop()
  })
})
