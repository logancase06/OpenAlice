/**
 * Position tracker — the trade journal that `DexBroker`'s own internal
 * ledger doesn't keep: entry timestamp/age/peak-price per position, and a
 * closed-position history with exit reasons, for exit-rule evaluation and
 * performance reporting. Deliberately separate from `DexBroker`'s
 * cash/avgCost ledger (which stays the source of truth for account
 * balances) — this module is the source of truth for *why* and *when* a
 * position was opened/closed, same separation of concerns as
 * `liquidity-tracker.ts` being a read/write time-series next to (not
 * inside) the guard that reads it.
 *
 * Plain JSON/JSONL files under `data/positions/` — NOT TradingGit
 * (git-persistence.ts is a different, untouched concern; see live-scan.ts's
 * file header for the same reasoning applied to snapshots).
 */
import { readFile, writeFile, mkdir, rename, appendFile, open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataPath } from '@/core/paths.js'
import type { DexScreenerPair } from './dex-market-data.js'

const LOCK_RETRY_DELAY_MS = 100
const LOCK_MAX_RETRIES = 10

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type StrategyLabel = 'conservative' | 'early' | 'momentum' | 'scalp_momentum' | 'early_strict' | 'copy_wallet' | 'grad_immediate' | 'grad_dip'

export type ExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit'
  | 'time_exit'
  | 'momentum_reversal'
  | 'liquidity_drain'
  | 'manual'

/**
 * Exit-rule thresholds, captured at the moment a position is opened and
 * stored WITH the position — not re-derived from whatever the currently
 * running process's strategy config says. Without this, a config change
 * between two scanner restarts would silently retroactively change the
 * exit rules for a position that was opened under different assumptions.
 */
export interface PositionExitConfig {
  stopLoss: number
  takeProfit: number
  /** Trailing stop only arms once the position's peak return has cleared this — before that, dropFromPeak is ignored entirely. */
  trailingStopActivationPct: number
  trailingStopPct: number
  momentumThreshold: number
  timeExitMinutes: number
}

export interface OpenPosition {
  id: string
  pairAddress: string
  /** Not in the original spec's field list, but required to actually re-quote/re-sell the position later — pairAddress alone doesn't resolve to a DexScreener/broker lookup. */
  tokenAddress: string
  symbol: string
  strategy: StrategyLabel
  entryPrice: number
  entryLiquidityUsd: number
  entryTimestamp: number
  entryAgeMinutes: number
  peakPrice: number
  lastCheckedAt: number
  /** Wallets seen buying this token around entry time, best-effort (see wallet-watcher.ts) — [] if unavailable/not solana. Used to credit/debit wallet win-rate tracking when this position closes. */
  buyerWallets: string[]
  exitConfig: PositionExitConfig
  /**
   * priceChange.m5 as of the last exit-check cycle that didn't close this
   * position — set by `updatePeakPrice`. `momentum_reversal` requires this
   * to be present and for the new reading to be more negative than it
   * (accelerating, not just a one-off dip) — see evaluateExitRules's
   * docstring. Absent on the first cycle after opening (nothing to compare
   * against yet) and on positions restored from before this field existed;
   * both cases correctly mean "can't detect acceleration yet," not an error.
   */
  lastPriceChange5m?: number
  /**
   * The raw price observed at the last exit-check cycle that didn't close
   * this position — set by `updatePeakPrice`, one cycle behind by
   * construction (only updated on the NON-exiting branch of `checkExits`,
   * so when a check DOES trigger an exit, this field still holds the prior
   * cycle's price, not the crashed one). Adopted 2026-07-02 alongside the
   * stop_loss-overshoot log in `checkExits` — its whole purpose is
   * answering "how fast did the price move between two consecutive
   * checks," the exact data that was unavailable retroactively for the
   * EARLY rugs analyzed that same day (see FAST_EXIT_REGIME_LABELS's
   * docstring in live-scan.ts). Absent on the first check after opening
   * (nothing prior to compare against) and on positions restored from
   * before this field existed — both correctly mean "no prior tick to
   * diff against," not an error.
   */
  lastCheckedPrice?: number
  /**
   * True only for a position opened by a strategy in live-scan.ts's
   * `FAST_EXIT_REGIME_LABELS` — a shared fast exit-check timer decoupled
   * from the main scan loop's (much slower, 300s default) `intervalSeconds`.
   * Adopted 2026-07-02 for `grad_immediate` first, after live evidence of
   * positions closing 25-74pp past their configured stopLoss under the old
   * 300s cadence (Guy -78.5%, CLAUDISH -83.6%, nope -88.5%, TRADE -49.2%/
   * -93.8%). Extended the same day to `early`/`early_strict` after
   * cross-referencing 14 previously-identified EARLY "rugs" against real
   * scan-log price ticks: 7 had a directly-observed safe price shortly
   * before a sub-2-minute collapse to -51%..-99% (e.g. empire: +5.9% ->
   * -91.5% in 109 seconds) that a 300s check window structurally cannot
   * catch mid-fall. Capping just those 7 at their configured -20% stopLoss
   * moves EARLY's full-history aggregate mean return from -3.374% to
   * -2.620% (n=572, +0.754pp) — modest in aggregate, up to +78.8pp on the
   * worst individual case (ROBINSEM). See FAST_EXIT_REGIME_LABELS's
   * docstring in live-scan.ts for the full per-strategy evidence and the
   * still-undetermined cases (ANSEM, devwork, LOOT — no intermediate tick
   * either way) worth re-examining if similar cases recur under this fix.
   *
   * Absent/undefined (NOT `false`) on every position opened before its
   * strategy was added to the fast regime — including ones still open at
   * deploy time that only finish their lifecycle afterward — so this field
   * alone, without needing any hardcoded cutover timestamp, distinguishes a
   * "clean" fast-regime closed trade (this field `true`) from one
   * contaminated by the slow-cadence measurement problem (field absent). A
   * position opened for a strategy that does NOT have a fast timer (e.g.
   * `conservative`/`grad_dip`, deliberately left on the 300s cadence — no
   * equivalent stop_loss-overshoot evidence found for either) is also left
   * undefined, not `false` — `false` is intentionally never written, to
   * keep "undefined = not fast-regime-eligible OR predates the distinction
   * entirely" as a single unambiguous case for retrospective analysis.
   */
  fastExitRegime?: boolean
}

