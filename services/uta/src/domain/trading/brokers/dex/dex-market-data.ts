/**
 * Read-only network integration for the DEX broker: DexScreener token
 * search + pair data. Used for both contract search and paper-mode price
 * marks, uniformly across all four chains — Phase A never signs or submits
 * a transaction, so there's no need yet for a Jupiter/Uniswap SDK or an
 * RPC connection; that lands in Phase B alongside real execution.
 *
 * Every function here has an explicit timeout and never throws — network
 * failures return `null`/`[]` so callers can fail safely rather than crash
 * the broker (matches the fail-safe convention from `TokenSecurityGuard`).
 */

const REQUEST_TIMEOUT_MS = 10_000

export interface DexScreenerPair {
  chainId: string
  pairAddress: string
  baseToken: { address: string; symbol: string; name: string }
  quoteToken: { address: string; symbol: string; name: string }
  priceUsd?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  pairCreatedAt?: number
  url?: string
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) {
      console.warn(`dex-market-data: ${url} -> HTTP ${resp.status}`)
      return null
    }
    return (await resp.json()) as T
  } catch (err) {
    console.warn(`dex-market-data: ${url} -> ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Search DexScreener for tokens/pairs matching a free-text query. */
export async function searchDexScreenerPairs(query: string): Promise<DexScreenerPair[]> {
  const data = await fetchJson<{ pairs?: DexScreenerPair[] }>(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
  )
  return data?.pairs ?? []
}

/** Fetch all known pools for one token on one chain — used for quotes/position marks. */
export async function fetchDexScreenerTokenPairs(chainId: string, tokenAddress: string): Promise<DexScreenerPair[]> {
  const data = await fetchJson<DexScreenerPair[]>(
    `https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`,
  )
  return data ?? []
}

/** Best pool for a token = highest USD liquidity among its known pairs. */
export function bestPair(pairs: DexScreenerPair[]): DexScreenerPair | null {
  if (pairs.length === 0) return null
  return pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best))
}
