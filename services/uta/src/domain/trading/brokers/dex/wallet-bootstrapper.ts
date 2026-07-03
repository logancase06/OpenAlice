/**
 * Wallet bootstrapper — one-shot backfill of each wallet's OWN real trade
 * history, replacing `wallet-watcher.ts`'s flawed proxy signal for the
 * wallets it covers.
 *
 * `wallet-watcher.ts`'s `tracked.json` does NOT measure a wallet's own
 * performance: `updateWalletResult()` is called at OUR exit and credits
 * every co-buyer captured at OUR entry with OUR OWN `returnPct` (see that
 * file's header) — a wallet that sold seconds after us for a profit gets
 * marked "loss" in `tracked.json` because WE lost, regardless of what that
 * wallet actually did. This module instead fetches each wallet's own recent
 * signatures and parses its own buy/sell pairs directly from chain data, so
 * `winRate`/`avgReturn` here reflect the wallet's real behavior.
 *
 * Seed set (2026-07-02, by explicit decision — see conversation record):
 * `buyerWallets` captured on our own WINNING trades only (`returnPct > 0` in
 * `positions/closed/*.jsonl`) — 120 winners, only 5 had non-empty
 * `buyerWallets` at entry (`getRecentBuyers()` failing silently is the
 * common case, not the exception — see `wallet-watcher.ts`), yielding 80
 * unique wallets. RPC cost was NOT the limiting factor (estimated ~480
 * `getTransaction`/`getSignaturesForAddress` calls, ~8min) — seed size was.
 * Deliberately narrower than sourcing from ALL of `tracked.json`'s 296
 * wallets (which would include co-buyers of rugs) to keep this first run's
 * provenance clean.
 *
 * Known limitations, stated rather than hidden:
 *  - A sell is matched to the EARLIEST subsequent transaction (any program,
 *    not just pump.fun — a wallet may sell via PumpSwap/Raydium after a
 *    migration) that decrements the exact mint and increments SOL for the
 *    wallet. If a wallet buys the same mint twice before selling once, both
 *    buys can match the same sell (double-counted) — not corrected for,
 *    since re-entries into the same pump.fun mint are rare in this
 *    population.
 *  - `buyPriceSol`/`sellPriceSol` are SOL-per-token computed from the raw
 *    lamport delta (which includes network fees) divided by the token
 *    delta — a wallet's `returnPct` here is therefore priced in SOL, not
 *    USD, and ignores SOL/USD movement between buy and sell. Acceptable for
 *    a relative win/loss classification, not for absolute USD P&L.
 *  - Only the last `MAX_SIGNATURES_PER_WALLET` signatures are inspected —
 *    a very active wallet's older history is invisible to this pass.
 */
import { readFile, mkdir, rename, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataPath } from '@/core/paths.js'
import { withRpcSlot } from './rpc-concurrency.js'
import { getRecentBuyers, type WalletSignal } from './wallet-watcher.js'

const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const MAX_SIGNATURES_PER_WALLET = 50
const REQUEST_TIMEOUT_MS = 10_000
const CHECKPOINT_INTERVAL = 100
/** Different (shorter, unconditional) breaker than wallet-watcher.ts's 429-specific 5min pause — this is a one-shot batch job, not a live guard, so any 3 consecutive failures (not just 429s) pause it, per the explicit spec for this feature. */
const CONSECUTIVE_FAILURE_PAUSE_THRESHOLD = 3
const FAILURE_PAUSE_MS = 60_000
/** Matches wallet-watcher.ts's getWalletSignals defaults (0.6/5) so "qualified" means the same thing in both files. */
const QUALIFIED_MIN_WIN_RATE = 0.6
const QUALIFIED_MIN_TRADES = 5

export interface WalletTrade {
  mintAddress: string
  buyTimestamp: number
  buyPriceSol: number
  sellTimestamp?: number
  sellPriceSol?: number
  returnPct?: number
  stillOpen: boolean
}