export interface ClosedPosition extends OpenPosition {
  exitPrice: number
  exitTimestamp: number
  exitReason: ExitReason
  returnPct: number
  holdingMinutes: number
}

export interface DailyStats {
  totalClosed: number
  winRate: number
  avgReturn: number
  bestReturn: number
  worstReturn: number
  byReason: Record<ExitReason, number>
}

const EXIT_REASONS: ExitReason[] = [
  'stop_loss', 'trailing_stop', 'take_profit', 'time_exit', 'momentum_reversal', 'liquidity_drain', 'manual',
]

function openPositionsPath(): string {
  return dataPath('positions', 'open.json')
}

function closedPositionsPath(date: string = new Date().toISOString().slice(0, 10)): string {
  return dataPath('positions', 'closed', `${date}.jsonl`)
}

/**
 * Matches "ConfigD" in scripts/scan/live-scan.ts (EARLY_EXIT_CONFIG) —
 * every position ever opened before `exitConfig` existed on OpenPosition
 * was in fact running under these exact thresholds, so backfilling this
 * default on read preserves their real behavior rather than crashing
 * `evaluateExitRules`'s destructuring on `undefined` (confirmed live: a
 * scan cycle crash-looped on restored pre-migration positions). Duplicated
 * here rather than imported — this module doesn't depend on a scan script,
 * same convention as dex-market-data.ts/wallet-watcher.ts's independent
 * HELIUS_API_KEY resolution.
 */
const LEGACY_DEFAULT_EXIT_CONFIG: PositionExitConfig = {
  stopLoss: -20,
  takeProfit: 200,
  trailingStopActivationPct: 12,
  trailingStopPct: -15,
  momentumThreshold: -10,
  timeExitMinutes: 180,
}

/**
 * ENOENT (no file yet — normal on first run) is the only case that silently
 * returns []. Anything else (open.json is a directory, corrupt JSON, a
 * permission error) means the real on-disk position state is unknown — that
 * must NOT be silently treated as "zero open positions," since a scanner
 * that believes it holds nothing when it actually holds something can
 * re-buy an already-open token, and the next write would overwrite the real
 * file with an empty/incomplete list, permanently losing whatever was there.
 * Refusing to start (throwing) is deliberate: safe to lose availability,
 * never safe to silently lose track of real (paper) positions.
 */
