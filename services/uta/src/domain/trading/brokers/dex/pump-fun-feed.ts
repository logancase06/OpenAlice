/**
 * Pump.fun new-token detection — real-time feed of token creation events.
 *
 * `wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket`
 * (the originally planned URL) is dead: Cloudflare error 1016 ("Origin DNS
 * error") — that domain no longer has a valid origin. The current official
 * REST API lives at `frontend-api-v3.pump.fun` (confirmed live: `/coins/
 * {mint}` responds), but it has no `/socket.io/` route — pump.fun's own
 * real-time feed, if one exists publicly, isn't at a socket.io endpoint.
 *
 * This module uses `wss://pumpportal.fun/api/data` instead — a third-party
 * relay, NOT affiliated with or operated by pump.fun. Confirmed live: sends
 * `{"method":"subscribeNewToken"}` after connecting, then streams raw JSON
 * objects (plain JSON over the socket, not socket.io-framed) shaped like:
 *   {"mint":"...","name":"...","symbol":"...","traderPublicKey":"...",
 *    "txType":"create","uri":"...","vSolInBondingCurve":30.25,
 *    "marketCapSol":28.43,"pool":"pump", ...}
 * No creation timestamp field exists in the payload — `createdAt` on
 * `PumpFunToken` is therefore receive-time, not pump.fun's actual on-chain
 * block time. No USD liquidity field either — `vSolInBondingCurve` (virtual
 * SOL in the bonding curve) is converted via a cached SOL/USD lookup (see
 * `getSolPriceUsd`).
 *
 * Being a third-party dependency with no stability guarantee, every failure
 * mode here is fail-safe: a malformed message is logged and dropped, a
 * disconnect reconnects with backoff, and exhausting retries surfaces via
 * `onError` so the caller (live-scan.ts) can fall back to relying on its
 * existing DexScreener-based discovery instead of crashing.
 */

const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data'
const SOL_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
const SOL_PRICE_CACHE_TTL_MS = 60_000
const SOL_PRICE_TIMEOUT_MS = 10_000
/** Below this retry count, reconnects are silent — see file header / GESTION DES ERREURS. */
const SILENT_RECONNECT_THRESHOLD = 3
/** A Solana base58 pubkey is always 32-44 characters (no 0/O/I/l — base58 excludes them). Doesn't verify the mint actually exists on-chain, just that pumpportal.fun sent something shaped like an address rather than garbage. */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export interface PumpFunToken {
  mintAddress: string
  symbol: string
  name: string
  createdAt: number
  initialLiquidityUsd?: number
  creatorAddress?: string
  metadataUri?: string
}

export interface PumpFunFeedConfig {
  onNewToken: (token: PumpFunToken) => void
  onError?: (err: Error) => void
  reconnectDelayMs?: number
  maxRetries?: number
}

interface RawPumpPortalMessage {
  mint?: string
  name?: string
  symbol?: string
  traderPublicKey?: string
  uri?: string
  txType?: string
  vSolInBondingCurve?: number
}

let cachedSolPrice: { price: number; expiresAt: number } | null = null

/** Cached 60s — CoinGecko's free tier has its own rate limits, and SOL/USD doesn't need per-token freshness for a rough liquidity estimate. Stale-if-error: a failed refresh returns the last known price rather than null, as long as one was ever fetched. */
export async function getSolPriceUsd(): Promise<number | null> {
  if (cachedSolPrice && cachedSolPrice.expiresAt > Date.now()) return cachedSolPrice.price

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SOL_PRICE_TIMEOUT_MS)
  try {
    const resp = await fetch(SOL_PRICE_URL, { signal: controller.signal })
    if (!resp.ok) {
      console.warn(`pump-fun-feed: SOL/USD price fetch HTTP ${resp.status}`)
      return cachedSolPrice?.price ?? null
    }
    const data = await resp.json() as { solana?: { usd?: number } } | null
    const price = data?.solana?.usd
    if (price == null || !Number.isFinite(price)) return cachedSolPrice?.price ?? null
    cachedSolPrice = { price, expiresAt: Date.now() + SOL_PRICE_CACHE_TTL_MS }
    return price
  } catch (err) {
    console.warn(`pump-fun-feed: SOL/USD price fetch failed — ${err instanceof Error ? err.message : String(err)}`)
    return cachedSolPrice?.price ?? null
  } finally {
    clearTimeout(timeout)
  }
}

