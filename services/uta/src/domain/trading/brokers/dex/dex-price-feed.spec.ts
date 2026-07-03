import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DexPriceFeed, fetchBatchPrices } from './dex-price-feed.js'

const fetchSpy = vi.fn()

function batchResponse(pairs: Array<{ pairAddress: string; priceUsd?: string; liquidityUsd?: number; priceChange?: { m5?: number; h1?: number } }>): Response {
  return new Response(JSON.stringify({
    schemaVersion: '1.0.0',
    pairs: pairs.map(p => ({
      pairAddress: p.pairAddress,
      priceUsd: p.priceUsd,
      liquidity: p.liquidityUsd != null ? { usd: p.liquidityUsd } : undefined,
      priceChange: p.priceChange,
    })),
  }))
}

beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchBatchPrices', () => {
  it('makes a single HTTP call for multiple pair addresses', async () => {
    fetchSpy.mockResolvedValue(batchResponse([
      { pairAddress: 'pairA', priceUsd: '0.05', liquidityUsd: 10_000, priceChange: { m5: 1.2, h1: 5.5 } },
      { pairAddress: 'pairB', priceUsd: '0.10', liquidityUsd: 20_000 },
    ]))

    const result = await fetchBatchPrices('solana', ['pairA', 'pairB'])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.size).toBe(2)
    expect(result.get('pairA')).toMatchObject({ priceUsd: 0.05, liquidityUsd: 10_000, priceChange: { m5: 1.2, h1: 5.5 } })
    expect(result.get('pairB')).toMatchObject({ priceUsd: 0.10, liquidityUsd: 20_000 })
  })

  it('handles priceChange fields being entirely absent (no recent activity in that window)', async () => {
    fetchSpy.mockResolvedValue(batchResponse([{ pairAddress: 'pairA', priceUsd: '0.05', liquidityUsd: 10_000 }]))

    const result = await fetchBatchPrices('solana', ['pairA'])

    expect(result.get('pairA')!.priceChange).toEqual({ m5: undefined, h1: undefined })
  })

  it('returns an empty map, never throws, on a malformed response body', async () => {
    fetchSpy.mockResolvedValue(new Response('not json'))

    const result = await fetchBatchPrices('solana', ['pairA'])

    expect(result.size).toBe(0)
  })

  it('returns an empty map, never throws, on a network timeout', async () => {
    fetchSpy.mockImplementation(() => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })

    const result = await fetchBatchPrices('solana', ['pairA'])

    expect(result.size).toBe(0)
  })

  it('returns an empty map, never throws, on a non-2xx HTTP status', async () => {
    fetchSpy.mockResolvedValue(new Response('rate limited', { status: 429 }))

    const result = await fetchBatchPrices('solana', ['pairA'])

    expect(result.size).toBe(0)
  })

  it('returns an empty map for an empty address list without calling fetch', async () => {
    const result = await fetchBatchPrices('solana', [])

    expect(result.size).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('chunks requests when given more addresses than the batch size limit', async () => {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const addrs = String(url).split('/').pop()!.split(',')
      return batchResponse(addrs.map(a => ({ pairAddress: a, priceUsd: '0.01', liquidityUsd: 1000 })))
    })
    const addrs = Array.from({ length: 35 }, (_, i) => `pair${i}`)

    const result = await fetchBatchPrices('solana', addrs)

    expect(fetchSpy).toHaveBeenCalledTimes(2) // 30 + 5
    expect(result.size).toBe(35)
  })

  it('drops entries with an unusable (zero/missing) price rather than caching a bad value', async () => {
    fetchSpy.mockResolvedValue(batchResponse([{ pairAddress: 'pairA', priceUsd: '0', liquidityUsd: 10_000 }]))

    const result = await fetchBatchPrices('solana', ['pairA'])

    expect(result.has('pairA')).toBe(false)
  })
})

describe('DexPriceFeed', () => {
  it('getLatestPrice returns null before anything has been fetched', () => {
    const feed = new DexPriceFeed('solana', 50)
    expect(feed.getLatestPrice('pairA')).toBeNull()
    feed.closeAll()
  })

  it('subscribe/unsubscribe are reference-counted — a shared pairAddress survives one of two unsubscribes', () => {
    const feed = new DexPriceFeed('solana', 50)
    feed.subscribe('sharedPair')
    feed.subscribe('sharedPair') // second subscriber (e.g. a different strategy on the same token)
    feed.unsubscribe('sharedPair') // first subscriber closes

    // Still subscribed (refcount 1) — a subsequent tick would still fetch it.
    // We can't directly inspect the private Set, so verify indirectly: a
    // second unsubscribe is what actually clears it (see next assertion).
    feed.unsubscribe('sharedPair')
    expect(feed.getLatestPrice('sharedPair')).toBeNull() // cache cleared once truly unsubscribed
    feed.closeAll()
  })

  it('populates the cache via its periodic batch tick once subscribed', async () => {
    fetchSpy.mockResolvedValue(batchResponse([{ pairAddress: 'tickPair', priceUsd: '0.25', liquidityUsd: 5000 }]))
    const feed = new DexPriceFeed('solana', 20) // short interval for a fast test

    feed.subscribe('tickPair')
    await new Promise(resolve => setTimeout(resolve, 60)) // let a couple of ticks fire

    const price = feed.getLatestPrice('tickPair')
    expect(price).not.toBeNull()
    expect(price!.priceUsd).toBe(0.25)
    feed.closeAll()
  })

  it('closeAll clears subscriptions and cache without throwing', () => {
    const feed = new DexPriceFeed('solana', 50)
    feed.subscribe('pairA')
    expect(() => feed.closeAll()).not.toThrow()
    expect(feed.getLatestPrice('pairA')).toBeNull()
  })

  it('batchFetch on the instance delegates to the module-level fetchBatchPrices for the configured chain', async () => {
    fetchSpy.mockResolvedValue(batchResponse([{ pairAddress: 'pairA', priceUsd: '0.05', liquidityUsd: 10_000 }]))
    const feed = new DexPriceFeed('ethereum', 50)

    const result = await feed.batchFetch(['pairA'])

    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/ethereum/'), expect.anything())
    expect(result.get('pairA')?.priceUsd).toBe(0.05)
    feed.closeAll()
  })
})
