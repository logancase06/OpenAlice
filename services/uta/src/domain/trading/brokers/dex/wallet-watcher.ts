/**
 * Wallet watcher — tracks Solana wallets by historical win rate, to
 * eventually surface a "smart money is buying this" signal per token.
 * Explicitly the lowest-value piece of Phase E until weeks of trade
 * history accumulate in `data/wallets/tracked.json` — see live-scan.ts's
 * `executeExit` for how that history gets fed (crediting/debiting the
 * wallets seen buying around our own paper entry with our own exit
 * outcome, since we don't independently observe each wallet's real P&L).
 *
 * `getRecentBuyers` uses a pragmatic simplification: it treats a
 * transaction's fee-payer (first signer) as the "buyer," rather than
 * diffing pre/postTokenBalances to find the exact wallet whose balance of
 * this mint increased. Precise delta-parsing would be meaningfully more
 * code for a feature whose own design already treats it as not useful
 * until well after this build lands.
 *
 * Raw JSON-RPC HTTP, same convention as solana-rpc.ts (no @solana/web3.js).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'
import { withRpcSlot } from './rpc-concurrency.js'

const REQUEST_TIMEOUT_MS = 10_000
const RECENT_WINDOW_MS = 30 * 60_000

/**
 * Circuit breaker for sustained 429s (confirmed live: hundreds per scan
 * cycle under real load, even against a dedicated Helius key) — after 3
 * consecutive 429 responses, stop issuing wallet-watcher RPC calls for 5
 * minutes rather than keep hammering an already-saturated endpoint. Any
 * non-429 response resets the streak.
 */
const CONSECUTIVE_429_THRESHOLD = 3
const THROTTLE_PAUSE_MS = 5 * 60_000
let consecutive429Count = 0
let throttledUntil = 0

function isThrottled(): boolean {
  return Date.now() < throttledUntil
}

function record429(): void {
  consecutive429Count++
  if (consecutive429Count >= CONSECUTIVE_429_THRESHOLD) {
    throttledUntil = Date.now() + THROTTLE_PAUSE_MS
    consecutive429Count = 0
    console.warn('wallet-watcher: Wallet watcher throttled, pausing RPC calls for 5 minutes')
  }
}

function recordSuccess(): void {
  consecutive429Count = 0
}

/** Test-only — resets the 429 circuit breaker's module-level state between specs. */
export function __resetThrottleStateForTests(): void {
  consecutive429Count = 0
  throttledUntil = 0
}

/** Same rationale as solana-rpc.ts's sanitizeError — `defaultEndpoint()` embeds HELIUS_API_KEY in the URL, so any error message that happens to echo the request URL must not leak it into logs. */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const apiKey = process.env['HELIUS_API_KEY']
  return apiKey && msg.includes(apiKey) ? msg.replaceAll(apiKey, '***REDACTED***') : msg
}

/**
 * Same rationale as solana-rpc.ts's `defaultSolanaRpcEndpoint` (duplicated
 * rather than imported — this module deliberately has no dependency on
 * solana-rpc.ts, see file header): public mainnet-beta 429s under this
 * module's `getSignaturesForAddress` + up to 20 `getTransaction` calls per
 * candidate. `HELIUS_API_KEY` routes to a dedicated endpoint instead.
 */
function defaultEndpoint(): string {
  const key = process.env['HELIUS_API_KEY']
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com'
}

export interface TrackedWallet {
  address: string
  addedAt: number
  wins: number
  losses: number
  totalTrades: number
  lastSeen: number
  avgReturn: number
}

export interface WalletSignal {
  walletAddress: string
  winRate: number
  totalTrades: number
}

function trackedWalletsPath(): string {
  return dataPath('wallets', 'tracked.json')
}

async function readTrackedWallets(): Promise<TrackedWallet[]> {
  try {
    const raw = await readFile(trackedWalletsPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TrackedWallet[]) : []
  } catch {
    return []
  }
}

async function writeTrackedWalletsAtomically(wallets: TrackedWallet[]): Promise<void> {
  const filePath = trackedWalletsPath()
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tmpPath, JSON.stringify(wallets, null, 2), 'utf-8')
  await rename(tmpPath, filePath)
}

async function rpcCall<T>(endpoint: string, method: string, params: unknown[]): Promise<T | null> {
  try {
    return await withRpcSlot(async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        })
        if (!resp.ok) {
          if (resp.status === 429) record429()
          console.warn(`wallet-watcher: ${method} -> HTTP ${resp.status}`)
          return null
        }
        const payload = await resp.json() as { result?: T; error?: { code: number; message: string } }
        if (payload.error) {
          console.warn(`wallet-watcher: ${method} -> RPC error ${payload.error.code}: ${payload.error.message}`)
          return null
        }
        recordSuccess()
        return payload.result ?? null
      } catch (err) {
        console.warn(`wallet-watcher: ${method} -> ${sanitizeError(err)}`)
        return null
      } finally {
        clearTimeout(timeout)
      }
    })
  } catch (err) {
    // withRpcSlot's own acquire() can throw (queue full) before `fn` ever
    // runs — that's outside the try/catch above, so it needs its own catch
    // here to keep this "never throws" for callers, same as every other
    // failure mode.
    console.warn(`wallet-watcher: ${method} -> ${sanitizeError(err)}`)
    return null
  }
}