/** Test-only — clears the module-level SOL/USD cache between specs. */
export function __resetSolPriceCacheForTests(): void {
  cachedSolPrice = null
}

export class PumpFunFeed {
  private socket: WebSocket | null = null
  private retries = 0
  private stopped = true
  private readonly config: PumpFunFeedConfig & { reconnectDelayMs: number; maxRetries: number }

  constructor(config: PumpFunFeedConfig) {
    this.config = { reconnectDelayMs: 3000, maxRetries: 10, ...config }
  }

  start(): void {
    this.stopped = false
    this.retries = 0
    this.connect()
  }

  /** Closes the socket and suppresses any further reconnect — the 'close' event this triggers must not itself schedule a reconnect. */
  stop(): void {
    this.stopped = true
    this.socket?.close()
    this.socket = null
  }

  private connect(): void {
    if (this.stopped) return
    let socket: WebSocket
    try {
      socket = new WebSocket(PUMPPORTAL_WS_URL)
    } catch (err) {
      this.handleConnectFailure(err)
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      this.retries = 0
      socket.send(JSON.stringify({ method: 'subscribeNewToken' }))
    })
    socket.addEventListener('message', (ev) => {
      void this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
    })
    // 'close' always fires after 'error' for a failed/dropped connection —
    // reconnect logic lives there exclusively, so a bad connection doesn't
    // schedule two overlapping reconnect attempts.
    socket.addEventListener('close', () => {
      if (this.stopped) return
      this.reconnect()
    })
  }

  private handleConnectFailure(err: unknown): void {
    console.warn(`pump-fun-feed: connection attempt failed — ${err instanceof Error ? err.message : String(err)}`)
    this.reconnect()
  }

  private reconnect(): void {
    if (this.stopped) return
    this.retries++
    if (this.retries > this.config.maxRetries) {
      const err = new Error(`pump-fun-feed: max reconnect attempts (${this.config.maxRetries}) exceeded — giving up`)
      console.error(err.message)
      this.config.onError?.(err)
      return
    }
    if (this.retries >= SILENT_RECONNECT_THRESHOLD) {
      console.warn(`pump-fun-feed: Pump.fun feed reconnecting... (attempt ${this.retries}/${this.config.maxRetries})`)
    }
    setTimeout(() => {
      if (!this.stopped) this.connect()
    }, this.config.reconnectDelayMs)
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: RawPumpPortalMessage
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.warn(`pump-fun-feed: malformed message, skipping — ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // Ack/status messages (e.g. the initial subscribe confirmation) have no
    // `mint` field — not a token event, silently ignored.
    if (!parsed.mint) return
    if (!SOLANA_ADDRESS_REGEX.test(parsed.mint)) {
      console.warn(`pump-fun-feed: mint field is not a plausible Solana address (${parsed.mint.slice(0, 8)}...) — skipping`)
      return
    }
    // subscribeNewToken should only emit 'create' events, but the upstream
    // format isn't documented/guaranteed — defensive check rather than an
    // assumption.
    if (parsed.txType && parsed.txType !== 'create') return
    if (!parsed.symbol || !parsed.name) {
      console.warn(`pump-fun-feed: message missing symbol/name for mint ${parsed.mint} — skipping`)
      return
    }

    let initialLiquidityUsd: number | undefined
    if (parsed.vSolInBondingCurve != null) {
      const solPrice = await getSolPriceUsd()
      if (solPrice != null) initialLiquidityUsd = parsed.vSolInBondingCurve * solPrice
    }

    const token: PumpFunToken = {
      mintAddress: parsed.mint,
      symbol: parsed.symbol,
      name: parsed.name,
      createdAt: Date.now(),
      initialLiquidityUsd,
      creatorAddress: parsed.traderPublicKey,
      metadataUri: parsed.uri,
    }

    try {
      this.config.onNewToken(token)
    } catch (err) {
      console.warn(`pump-fun-feed: onNewToken handler threw for mint ${parsed.mint} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
