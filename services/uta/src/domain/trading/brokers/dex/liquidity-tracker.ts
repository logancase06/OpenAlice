/**
 * Liquidity-growth tracker — a small rolling snapshot history per
 * DexScreener pool, used to detect liquidity draining (possible rug in
 * progress) and sustained sell pressure that a single point-in-time
 * DexScreener call can't see — DexScreener has no historical liquidity
 * field (see `dex-market-data.ts`'s file header), so this is our own
 * time-series, built by repeated polling.
 *
 * Plain JSON file per pool under `data/snapshots/{pairAddress}.json` — NOT
 * part of TradingGit/git-persistence.ts. That module persists operation/
 * commit history for a trading account; this is raw price/liquidity
 * time-series feeding a guard decision, an unrelated concern with its own
 * lifecycle (bounded rolling window, not an append-only trade log).
 *
 * Recording and evaluating are deliberately separate: `recordSnapshot` is
 * meant to be called by a live scanner every poll cycle (not built yet —
 * see the DEX Phase D plan); `getLiquidityGrowth` is called by
 * `TokenSecurityGuard` to evaluate whatever history already exists.
 * The guard never calls `recordSnapshot` itself.
 */
import { readFile, writeFile, mkdir, rename, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { dataPath } from '@/core/paths.js'
import type { DexScreenerPair } from './dex-market-data.js'

const MAX_SNAPSHOTS = 24

export interface LiquiditySnapshot {
  pairAddress: string
  liquidityUsd: number
  priceUsd: number
  buyTxns1h: number
  sellTxns1h: number
  timestamp: number
}

export interface LiquidityGrowth {
  hasEnoughSnapshots: boolean
  liquidityGrowthPct: number
  priceChangePct: number
  /** buys / (buys + sells) over the tracked window's most recent snapshot — 0.5 (neutral) when there's no transaction data at all, never NaN. */
  buyPressure: number
  minutesTracked: number
  isGrowing: boolean
  /** For debugging/observability — how many snapshots the verdict above was computed from. */
  snapshotCount: number
}

function snapshotFilePath(pairAddress: string): string {
  return dataPath('snapshots', `${pairAddress}.json`)
}

async function readSnapshots(pairAddress: string): Promise<LiquiditySnapshot[]> {
  try {
    const raw = await readFile(snapshotFilePath(pairAddress), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    // A missing file and a corrupt/wrong-shaped file are both treated as
    // "no history yet" — never throw out to the caller.
    return Array.isArray(parsed) ? (parsed as LiquiditySnapshot[]) : []
  } catch {
    return []
  }
}

/** Write via tmp-file-then-rename so a crash mid-write can never leave a corrupt/partial JSON file behind. */
async function writeSnapshotsAtomically(pairAddress: string, snapshots: LiquiditySnapshot[]): Promise<void> {
  const filePath = snapshotFilePath(pairAddress)
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tmpPath, JSON.stringify(snapshots, null, 2), 'utf-8')
  await rename(tmpPath, filePath)
}

/**
 * Append a timestamped snapshot for this pool, keeping only the most recent
 * `MAX_SNAPSHOTS` (24 — ~2h of history at a 5-minute poll cadence). Never
 * throws: a write failure is logged and swallowed, since a missed snapshot
 * just means slightly thinner history for the growth check, not something
 * worth crashing a scan cycle over.
 */
export async function recordSnapshot(pair: DexScreenerPair): Promise<void> {
  try {
    const existing = await readSnapshots(pair.pairAddress)
    const snapshot: LiquiditySnapshot = {
      pairAddress: pair.pairAddress,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      priceUsd: Number(pair.priceUsd ?? 0),
      buyTxns1h: pair.txns?.h1?.buys ?? 0,
      sellTxns1h: pair.txns?.h1?.sells ?? 0,
      timestamp: Date.now(),
    }
    const updated = [...existing, snapshot].slice(-MAX_SNAPSHOTS)
    await writeSnapshotsAtomically(pair.pairAddress, updated)
  } catch (err) {
    console.error(`liquidity-tracker: failed to record snapshot for ${pair.pairAddress} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

function emptyGrowth(snapshotCount: number): LiquidityGrowth {
  return {
    hasEnoughSnapshots: false,
    liquidityGrowthPct: 0,
    priceChangePct: 0,
    buyPressure: 0,
    minutesTracked: 0,
    isGrowing: false,
    snapshotCount,
  }
}

/** Percent change from -> to. from=0 is treated as +/-Infinity (never NaN) rather than a divide-by-zero. */
function percentChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : (to > 0 ? Infinity : -Infinity)
  return ((to - from) / from) * 100
}

/**
 * Compare the oldest and newest recorded snapshots for a pool. A missing
 * file or fewer than 2 snapshots both return `hasEnoughSnapshots: false`
 * with every other field zeroed — this is not an error case, it's "not
 * enough tracking history yet," and callers must check the flag before
 * trusting the other fields.
 */
export async function getLiquidityGrowth(pairAddress: string): Promise<LiquidityGrowth> {
  const snapshots = await readSnapshots(pairAddress)
  if (snapshots.length < 2) return emptyGrowth(snapshots.length)

  const first = snapshots[0]!
  const last = snapshots[snapshots.length - 1]!

  const liquidityGrowthPct = percentChange(first.liquidityUsd, last.liquidityUsd)
  const priceChangePct = percentChange(first.priceUsd, last.priceUsd)
  const totalTxns = last.buyTxns1h + last.sellTxns1h
  const buyPressure = totalTxns === 0 ? 0.5 : last.buyTxns1h / totalTxns
  const minutesTracked = (last.timestamp - first.timestamp) / 60_000

  return {
    hasEnoughSnapshots: true,
    liquidityGrowthPct,
    priceChangePct,
    buyPressure,
    minutesTracked,
    isGrowing: liquidityGrowthPct > 0,
    snapshotCount: snapshots.length,
  }
}

/**
 * Delete snapshot files whose last write is older than `maxAgeHours` —
 * meant to be called at scanner startup so `data/snapshots/` doesn't
 * accumulate files for pools that are no longer being tracked. Missing
 * directory is a no-op, not an error (nothing to clean yet).
 */
export async function cleanOldSnapshots(maxAgeHours: number): Promise<void> {
  const dir = dataPath('snapshots')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  const cutoffMs = Date.now() - maxAgeHours * 60 * 60_000
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const filePath = resolve(dir, entry)
    try {
      const info = await stat(filePath)
      if (info.mtimeMs < cutoffMs) {
        await unlink(filePath)
      }
    } catch (err) {
      console.error(`liquidity-tracker: failed to check/clean ${entry} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