async function readOpenPositions(): Promise<OpenPosition[]> {
  let raw: string
  try {
    raw = await readFile(openPositionsPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
      console.error(`position-tracker: CRITICAL: ${openPositionsPath()} is a directory, not a file — refusing to start`)
      throw err
    }
    console.error(`position-tracker: CRITICAL: failed to read open.json — ${err instanceof Error ? err.message : String(err)}`)
    console.error('position-tracker: CRITICAL: positions state is unknown — refusing to start to avoid double-buys or silently losing open positions')
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`position-tracker: CRITICAL: open.json is corrupted (invalid JSON) — ${err instanceof Error ? err.message : String(err)}`)
    console.error('position-tracker: CRITICAL: positions state is unknown — refusing to start to avoid double-buys or silently losing open positions')
    throw err
  }
  if (!Array.isArray(parsed)) return []
  return (parsed as OpenPosition[]).map(p => (p.exitConfig ? p : { ...p, exitConfig: LEGACY_DEFAULT_EXIT_CONFIG }))
}

async function writeOpenPositionsAtomically(positions: OpenPosition[]): Promise<void> {
  const filePath = openPositionsPath()
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tmpPath, JSON.stringify(positions, null, 2), 'utf-8')
  await rename(tmpPath, filePath)
}

function openPositionsLockPath(): string {
  return `${openPositionsPath()}.lock`
}

/**
 * Guards the open.json read-modify-write cycle against the lost-update race
 * confirmed live: two overlapping live-scan processes (e.g. a restart where
 * the old process hadn't fully exited yet) each read open.json, mutate
 * their own in-memory copy, and write it back — the second write silently
 * drops whatever the first added (a real position vanished this way during
 * testing, with no trace in open.json or the closed JSONL). Exclusive
 * create (`wx` — fails if the lock file already exists) makes acquisition
 * atomic; contenders retry rather than block indefinitely. On sustained
 * contention (stuck lock from a crashed process, or a second live-scan
 * genuinely running), the write is logged and abandoned rather than risking
 * a corrupt/torn file — see `clearStaleLockIfPresent` for the startup-time
 * cleanup of a lock left behind by a crash.
 */
async function withOpenPositionsLock<T>(onAbandoned: () => T, fn: () => Promise<T>): Promise<T> {
  const lock = openPositionsLockPath()
  await mkdir(dirname(lock), { recursive: true }) // lock creation needs the parent dir to exist first (ENOENT otherwise, not EEXIST)
  let acquired = false
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      const handle = await open(lock, 'wx')
      await handle.close()
      acquired = true
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }
  if (!acquired) {
    console.error(`position-tracker: could not acquire open.json lock after ${LOCK_MAX_RETRIES} attempts (${LOCK_MAX_RETRIES * LOCK_RETRY_DELAY_MS}ms) — abandoning this write`)
    return onAbandoned()
  }
  try {
    return await fn()
  } finally {
    try { await unlink(lock) } catch { /* already gone */ }
  }
}

/** Removes a lock file left behind by a crashed/killed previous process — call once at scanner startup, before any position read/write. A lock present at startup can only be stale: nothing else is running yet. */
export async function clearStaleLockIfPresent(): Promise<void> {
  try {
    await unlink(openPositionsLockPath())
    console.warn('position-tracker: Stale lock file found — removing')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/** Read-after-write sanity check — detection, not prevention: if this ever fires, the lock above failed to do its job and a write was lost or corrupted. */
async function verifyOpenPositionsWrite(expectedCount: number): Promise<void> {
  const reread = await readOpenPositions()
  if (reread.length !== expectedCount) {
    console.error(`position-tracker: CRITICAL: open.json write verification failed — expected ${expectedCount} positions, found ${reread.length}`)
  }
}

export async function openPosition(
  pair: DexScreenerPair,
  strategy: StrategyLabel,
  entryPrice: number,
  entryAgeMinutes: number,
  exitConfig: PositionExitConfig,
  buyerWallets: string[] = [],
  fastExitRegime?: boolean,
): Promise<OpenPosition> {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`openPosition: invalid entryPrice ${entryPrice} for ${pair.baseToken.symbol}`)
  }
  const position: OpenPosition = {
    id: randomUUID(),
    pairAddress: pair.pairAddress,
    tokenAddress: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    strategy,
    entryPrice,
    entryLiquidityUsd: pair.liquidity?.usd ?? 0,
    entryTimestamp: Date.now(),
    entryAgeMinutes,
    peakPrice: entryPrice,
    lastCheckedAt: Date.now(),
    buyerWallets,
    exitConfig,
    fastExitRegime,
  }
  return withOpenPositionsLock(
    () => {
      console.error(`position-tracker: CRITICAL: lock contention — ${position.symbol} (${strategy}) was NOT persisted to open.json; it will not survive a restart`)
      return position
    },
    async () => {
      const existing = await readOpenPositions()
      const updated = [...existing, position]
      await writeOpenPositionsAtomically(updated)
      await verifyOpenPositionsWrite(updated.length)
      return position
    },
  )
}

