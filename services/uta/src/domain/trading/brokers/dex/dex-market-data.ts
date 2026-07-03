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
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number }
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number }
  /** Buy/sell transaction COUNTS per window — not unique wallets. A single
   *  actor issuing many transactions looks identical to many distinct
   *  buyers here; treat as an activity signal, not a holder-distribution one. */
  txns?: {
    m5?: { buys: number; sells: number }
    h1?: { buys: number; sells: number }
    h6?: { buys: number; sells: number }
    h24?: { buys: number; sells: number }
  }
  pairCreatedAt?: number
  url?: string
  /**
   * Social/website links and paid-promotion status — confirmed present in
   * DexScreener's real API response (verified live 2026-07-02). `socials`
   * presence alone was a weak signal on the small sample checked that
   * session (rugs 72.7% had socials, winners 92.9% — not a clean separator)
   * and stayed weak at n=674 (rugs 100%, winners 97.6% — the field is
   * present on ~97% of tokens regardless of outcome, too little variance to
   * discriminate on). `websites` presence, in contrast, held up on a larger
   * sample — see `TokenSecurityGuard.ts`'s `requireWebsite` for the guard
   * this backs and its full evidence/caveats.
   */
  info?: {
    websites?: Array<{ url: string; label?: string }>
    socials?: Array<{ url: string; type: string }>
  }
  boosts?: { active?: number }
  /** e.g. "pumpswap", "raydium" — confirmed live 2026-07-02: every pump.fun-origin pair checked (pre- and post-graduation alike) reported "pumpswap", not "pump-fun"/"raydium" as might be assumed. Used by `fetchPairForMint` to isolate the PumpSwap pool specifically. */
  dexId?: string
}

/** One entry from DexScreener's "latest token profiles" feed — new tokens across all chains. */
export interface DexScreenerTokenProfile {
  chainId: string
  tokenAddress: string
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

/**
 * DexScreener's "latest token profiles" feed — the closest thing to a
 * cross-chain "newest tokens" stream this public API offers (used by the
 * `retro:today` report to approximate what a live scanner would have seen).
 * Not chain-scoped upstream; callers filter by `chainId` themselves.
 */
export async function fetchLatestTokenProfiles(): Promise<DexScreenerTokenProfile[]> {
  const data = await fetchJson<DexScreenerTokenProfile[]>('https://api.dexscreener.com/token-profiles/latest/v1')
  return data ?? []
}

/** Fetch all known pools for one token on one chain — used for quotes/position marks. */
export async function fetchDexScreenerTokenPairs(chainId: string, tokenAddress: string): Promise<DexScreenerPair[]> {
  const data = await fetchJson<DexScreenerPair[]>(
    `https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`,
  )
  return data ?? []
}

const TOKEN_BATCH_SIZE = 30

/**
 * Batch lookup for many token addresses in as few requests as possible —
 * confirmed live at `/tokens/v1/{chainId}/{addr1,addr2,...}` (up to 30 per
 * call, chunked beyond that). Returns a flat response grouped by
 * `baseToken.address` since a token can have several pools. Used by the
 * pump.fun watchlist, which otherwise made one `fetchDexScreenerTokenPairs`
 * call per watched token per cycle — see live-scan.ts's `checkPumpWatchlist`.
 */
export async function fetchDexScreenerTokensBatch(chainId: string, tokenAddresses: string[]): Promise<Map<string, DexScreenerPair[]>> {
  const result = new Map<string, DexScreenerPair[]>()
  for (let i = 0; i < tokenAddresses.length; i += TOKEN_BATCH_SIZE) {
    const chunk = tokenAddresses.slice(i, i + TOKEN_BATCH_SIZE)
    const data = await fetchJson<DexScreenerPair[]>(
      `https://api.dexscreener.com/tokens/v1/${chainId}/${chunk.join(',')}`,
    )
    if (!Array.isArray(data)) continue
    for (const p of data) {
      const addr = p.baseToken?.address
      if (!addr) continue
      const list = result.get(addr)
      if (list) list.push(p)
      else result.set(addr, [p])
    }
  }
  return result
}

/** Best pool for a token = highest USD liquidity among its known pairs. Defensive against a non-array response (malformed/unexpected API body) — treated the same as "no pairs," never thrown. */
export function bestPair(pairs: DexScreenerPair[]): DexScreenerPair | null {
  if (!Array.isArray(pairs) || pairs.length === 0) return null
  return pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best))
}

/**
 * Fetches all known pools for a mint and returns the PumpSwap one with the
 * highest liquidity — used by the graduation strategies (live-scan.ts's
 * GRAD_IMMEDIATE/GRAD_DIP) right after a `Migrate` event, since the newly-
 * created PumpSwap pool is what those strategies actually trade against.
 * Reuses `fetchDexScreenerTokenPairs` rather than a new endpoint (same data,
 * already fetches every pool for a token on a chain) — `dexId: "pumpswap"`
 * confirmed live 2026-07-02 as the correct filter value (see `DexScreenerPair.dexId`'s
 * docstring). `null` if no PumpSwap pool was found or it has $0 liquidity.
 */
export async function fetchPairForMint(mintAddress: string, chainId = 'solana'): Promise<DexScreenerPair | null> {
  const pairs = await fetchDexScreenerTokenPairs(chainId, mintAddress)
  const pumpswapPairs = pairs.filter(p => p.dexId === 'pumpswap')
  const best = bestPair(pumpswapPairs)
  if (!best || !best.liquidity?.usd) return null
  return best
}