export interface WalletTradeHistory {
  walletAddress: string
  trades: WalletTrade[]
  computedStats: {
    totalTrades: number
    winRate: number
    avgReturn: number
    lastActiveAt: number
  }
}

interface BootstrappedFile {
  bootstrappedAt: number
  walletCount: number
  qualifiedWallets: WalletTradeHistory[]
  allWallets: WalletTradeHistory[]
}

interface BootstrapProgress {
  processedAddresses: string[]
  startedAt: number
}

/** A qualified wallet sourced from outside our own on-chain parsing (e.g. Gmgn's ranking API — see fetch-external-wallets.ts). Pre-qualified by the source itself; still re-checked against the caller's own minWinRate/minTrades in `getBootstrappedSignals` for consistency, since a source's own bar may not match ours. */
export interface ExternalQualifiedWallet {
  walletAddress: string
  winRate: number
  totalTrades: number
  avgReturn: number
  source: string
}

interface ExternalWalletsFile {
  source: string
  fetchedAt: number
  qualifiedWallets: ExternalQualifiedWallet[]
}

export interface BootstrapReport {
  walletsAnalyzed: number
  tradesParsed: number
  qualifiedCount: number
  topWallets: WalletTradeHistory[]
  durationMs: number
  heliusCallsMade: number
}

/** Same duplication-over-cross-import convention as every other module in this directory. */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const apiKey = process.env['HELIUS_API_KEY']
  return apiKey && msg.includes(apiKey) ? msg.replaceAll(apiKey, '***REDACTED***') : msg
}

function defaultEndpoint(): string {
  const key = process.env['HELIUS_API_KEY']
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com'
}

function bootstrappedPath(): string {
  return dataPath('wallets', 'bootstrapped.json')
}
function progressPath(): string {
  return dataPath('wallets', 'bootstrap-progress.json')
}
function externalWalletsPath(): string {
  return dataPath('wallets', 'external-wallets.json')
}

/** Same atomic tmp+rename pattern as wallet-watcher.ts's writeTrackedWalletsAtomically. */
async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const { writeFile } = await import('node:fs/promises')
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmpPath, filePath)
}

async function readProgress(): Promise<BootstrapProgress> {
  try {
    return JSON.parse(await readFile(progressPath(), 'utf-8')) as BootstrapProgress
  } catch {
    return { processedAddresses: [], startedAt: Date.now() }
  }
}

async function readBootstrappedFileRaw(): Promise<BootstrappedFile | null> {
  try {
    return JSON.parse(await readFile(bootstrappedPath(), 'utf-8')) as BootstrappedFile
  } catch {
    return null
  }
}

async function readExternalWalletsFileRaw(): Promise<ExternalWalletsFile | null> {
  try {
    return JSON.parse(await readFile(externalWalletsPath(), 'utf-8')) as ExternalWalletsFile
  } catch {
    return null
  }
}

/** Persists an external-wallets.json — used by fetch-external-wallets.ts, exported so that script doesn't need to duplicate the atomic-write path. */
export async function writeExternalWalletsFile(data: ExternalWalletsFile): Promise<void> {
  await writeJsonAtomically(externalWalletsPath(), data)
}

let consecutiveFailures = 0
let heliusCallCounter = 0

/** Test-only — resets module-level counters between specs. */
export function __resetBootstrapStateForTests(): void {
  consecutiveFailures = 0
  heliusCallCounter = 0
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Raw JSON-RPC HTTP via the shared concurrency gate. Never throws — returns null on any failure, tracking a simple consecutive-failure counter that pauses the whole bootstrap run (not just this call) after 3 in a row, per this feature's spec. */
async function rpcCall<T>(endpoint: string, method: string, params: unknown[]): Promise<T | null> {
  heliusCallCounter++
  try {
    const result = await withRpcSlot(async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const payload = await resp.json() as { result?: T; error?: { code: number; message: string } }
        if (payload.error) throw new Error(`RPC error ${payload.error.code}: ${payload.error.message}`)
        return payload.result ?? null
      } finally {
        clearTimeout(timeout)
      }
    })
    consecutiveFailures = 0
    return result
  } catch (err) {
    consecutiveFailures++
    console.warn(`wallet-bootstrapper: ${method} failed (${consecutiveFailures} consecutive) — ${sanitizeError(err)}`)
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD) {
      console.warn(`wallet-bootstrapper: ${CONSECUTIVE_FAILURE_PAUSE_THRESHOLD} consecutive failures — pausing ${FAILURE_PAUSE_MS / 1000}s`)
      await sleep(FAILURE_PAUSE_MS)
      consecutiveFailures = 0
    }
    return null
  }
}