/** Removes the position from open.json and appends the closed record to today's JSONL. Returns null if no such open position exists (already closed / bad id), or if lock contention forced abandoning the write — never throws. */
export async function closePosition(id: string, exitPrice: number, reason: ExitReason): Promise<ClosedPosition | null> {
  return withOpenPositionsLock(
    () => null,
    async () => {
      const existing = await readOpenPositions()
      const position = existing.find(p => p.id === id)
      if (!position) return null

      const exitTimestamp = Date.now()
      const closed: ClosedPosition = {
        ...position,
        exitPrice,
        exitTimestamp,
        exitReason: reason,
        returnPct: ((exitPrice - position.entryPrice) / position.entryPrice) * 100,
        holdingMinutes: (exitTimestamp - position.entryTimestamp) / 60_000,
      }

      const remaining = existing.filter(p => p.id !== id)
      await writeOpenPositionsAtomically(remaining)
      await verifyOpenPositionsWrite(remaining.length)

      const filePath = closedPositionsPath()
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, `${JSON.stringify(closed)}\n`, 'utf-8')

      return closed
    },
  )
}

export async function getOpenPositions(): Promise<OpenPosition[]> {
  return readOpenPositions()
}

/**
 * peakPrice only ever moves up; lastCheckedAt always advances to now;
 * lastCheckedPrice is unconditionally overwritten to `currentPrice` (see
 * that field's own docstring — it's meant to be "one cycle ago," not a
 * running extreme like peakPrice). Matches checkExits() calling this once
 * per cycle for every position it didn't just close. `priceChange5m`, when
 * provided, becomes this cycle's `lastPriceChange5m` for the *next* cycle's
 * momentum_reversal acceleration check — deliberately overwritten every
 * call (not just when it moves in one direction), since "the previous
 * reading" always means "one cycle ago," not some running extreme.
 */
export async function updatePeakPrice(id: string, currentPrice: number, priceChange5m?: number): Promise<void> {
  return withOpenPositionsLock(
    () => undefined,
    async () => {
      const existing = await readOpenPositions()
      const position = existing.find(p => p.id === id)
      if (!position) return
      position.peakPrice = Math.max(position.peakPrice, currentPrice)
      position.lastCheckedPrice = currentPrice
      position.lastCheckedAt = Date.now()
      if (priceChange5m != null) position.lastPriceChange5m = priceChange5m
      await writeOpenPositionsAtomically(existing)
      await verifyOpenPositionsWrite(existing.length)
    },
  )
}

export async function getClosedToday(): Promise<ClosedPosition[]> {
  try {
    const raw = await readFile(closedPositionsPath(), 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ClosedPosition)
  } catch {
    return []
  }
}

export async function getDailyStats(): Promise<DailyStats> {
  const closed = await getClosedToday()
  const byReason = Object.fromEntries(EXIT_REASONS.map(r => [r, 0])) as Record<ExitReason, number>

  if (closed.length === 0) {
    return { totalClosed: 0, winRate: 0, avgReturn: 0, bestReturn: 0, worstReturn: 0, byReason }
  }

  let wins = 0
  let sumReturn = 0
  let bestReturn = closed[0]!.returnPct
  let worstReturn = closed[0]!.returnPct
  for (const c of closed) {
    if (c.returnPct > 0) wins++
    sumReturn += c.returnPct
    if (c.returnPct > bestReturn) bestReturn = c.returnPct
    if (c.returnPct < worstReturn) worstReturn = c.returnPct
    byReason[c.exitReason]++
  }

  return {
    totalClosed: closed.length,
    winRate: wins / closed.length,
    avgReturn: sumReturn / closed.length,
    bestReturn,
    worstReturn,
    byReason,
  }
}
