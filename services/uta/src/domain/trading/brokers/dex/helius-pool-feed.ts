/**
 * Helius WebSocket pool-creation feed — direct on-chain subscription to
 * pump.fun's `CreateV2` instruction, bypassing DexScreener's "latest token
 * profiles" curation entirely.
 *
 * Adopted 2026-07-02, live-measured that same day: on-chain blockTime -> WS
 * `logsNotification` receipt = 2.9s; on-chain blockTime -> DexScreener pair
 * queryable = <=38.0s (upper bound, single sample). Compared against the
 * existing pipeline's own measured median (pairCreatedAt -> first
 * `fetchLatestTokenProfiles()` sighting) of 10.78 minutes — the gap isn't
 * DexScreener's own indexing being slow, it's their "latest profiles" feed
 * (fixed 30-item, cross-chain, no pagination, observed to not even change
 * within a 35s window) not surfacing a specific new pair promptly. A direct
 * program-log subscription sidesteps that curation step.
 *
 * Surveillance only, by explicit decision 2026-07-02: this feed's discovery
 * timestamp does NOT reach `evaluateStrategy()` and never opens a position —
 * same posture as `pump-fun-feed.ts`'s watchlist. Every mint it discovers is
 * still subject to being bought later, but only via the existing,
 * unmodified DexScreener-driven path once it re-appears there — this module
 * exists purely to measure and log how much sooner the token WOULD have
 * been actionable, not to act on it early.
 *
 * KNOWN MAINTENANCE RISK: `CreateV2` is not an officially documented
 * instruction name — it was confirmed by directly observing live program
 * logs on 2026-07-02 (`Program log: Instruction: CreateV2` appeared
 * alongside dozens of other instruction names — Buy/Sell/Swap variants,
 * etc. — on the same program). Pump.fun has already moved past a plain
 * `Create` instruction (an earlier discriminator found via public write-ups
 * did not match live traffic) — there is no guarantee `CreateV2` remains
 * current. If this feed silently stops finding any pools, re-verify the
 * active instruction name against live traffic before assuming the feed
 * itself is broken (see the file's own git-absent history note in
 * live-scan.ts's header — this codebase has no commit trail to lean on).
 */
import { withRpcSlot } from './rpc-concurrency.js'

const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
/** Confirmed live 2026-07-02 against real program traffic — see file header's maintenance risk note. */
const CREATE_INSTRUCTION_LOG_MARKER = 'Instruction: CreateV2'
/**
 * Confirmed live 2026-07-02 by subscribing directly to a `mentions` filter
 * on the LIQUIDITY_MIGRATOR account (`39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`,
 * per chainstacklabs/pumpfun-bonkfun-bot's address list) and capturing a real
 * migration: the actual invoked program in the logs was the MAIN pump.fun
 * program (this one, `PUMPFUN_PROGRAM_ID`), not the migrator address itself
 * — the migrator only appears as a referenced account. So this marker is
 * caught by the exact same subscription already used for CreateV2, no
 * second WebSocket/subscription needed.
 */
const MIGRATE_INSTRUCTION_LOG_MARKER = 'Instruction: Migrate'
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'
const GET_TRANSACTION_TIMEOUT_MS = 10_000
/** Below this retry count, reconnects are silent — same convention as pump-fun-feed.ts. */
const SILENT_RECONNECT_THRESHOLD = 3

export interface DiscoveredPool {
  mintAddress: string
  /** When this process received the WebSocket log notification — not on-chain blockTime (that requires the getTransaction round-trip below, and is only used for the one-off live latency measurement, not stored per-event to keep this path cheap). */
  discoveredAt: number
  signature: string
}

export interface GraduationEvent {
  mintAddress: string
  graduatedAt: number
  signature: string
  source: 'helius_logs'
}

export interface HeliusPoolFeedConfig {
  onNewPool: (pool: DiscoveredPool) => void
  /** Optional — a caller that doesn't pass this simply never learns about migrations (the Migrate log marker is still matched either way, since it costs nothing extra on an already-subscribed stream, but no getTransaction round-trip happens without a listener to hand the result to). */
  onGraduation?: (event: GraduationEvent) => void
  onError?: (err: Error) => void
  reconnectDelayMs?: number
  maxRetries?: number
}

/** Same sanitize-the-API-key convention as solana-rpc.ts/wallet-watcher.ts — this module resolves HELIUS_API_KEY independently rather than importing theirs, matching this directory's established duplication-over-cross-import pattern. */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const apiKey = process.env['HELIUS_API_KEY']
  return apiKey && msg.includes(apiKey) ? msg.replaceAll(apiKey, '***REDACTED***') : msg
}