interface SignatureInfo {
  signature: string
  blockTime: number | null
}

interface TokenBalanceEntry {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount?: { uiAmount: number | null }
}

interface ParsedTransaction {
  meta?: {
    err?: unknown
    preBalances?: number[]
    postBalances?: number[]
    preTokenBalances?: TokenBalanceEntry[]
    postTokenBalances?: TokenBalanceEntry[]
  }
  transaction?: { message?: { accountKeys?: Array<{ pubkey: string; signer?: boolean }> } }
  blockTime?: number | null
}

/** The one token balance owned by `owner` whose amount changed between pre/post — null if none did. */
function tokenDeltaForOwner(
  pre: TokenBalanceEntry[] | undefined,
  post: TokenBalanceEntry[] | undefined,
  owner: string,
): { mint: string; delta: number } | null {
  const preByIndex = new Map((pre ?? []).filter(b => b.owner === owner).map(b => [b.accountIndex, b.uiTokenAmount?.uiAmount ?? 0]))
  for (const p of post ?? []) {
    if (p.owner !== owner) continue
    const before = preByIndex.get(p.accountIndex) ?? 0
    const after = p.uiTokenAmount?.uiAmount ?? 0
    if (after !== before) return { mint: p.mint, delta: after - before }
  }
  return null
}

/** A pump.fun buy: the program is present in this tx's accounts, `walletAddress` is one of its accounts, its SOL balance decreased (price + fee), and one of its token balances increased. */
function parsePumpFunBuy(tx: ParsedTransaction, walletAddress: string): { mintAddress: string; buyPriceSol: number; buyTimestamp: number } | null {
  if (tx.meta?.err) return null
  const accountKeys = tx.transaction?.message?.accountKeys ?? []
  if (!accountKeys.some(k => k.pubkey === PUMPFUN_PROGRAM_ID)) return null
  const walletIndex = accountKeys.findIndex(k => k.pubkey === walletAddress)
  if (walletIndex === -1) return null

  const preBalances = tx.meta?.preBalances ?? []
  const postBalances = tx.meta?.postBalances ?? []
  const solDeltaLamports = (postBalances[walletIndex] ?? 0) - (preBalances[walletIndex] ?? 0)
  if (solDeltaLamports >= 0) return null

  const tokenDelta = tokenDeltaForOwner(tx.meta?.preTokenBalances, tx.meta?.postTokenBalances, walletAddress)
  if (!tokenDelta || tokenDelta.delta <= 0) return null

  return {
    mintAddress: tokenDelta.mint,
    buyPriceSol: Math.abs(solDeltaLamports) / 1e9 / tokenDelta.delta,
    buyTimestamp: (tx.blockTime ?? 0) * 1000,
  }
}

