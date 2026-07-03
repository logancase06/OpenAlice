/**
 * DexScreener batch price feed — cache-backed price source for open
 * positions, refreshed on a fixed interval rather than fetched per-position
 * per-cycle (see `checkExits` in live-scan.ts: with N open positions, one
 * batch call covers all of them instead of N individual `getQuote` calls).
 *
 * WebSocket was the original plan (`wss://io.dexscreener.com/dex/screener/
 * pairs/v1/{chain}/{pairAddress}`) — confirmed live 2026-07-02 that it's
 * behind Cloudflare bot protection (403 "Attention Required", `__cf_bm`
 * challenge cookie) even with a browser-shaped Origin/User-Agent. Not a
 * fixable header issue; this module is batch-HTTP-only by design, not a
 * degraded fallback path.
 *
 * Real batch endpoint (confirmed live): `/latest/dex/pairs/{chain}/{addr1},
 * {addr2},...}` — NOT `/dex/pairs/...` (that path 404s). `priceChange.m5`/
 * `h1` are OMITTED from the response entirely (not zeroed) when a pair has
 * no transactions in that window — callers must treat them as optional,
 * same convention as dex-market-data.ts's DexScreenerPair.
 */

const BATCH_ENDPOINT_BASE = 'https://api.dexscreener.com/latest/dex/pairs'
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_BATCH_INTERVAL_MS = 3000
// DexScreener's batch pairs endpoint isn't documented to have a hard cap,
// but chunking conservatively avoids an oversized URL / unexpectedly large
// response for a scanner that could accumulate many open positions.
const MAX_BATCH_SIZE = 30

export interface PriceUpdate {
  pairAddress: string
  priceUsd: number
  priceChange: { m5?: number; h1?: number }
  liquidityUsd: number
  timestamp: number
}

interface BatchPairResponse {
  pairAddress?: string
  priceUsd?: string
  liquidity?: { usd?: number }
  priceChange?: { m5?: number; h1?: number }
}

/**
 * One or more batch HTTP calls (chunked at MAX_BATCH_SIZE) covering every
 * requested pair address. Never throws — a failed chunk is logged and
 * simply contributes no entries to the result map; callers see "no update
 * this tick" for those pairs, not a crash.
 */
export async function fetchBatchPrices(chain: string, pairAddresses: string[]): Promise<Map<string, PriceUpdate>> {
  const result = new Map<string, PriceUpdate>()
  if (pairAddresses.length === 0) return result

  for (let i = 0; i < pairAddresses.length; i += MAX_BATCH_SIZE) {
    const chunk = pairAddresses.slice(i, i + MAX_BATCH_SIZE)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = `${BATCH_ENDPOINT_BASE}/${chain}/${chunk.join(',')}`
      const resp = await fetch(url, { signal: controller.signal })
      if (!resp.ok) {
        console.warn(`dex-price-feed: batch fetch HTTP ${resp.status} for chunk of ${chunk.length} pair(s)`)
        continue
      }
      const data = await resp.json() as { pairs?: BatchPairResponse[] } | null
      const pairs = Array.isArray(data?.pairs) ? data!.pairs! : []
      for (const p of pairs) {
        if (!p.pairAddress) continue
        const priceUsd = Number(p.priceUsd ?? 0)
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue
        result.set(p.pairAddress, {
          pairAddress: p.pairAddress,
          priceUsd,
          priceChange: { m5: p.priceChange?.m5, h1: p.priceChange?.h1 },
          liquidityUsd: p.liquidity?.usd ?? 0,
          timestamp: Date.now(),
        })
      }
    } catch (err) {
      console.warn(`dex-price-feed: batch fetch failed — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timeout)
    }
  }
  return result
}

/**
 * Reference-counted subscribe/unsubscribe: two strategies (e.g. EARLY and
 * EARLY_STRICT) can independently hold a position in the same pairAddress —
 * a plain Set would let the first position's close silently stop price
 * updates for the second, still-open one. `getLatestPrice` returns
 * whatever's in cache, `null` if nothing's been fetched for that pair yet
 * (e.g. subscribed less than one batch interval ago) — callers must treat
 * that as "skip this cycle," not an error.
 */
export class DexPriceFeed {
  private chain: string
  private readonly subscriptions = new Map<string, number>()
  private readonly cache = new Map<string, PriceUpdate>()
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(chain: string = 'solana', intervalMs: number = DEFAULT_BATCH_INTERVAL_MS) {
    this.chain = chain
    this.intervalMs = intervalMs
  }

  /** Live-scan supports multiple chains via --chain; the module-level singleton defaults to solana but is retargeted once the real chain is known at startup. */
  setChain(chain: string): void {
    this.chain = chain
  }

  subscribe(pairAddress: string): void {
    this.subscriptions.set(pairAddress, (this.subscriptions.get(pairAddress) ?? 0) + 1)
    this.ensureTimer()
  }

  unsubscribe(pairAddress: string): void {
    const count = this.subscriptions.get(pairAddress) ?? 0
    if (count <= 1) {
      this.subscriptions.delete(pairAddress)
      this.cache.delete(pairAddress)
    } else {
      this.subscriptions.set(pairAddress, count - 1)
    }
    if (this.subscriptions.size === 0) this.stopTimer()
  }

  getLatestPrice(pairAddress: string): PriceUpdate | null {
    return this.cache.get(pairAddress) ?? null
  }

  async batchFetch(pairAddresses: string[]): Promise<Map<string, PriceUpdate>> {
    return fetchBatchPrices(this.chain, pairAddresses)
  }

  closeAll(): void {
    this.stopTimer()
    this.subscriptions.clear()
    this.cache.clear()
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    const addrs = [...this.subscriptions.keys()]
    if (addrs.length === 0) return
    const updates = await this.batchFetch(addrs)
    for (const [addr, update] of updates) this.cache.set(addr, update)
  }
}

export const priceFeed = new DexPriceFeed()