interface LogsNotification {
  method?: string
  params?: {
    result?: {
      value?: { signature?: string; logs?: string[]; err?: unknown }
    }
  }
}

interface TokenBalanceEntry {
  accountIndex: number
  mint: string
}

interface TransactionBalances {
  preTokenBalances: TokenBalanceEntry[]
  postTokenBalances: TokenBalanceEntry[]
}

/**
 * Fetches a transaction's token-balance snapshot, shared by both mint-
 * extraction heuristics below (CreateV2 and Migrate diff the same raw data
 * differently — see each function's docstring for why one heuristic doesn't
 * serve both). Throttled through the same shared RPC gate as solana-rpc.ts/
 * wallet-watcher.ts (`rpc-concurrency.ts`) — this is the expensive part of
 * this feed (one HTTP round-trip per detected event, on top of the
 * always-on WebSocket firehose), and sharing the gate keeps this module
 * from adding its own uncoordinated load on top of the rest of the app's
 * Helius usage.
 */
async function fetchTransactionBalances(endpoint: string, signature: string): Promise<TransactionBalances | null> {
  return withRpcSlot(async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GET_TRANSACTION_TIMEOUT_MS)
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
        }),
        signal: controller.signal,
      })
      if (!resp.ok) {
        console.warn(`helius-pool-feed: getTransaction HTTP ${resp.status} for ${signature}`)
        return null
      }
      const payload = await resp.json() as {
        result?: { meta?: { preTokenBalances?: TokenBalanceEntry[]; postTokenBalances?: TokenBalanceEntry[] } }
        error?: { code: number; message: string }
      }
      if (payload.error) {
        console.warn(`helius-pool-feed: getTransaction RPC error for ${signature} — ${payload.error.message}`)
        return null
      }
      return {
        preTokenBalances: payload.result?.meta?.preTokenBalances ?? [],
        postTokenBalances: payload.result?.meta?.postTokenBalances ?? [],
      }
    } catch (err) {
      console.warn(`helius-pool-feed: getTransaction failed for ${signature} — ${sanitizeError(err)}`)
      return null
    } finally {
      clearTimeout(timeout)
    }
  })
}

/**
 * Extracts the newly-minted token's address for a CreateV2 transaction: the
 * first mint present in postTokenBalances that wasn't already in
 * preTokenBalances BY VALUE — confirmed live 2026-07-02 as reliable for
 * CreateV2, since the mint genuinely never existed before this transaction.
 */
async function fetchNewMintAddress(endpoint: string, signature: string): Promise<string | null> {
  const balances = await fetchTransactionBalances(endpoint, signature)
  if (!balances) return null
  const pre = new Set(balances.preTokenBalances.map(b => b.mint))
  const newMint = balances.postTokenBalances.find(b => !pre.has(b.mint))
  return newMint?.mint ?? null
}

/**
 * Extracts the migrated token's mint for a Migrate transaction. Diffing BY
 * VALUE (like `fetchNewMintAddress`) does NOT work here and was verified to
 * produce a WRONG answer 2026-07-02 on a real captured Migrate transaction:
 * the migrated mint already existed in preTokenBalances (it was created
 * earlier via CreateV2, not by this transaction), so a by-value diff finds
 * no "new" mint among the real token — and instead flags wrapped SOL
 * (`WRAPPED_SOL_MINT`) as "new", since that's the only mint VALUE absent
 * from preTokenBalances in a Migrate tx that only had a SOL-less bonding-
 * curve account beforehand.
 *
 * What DOES work, verified against that same real transaction: diff BY
 * ACCOUNT INDEX. A Migrate transaction creates two brand-new token accounts
 * for the freshly-created PumpSwap pool — one holding the meme-coin mint,
 * one holding wrapped SOL. Filtering the accountIndex-new entries down to
 * the one whose mint isn't wrapped SOL isolates the migrated mint. Real
 * example (sig `39jNwHWiA9...`): pre had only accountIndex 7 (the mint);
 * post added accountIndex 3 (same mint) and 4 (wrapped SOL) — this function
 * correctly returns the accountIndex-3 mint, not the wrapped-SOL one.
 */
async function tryExtractMint(endpoint: string, signature: string): Promise<string | null> {
  const balances = await fetchTransactionBalances(endpoint, signature)
  if (!balances) return null
  const preIndices = new Set(balances.preTokenBalances.map(b => b.accountIndex))
  const newAccounts = balances.postTokenBalances.filter(b => !preIndices.has(b.accountIndex))
  const migratedMint = newAccounts.find(b => b.mint !== WRAPPED_SOL_MINT)
  return migratedMint?.mint ?? null
}