interface SignatureInfo {
  signature: string
  blockTime: number | null
}

interface ParsedTransaction {
  transaction?: { message?: { accountKeys?: Array<{ pubkey: string; signer?: boolean }> } }
}

/** Best-effort wallets that transacted against `mintAddress` in the last 30 minutes. Never throws — any RPC failure at any stage returns []. */
export async function getRecentBuyers(
  mintAddress: string,
  maxResults = 20,
  endpoint: string = defaultEndpoint(),
): Promise<string[]> {
  if (isThrottled()) return []

  const signatures = await rpcCall<SignatureInfo[]>(endpoint, 'getSignaturesForAddress', [
    mintAddress,
    { limit: maxResults },
  ])
  // Array.isArray, not just truthy — rpcCall()'s `T` is unchecked at the type
  // level; an endpoint that answers with a well-formed but differently-shaped
  // `result` (e.g. an object) must fail safe to [] rather than crash on
  // `.filter` below. Found via wallet-bootstrapper.ts's TokenSecurityGuard
  // integration, where a test's fetch mock returned exactly this shape.
  if (!Array.isArray(signatures)) return []

  const cutoffSec = (Date.now() - RECENT_WINDOW_MS) / 1000
  const recent = signatures.filter(s => s.blockTime != null && s.blockTime >= cutoffSec)

  // Submitted concurrently — actual in-flight count is bounded to 3 by the
  // shared rpc-concurrency gate inside rpcCall(), not by this Promise.all.
  const transactions = await Promise.all(recent.map(sig => rpcCall<ParsedTransaction>(endpoint, 'getTransaction', [
    sig.signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
  ])))

  const buyers = new Set<string>()
  for (const tx of transactions) {
    const feePayer = tx?.transaction?.message?.accountKeys?.[0]?.pubkey
    if (feePayer) buyers.add(feePayer)
  }
  return [...buyers]
}

/** Accumulates win/loss history for a wallet. Never throws — a write failure is logged and swallowed. */
export async function updateWalletResult(address: string, won: boolean, returnPct: number): Promise<void> {
  try {
    const wallets = await readTrackedWallets()
    const existing = wallets.find(w => w.address === address)
    const now = Date.now()

    if (!existing) {
      wallets.push({
        address,
        addedAt: now,
        wins: won ? 1 : 0,
        losses: won ? 0 : 1,
        totalTrades: 1,
        lastSeen: now,
        avgReturn: returnPct,
      })
    } else {
      const totalTrades = existing.totalTrades + 1
      existing.avgReturn = (existing.avgReturn * existing.totalTrades + returnPct) / totalTrades
      existing.totalTrades = totalTrades
      if (won) existing.wins++
      else existing.losses++
      existing.lastSeen = now
    }

    await writeTrackedWalletsAtomically(wallets)
  } catch (err) {
    console.error(`wallet-watcher: failed to update result for ${address} — ${sanitizeError(err)}`)
  }
}

/**
 * Wallets that recently bought `mintAddress` (via `getRecentBuyers`) whose
 * tracked win rate clears the threshold — the "smart money is buying this"
 * signal. Thresholds default to 0.6/5, matching `TokenSecurityConfig`'s
 * `minWalletWinRate`/`minWalletTrades` defaults, so the guard's configured
 * values and this function's own default behavior stay in sync.
 */
export async function getWalletSignals(
  mintAddress: string,
  opts?: { minWinRate?: number; minTrades?: number; endpoint?: string },
): Promise<WalletSignal[]> {
  const minWinRate = opts?.minWinRate ?? 0.6
  const minTrades = opts?.minTrades ?? 5

  const buyers = await getRecentBuyers(mintAddress, 20, opts?.endpoint ?? defaultEndpoint())
  if (buyers.length === 0) return []

  const buyerSet = new Set(buyers)
  const wallets = await readTrackedWallets()

  return wallets
    .filter(w => buyerSet.has(w.address) && w.totalTrades >= minTrades && w.wins / w.totalTrades > minWinRate)
    .map(w => ({ walletAddress: w.address, winRate: w.wins / w.totalTrades, totalTrades: w.totalTrades }))
}

/** Total tracked wallets and how many already clear the default 0.6/5 signal threshold — used by the hourly summary. */
export async function getTrackedWalletSummary(): Promise<{ total: number; withSignal: number }> {
  const wallets = await readTrackedWallets()
  const withSignal = wallets.filter(w => w.totalTrades >= 5 && w.wins / w.totalTrades > 0.6).length
  return { total: wallets.length, withSignal }
}