/** A sell of `mintAddress` by `walletAddress`: SOL balance increased, and that exact mint's token balance decreased. No pump.fun-program requirement — the wallet may sell via a different program after a migration. */
function parseSellForMint(tx: ParsedTransaction, walletAddress: string, mintAddress: string): { sellPriceSol: number; sellTimestamp: number } | null {
  if (tx.meta?.err) return null
  const accountKeys = tx.transaction?.message?.accountKeys ?? []
  const walletIndex = accountKeys.findIndex(k => k.pubkey === walletAddress)
  if (walletIndex === -1) return null

  const preBalances = tx.meta?.preBalances ?? []
  const postBalances = tx.meta?.postBalances ?? []
  const solDeltaLamports = (postBalances[walletIndex] ?? 0) - (preBalances[walletIndex] ?? 0)
  if (solDeltaLamports <= 0) return null

  const tokenDelta = tokenDeltaForOwner(tx.meta?.preTokenBalances, tx.meta?.postTokenBalances, walletAddress)
  if (!tokenDelta || tokenDelta.mint !== mintAddress || tokenDelta.delta >= 0) return null

  return {
    sellPriceSol: solDeltaLamports / 1e9 / Math.abs(tokenDelta.delta),
    sellTimestamp: (tx.blockTime ?? 0) * 1000,
  }
}

/**
 * Fetches `walletAddress`'s last `MAX_SIGNATURES_PER_WALLET` signatures,
 * parses each transaction for pump.fun buys and any later matching sell, and
 * computes real winRate/avgReturn from the closed pairs found. Never
 * throws — an unreachable wallet (RPC failure at every step) returns an
 * empty, zero-stat history rather than aborting the whole bootstrap run.
 */
export async function bootstrapWallet(walletAddress: string, endpoint: string = defaultEndpoint()): Promise<WalletTradeHistory> {
  const signatures = await rpcCall<SignatureInfo[]>(endpoint, 'getSignaturesForAddress', [walletAddress, { limit: MAX_SIGNATURES_PER_WALLET }])
  const sorted = (signatures ?? []).slice().sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))

  const txs = await Promise.all(sorted.map(s => rpcCall<ParsedTransaction>(endpoint, 'getTransaction', [
    s.signature,
    { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ])))

  const buys: Array<{ mintAddress: string; buyPriceSol: number; buyTimestamp: number; txIndex: number }> = []
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]
    if (!tx) continue
    const buy = parsePumpFunBuy(tx, walletAddress)
    if (buy) buys.push({ ...buy, txIndex: i })
  }

  const trades: WalletTrade[] = buys.map((buy) => {
    let sell: { sellPriceSol: number; sellTimestamp: number } | null = null
    for (let i = buy.txIndex + 1; i < txs.length; i++) {
      const tx = txs[i]
      if (!tx) continue
      sell = parseSellForMint(tx, walletAddress, buy.mintAddress)
      if (sell) break
    }
    const returnPct = sell ? ((sell.sellPriceSol - buy.buyPriceSol) / buy.buyPriceSol) * 100 : undefined
    return {
      mintAddress: buy.mintAddress,
      buyTimestamp: buy.buyTimestamp,
      buyPriceSol: buy.buyPriceSol,
      sellTimestamp: sell?.sellTimestamp,
      sellPriceSol: sell?.sellPriceSol,
      returnPct,
      stillOpen: !sell,
    }
  })

  const closedTrades = trades.filter(t => !t.stillOpen)
  const wins = closedTrades.filter(t => (t.returnPct ?? 0) > 0)
  return {
    walletAddress,
    trades,
    computedStats: {
      totalTrades: closedTrades.length,
      winRate: closedTrades.length ? wins.length / closedTrades.length : 0,
      avgReturn: closedTrades.length ? closedTrades.reduce((a, t) => a + (t.returnPct ?? 0), 0) / closedTrades.length : 0,
      lastActiveAt: Date.now(),
    },
  }
}

interface ClosedPositionForSeed {
  returnPct: number
  buyerWallets?: string[]
}

async function readClosedPositionFiles(): Promise<string[]> {
  const dir = dataPath('positions', 'closed')
  try {
    const names = await readdir(dir)
    return names.filter(n => n.endsWith('.jsonl')).map(n => join(dir, n))
  } catch {
    return []
  }
}