const MIGRATE_EXTRACTION_MAX_RETRIES = 3
const MIGRATE_EXTRACTION_RETRY_DELAYS_MS = [2000, 4000]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retries `tryExtractMint` up to MIGRATE_EXTRACTION_MAX_RETRIES times —
 * added 2026-07-02 after a live run showed a ~70% first-attempt failure
 * rate (7/10 real graduations) on the SAME extraction logic that had
 * already been verified correct against a known-good sample. The most
 * likely cause: `getTransaction` fired the instant the WS notification
 * arrives can hit a Helius node that hasn't caught up to that exact
 * transaction yet (replication lag), not a heuristic defect — a short
 * retry gives that lag time to resolve. The 2s/4s delays are absorbed by
 * GRAD_IMMEDIATE_POST_GRAD_DELAY_MS's own 90s wait — see that constant's
 * docstring — so this adds no meaningful delay to the buy decision itself.
 */
async function fetchMigratedMint(endpoint: string, signature: string): Promise<string | null> {
  for (let attempt = 0; attempt < MIGRATE_EXTRACTION_MAX_RETRIES; attempt++) {
    const mint = await tryExtractMint(endpoint, signature)
    if (mint) {
      if (attempt > 0) {
        console.log(`helius-pool-feed: Graduation mint extracted on attempt ${attempt + 1}`)
      }
      return mint
    }
    if (attempt < MIGRATE_EXTRACTION_MAX_RETRIES - 1) {
      console.warn(`helius-pool-feed: Mint extraction failed (attempt ${attempt + 1}) — retrying in ${MIGRATE_EXTRACTION_RETRY_DELAYS_MS[attempt]}ms`)
      await sleep(MIGRATE_EXTRACTION_RETRY_DELAYS_MS[attempt]!)
    }
  }
  console.warn('helius-pool-feed: Graduation mint extraction failed after 3 attempts — graduation lost')
  return null
}

/**
 * Direct WebSocket subscription to pump.fun program logs via Helius
 * `logsSubscribe`. Reconnect logic mirrors `pump-fun-feed.ts`'s
 * `PumpFunFeed` — same config shape, same silent-below-threshold retry
 * warnings, same "close never reconnects after a voluntary stop()"
 * contract.
 *
 * The raw firehose is heavy — confirmed live 2026-07-02 at ~110
 * `logsNotification` messages/second on this one program (nearly all
 * buy/sell/swap traffic, not creations) — so every message is filtered
 * in-process for the `CREATE_INSTRUCTION_LOG_MARKER` string BEFORE the
 * costly `getTransaction` round-trip, keeping actual Helius credit
 * consumption proportional to real pool creations, not raw traffic volume.
 */
export class HeliusPoolFeed {
  private socket: WebSocket | null = null
  private retries = 0
  private stopped = true
  private readonly endpoint: string
  private readonly config: HeliusPoolFeedConfig & { reconnectDelayMs: number; maxRetries: number }
  /** Exposed for the hourly summary — how many getTransaction calls this feed has made, i.e. the actual Helius-credit-consuming cost, distinct from the free-to-receive WebSocket firehose. */
  private getTransactionCallCount = 0

  constructor(config: HeliusPoolFeedConfig) {
    this.config = { reconnectDelayMs: 3000, maxRetries: 10, ...config }
    const apiKey = process.env['HELIUS_API_KEY']
    this.endpoint = `https://mainnet.helius-rpc.com/?api-key=${apiKey ?? ''}`
  }

  /** Callers must check HELIUS_API_KEY is set before constructing/starting this feed — see live-scan.ts's runLiveScan, where a missing key skips this feed entirely rather than attempting an unauthenticated connection that would almost certainly be rate-limited off given the firehose volume. */
  start(): void {
    this.stopped = false
    this.retries = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.socket?.close()
    this.socket = null
  }

  getTransactionCallsMade(): number {
    return this.getTransactionCallCount
  }

