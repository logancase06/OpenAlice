/**
 * Market velocity — how many new tokens the scanner is seeing per cycle,
 * across the run. Contextual signal only, surfaced in the hourly summary
 * and JSONL log — never used as a rejection filter (see live-scan.ts).
 *
 * Same rolling-snapshot-file shape as liquidity-tracker.ts, but one global
 * file rather than one per pool — there's a single market-wide velocity,
 * not a per-token one.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'

const MAX_SNAPSHOTS = 48 // ~4h of history at a 5-minute scan cadence
const HIGH_ACTIVITY_THRESHOLD = 50
const TREND_WINDOW = 6

export interface MarketVelocity {
  tokensPerHour: number
  trend: 'accelerating' | 'stable' | 'decelerating'
  isHighActivity: boolean
  snapshotCount: number
}

interface VelocitySnapshot {
  tokenCount: number
  timestamp: number
}

function velocityFilePath(): string {
  return dataPath('snapshots', 'market-velocity.json')
}

async function readSnapshots(): Promise<VelocitySnapshot[]> {
  try {
    const raw = await readFile(velocityFilePath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as VelocitySnapshot[]) : []
  } catch {
    return []
  }
}

async function writeSnapshotsAtomically(snapshots: VelocitySnapshot[]): Promise<void> {
  const filePath = velocityFilePath()
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tmpPath, JSON.stringify(snapshots, null, 2), 'utf-8')
  await rename(tmpPath, filePath)
}

export async function recordVelocitySnapshot(tokenCount: number): Promise<void> {
  try {
    const existing = await readSnapshots()
    const updated = [...existing, { tokenCount, timestamp: Date.now() }].slice(-MAX_SNAPSHOTS)
    await writeSnapshotsAtomically(updated)
  } catch (err) {
    console.error(`market-velocity: failed to record snapshot — ${err instanceof Error ? err.message : String(err)}`)
  }
}

function emptyVelocity(snapshotCount: number): MarketVelocity {
  return { tokensPerHour: 0, trend: 'stable', isHighActivity: false, snapshotCount }
}

/**
 * `tokensPerHour` is the average across all retained snapshots (up to
 * `MAX_SNAPSHOTS`); `trend` compares the average of the first
 * `TREND_WINDOW` snapshots against the last `TREND_WINDOW` — only computed
 * once there are at least `TREND_WINDOW * 2` snapshots, otherwise 'stable'.
 */
export async function getMarketVelocity(): Promise<MarketVelocity> {
  const snapshots = await readSnapshots()
  if (snapshots.length < 2) return emptyVelocity(snapshots.length)

  const first = snapshots[0]!
  const last = snapshots[snapshots.length - 1]!
  const totalTokens = snapshots.reduce((sum, s) => sum + s.tokenCount, 0)
  const spanHours = Math.max((last.timestamp - first.timestamp) / 3_600_000, 1 / 60)
  const tokensPerHour = totalTokens / spanHours

  let trend: MarketVelocity['trend'] = 'stable'
  if (snapshots.length >= TREND_WINDOW * 2) {
    const firstAvg = snapshots.slice(0, TREND_WINDOW).reduce((s, x) => s + x.tokenCount, 0) / TREND_WINDOW
    const lastAvg = snapshots.slice(-TREND_WINDOW).reduce((s, x) => s + x.tokenCount, 0) / TREND_WINDOW
    if (lastAvg > firstAvg * 1.15) trend = 'accelerating'
    else if (lastAvg < firstAvg * 0.85) trend = 'decelerating'
  }

  return {
    tokensPerHour,
    trend,
    isHighActivity: tokensPerHour > HIGH_ACTIVITY_THRESHOLD,
    snapshotCount: snapshots.length,
  }
}