/** Unique `buyerWallets` captured on our own winning trades (`returnPct > 0`), across every closed-position log file present — not just "today". See file header for why winning-trades-only was chosen as the seed. */
export async function collectSeedWallets(): Promise<string[]> {
  const files = await readClosedPositionFiles()
  const seen = new Set<string>()
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(file, 'utf-8')
    } catch {
      continue
    }
    for (const line of raw.trim().split('\n')) {
      if (!line) continue
      let rec: ClosedPositionForSeed
      try {
        rec = JSON.parse(line) as ClosedPositionForSeed
      } catch {
        continue
      }
      if (rec.returnPct > 0 && Array.isArray(rec.buyerWallets)) {
        for (const w of rec.buyerWallets) seen.add(w)
      }
    }
  }
  return [...seen]
}

async function persistBootstrappedFile(resultsByAddress: Map<string, WalletTradeHistory>): Promise<void> {
  const allWallets = [...resultsByAddress.values()]
  const qualifiedWallets = allWallets.filter(w => w.computedStats.totalTrades >= QUALIFIED_MIN_TRADES && w.computedStats.winRate > QUALIFIED_MIN_WIN_RATE)
  const data: BootstrappedFile = {
    bootstrappedAt: Date.now(),
    walletCount: allWallets.length,
    qualifiedWallets,
    allWallets,
  }
  await writeJsonAtomically(bootstrappedPath(), data)
}

/**
 * Runs the bootstrap over `collectSeedWallets()`, capped at `maxWallets`.
 * Resumable: `data/wallets/bootstrap-progress.json` records processed
 * addresses, checkpointed every `CHECKPOINT_INTERVAL` wallets (and always at
 * the end) — a re-run skips addresses already present there rather than
 * re-spending RPC calls on them. Output goes to
 * `data/wallets/bootstrapped.json`, entirely separate from
 * `wallet-watcher.ts`'s `tracked.json`.
 */
export async function runBootstrap(opts: { maxWallets?: number; endpoint?: string } = {}): Promise<BootstrapReport> {
  const startedAt = Date.now()
  const endpoint = opts.endpoint ?? defaultEndpoint()
  const seedAll = await collectSeedWallets()
  const seed = seedAll.slice(0, opts.maxWallets ?? 500)

  const progress = await readProgress()
  const alreadyDone = new Set(progress.processedAddresses)
  const existing = await readBootstrappedFileRaw()
  const resultsByAddress = new Map<string, WalletTradeHistory>((existing?.allWallets ?? []).map(w => [w.walletAddress, w]))

  let processedThisRun = 0
  let tradesParsed = 0
  for (const address of seed) {
    if (alreadyDone.has(address)) continue
    const history = await bootstrapWallet(address, endpoint)
    resultsByAddress.set(address, history)
    tradesParsed += history.trades.length
    progress.processedAddresses.push(address)
    processedThisRun++
    if (processedThisRun % CHECKPOINT_INTERVAL === 0) {
      await writeJsonAtomically(progressPath(), progress)
      await persistBootstrappedFile(resultsByAddress)
    }
  }
  await writeJsonAtomically(progressPath(), progress)
  await persistBootstrappedFile(resultsByAddress)

  const allWallets = [...resultsByAddress.values()]
  const qualified = allWallets.filter(w => w.computedStats.totalTrades >= QUALIFIED_MIN_TRADES && w.computedStats.winRate > QUALIFIED_MIN_WIN_RATE)
  const topWallets = allWallets.slice().sort((a, b) => b.computedStats.winRate - a.computedStats.winRate).slice(0, 5)

  return {
    walletsAnalyzed: allWallets.length,
    tradesParsed,
    qualifiedCount: qualified.length,
    topWallets,
    durationMs: Date.now() - startedAt,
    heliusCallsMade: heliusCallCounter,
  }
}

interface QualifiableWallet {
  walletAddress: string
  winRate: number
  totalTrades: number
}

/**
 * Merges our own `bootstrapped.json` (`allWallets`, from real on-chain
 * parsing) with `external-wallets.json` (from a source like Gmgn's ranking
 * API — see `fetch-external-wallets.ts`), our own data taking precedence on
 * an address collision (same trust bar as everywhere else in this codebase:
 * a real measurement over any external/proxy one). Either file missing is
 * not an error — merges with whatever exists.
 */