  private connect(): void {
    if (this.stopped) return
    const apiKey = process.env['HELIUS_API_KEY']
    let socket: WebSocket
    try {
      socket = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${apiKey ?? ''}`)
    } catch (err) {
      this.handleConnectFailure(err)
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      this.retries = 0
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: 'confirmed' }],
      }))
    })
    socket.addEventListener('message', (ev) => {
      void this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
    })
    // Same ordering rationale as pump-fun-feed.ts: reconnect logic lives
    // exclusively in 'close', never duplicated into 'error', so a bad
    // connection never schedules two overlapping reconnect attempts.
    socket.addEventListener('close', () => {
      if (this.stopped) return
      this.reconnect()
    })
  }

  private handleConnectFailure(err: unknown): void {
    console.warn(`helius-pool-feed: connection attempt failed — ${sanitizeError(err)}`)
    this.reconnect()
  }

  private reconnect(): void {
    if (this.stopped) return
    this.retries++
    if (this.retries > this.config.maxRetries) {
      const err = new Error(`helius-pool-feed: max reconnect attempts (${this.config.maxRetries}) exceeded — giving up`)
      console.error(err.message)
      this.config.onError?.(err)
      return
    }
    if (this.retries >= SILENT_RECONNECT_THRESHOLD) {
      console.warn(`helius-pool-feed: reconnecting... (attempt ${this.retries}/${this.config.maxRetries})`)
    }
    setTimeout(() => {
      if (!this.stopped) this.connect()
    }, this.config.reconnectDelayMs)
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: LogsNotification
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.warn(`helius-pool-feed: malformed message, skipping — ${sanitizeError(err)}`)
      return
    }

    // Subscription ack (`{"result":<subId>}`) and any other non-notification
    // frame has no `params.result.value` — not a log event, silently ignored.
    const value = parsed.params?.result?.value
    if (parsed.method !== 'logsNotification' || !value) return
    if (value.err) return // failed transaction — not a real pool creation
    if (!value.signature) return

    const logs = value.logs ?? []
    // Cheap in-process filter BEFORE the costly getTransaction round-trip —
    // this is what keeps the ~110msg/s firehose from turning into ~110
    // RPC calls/s. See file header for why CREATE_INSTRUCTION_LOG_MARKER
    // needs periodic revalidation. Both markers are checked on the SAME
    // subscription (no second WebSocket) — see MIGRATE_INSTRUCTION_LOG_MARKER's
    // docstring for why Migrate shows up on this exact same pump.fun-program stream.
    //
    // endsWith, NOT includes — found live 2026-07-02 that `.includes()` was a
    // false-positive trap: the pump.fun program also emits an UNRELATED
    // `Instruction: MigrateBondingCurveCreator` (creator fee-sharing setup,
    // no pool creation at all) on this same log stream, and
    // `l.includes('Instruction: Migrate')` matched it as a prefix. Those
    // transactions never create a new pool, so mint extraction could never
    // succeed for them regardless of retry count — this wasn't a timing
    // race, it was matching the wrong instruction entirely. `endsWith`
    // requires nothing to follow the marker, which `MigrateBondingCurveCreator`
    // fails (and the real `Instruction: Migrate` graduation line passes,
    // confirmed against the live-captured sample in this file's header).
    const isCreateV2 = logs.some(l => l.endsWith(CREATE_INSTRUCTION_LOG_MARKER))
    const isMigrate = !isCreateV2 && logs.some(l => l.endsWith(MIGRATE_INSTRUCTION_LOG_MARKER))
    if (!isCreateV2 && !isMigrate) return

    const discoveredAt = Date.now()
    this.getTransactionCallCount++

    if (isCreateV2) {
      const mintAddress = await fetchNewMintAddress(this.endpoint, value.signature)
      if (!mintAddress) {
        console.warn(`helius-pool-feed: CreateV2 detected (sig ${value.signature.slice(0, 12)}...) but could not resolve a mint address — skipping`)
        return
      }
      try {
        this.config.onNewPool({ mintAddress, discoveredAt, signature: value.signature })
      } catch (err) {
        console.warn(`helius-pool-feed: onNewPool handler threw for mint ${mintAddress} — ${sanitizeError(err)}`)
      }
      return
    }

    // isMigrate — graduation. See extractMintFromMigrateTx question in the
    // implementation record: the user's original spec assumed accountKeys
    // would be available synchronously from the log notification itself;
    // verified live 2026-07-02 that logsSubscribe notifications never carry
    // accountKeys (only signature/logs/err), so this — like CreateV2 above —
    // requires its own getTransaction round-trip via fetchMigratedMint.
    if (!this.config.onGraduation) return // no listener wired up — skip the RPC call entirely, nothing would consume the result
    const mintAddress = await fetchMigratedMint(this.endpoint, value.signature)
    if (!mintAddress) {
      console.warn(`helius-pool-feed: Graduation detected but mint extraction failed (sig ${value.signature.slice(0, 12)}...)`)
      return
    }
    try {
      this.config.onGraduation({ mintAddress, graduatedAt: discoveredAt, signature: value.signature, source: 'helius_logs' })
    } catch (err) {
      console.warn(`helius-pool-feed: onGraduation handler threw for mint ${mintAddress} — ${sanitizeError(err)}`)
    }
  }
}