async function readMergedQualifiableWallets(): Promise<QualifiableWallet[]> {
  const [bootstrapped, external] = await Promise.all([readBootstrappedFileRaw(), readExternalWalletsFileRaw()])
  const byAddress = new Map<string, QualifiableWallet>()
  for (const w of bootstrapped?.allWallets ?? []) {
    byAddress.set(w.walletAddress, { walletAddress: w.walletAddress, winRate: w.computedStats.winRate, totalTrades: w.computedStats.totalTrades })
  }
  for (const w of external?.qualifiedWallets ?? []) {
    if (!byAddress.has(w.walletAddress)) {
      byAddress.set(w.walletAddress, { walletAddress: w.walletAddress, winRate: w.winRate, totalTrades: w.totalTrades })
    }
  }
  return [...byAddress.values()]
}

/**
 * Recent buyers of `mintAddress` (via `wallet-watcher.ts`'s `getRecentBuyers`
 * — reused rather than duplicated, unlike the small per-file helpers in this
 * directory, since it's already an exported, general-purpose operation)
 * cross-referenced against the merged `bootstrapped.json` + `external-wallets.json`
 * qualified-wallet pool (see `readMergedQualifiableWallets`) — this
 * codebase's only wallet signal backed by each wallet's own real trade
 * history rather than our own trade outcome. Returns `[]` (not an error) if
 * neither source file exists yet — callers must not fail-closed on
 * "bootstrap/fetch hasn't run".
 */
export async function getBootstrappedSignals(
  mintAddress: string,
  opts?: { minWinRate?: number; minTrades?: number; endpoint?: string },
): Promise<WalletSignal[]> {
  const minWinRate = opts?.minWinRate ?? QUALIFIED_MIN_WIN_RATE
  const minTrades = opts?.minTrades ?? QUALIFIED_MIN_TRADES

  const buyers = await getRecentBuyers(mintAddress, 20, opts?.endpoint ?? defaultEndpoint())
  if (buyers.length === 0) return []

  const wallets = await readMergedQualifiableWallets()
  if (wallets.length === 0) return []

  const buyerSet = new Set(buyers)
  return wallets
    .filter(w => buyerSet.has(w.walletAddress) && w.totalTrades >= minTrades && w.winRate > minWinRate)
    .map(w => ({ walletAddress: w.walletAddress, winRate: w.winRate, totalTrades: w.totalTrades }))
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

function formatReport(report: BootstrapReport): string {
  const lines: string[] = []
  lines.push('=== Bootstrap terminé ===')
  lines.push(`Wallets analysés     : ${report.walletsAnalyzed}`)
  lines.push(`Trades parsés        : ${report.tradesParsed}`)
  lines.push(`Wallets qualifiés    : ${report.qualifiedCount} (winRate>${QUALIFIED_MIN_WIN_RATE * 100}%, trades>=${QUALIFIED_MIN_TRADES})`)
  lines.push('Top 5 wallets :')
  for (const w of report.topWallets) {
    lines.push(`  ${w.walletAddress}  winRate: ${(w.computedStats.winRate * 100).toFixed(1)}%  trades: ${w.computedStats.totalTrades}  avgReturn: ${fmtPct(w.computedStats.avgReturn)}`)
  }
  lines.push(`Temps total          : ${(report.durationMs / 60_000).toFixed(1)}min`)
  lines.push(`Appels Helius        : ${report.heliusCallsMade}`)
  return lines.join('\n')
}

async function runMain(): Promise<void> {
  const maxWalletsArgIndex = process.argv.indexOf('--max-wallets')
  const maxWallets = maxWalletsArgIndex !== -1 ? Number(process.argv[maxWalletsArgIndex + 1]) : undefined
  const report = await runBootstrap({ maxWallets })
  console.log(formatReport(report))
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
if (isMainModule) {
  runMain().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
