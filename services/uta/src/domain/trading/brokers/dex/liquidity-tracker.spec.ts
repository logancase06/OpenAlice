import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { recordSnapshot, getLiquidityGrowth, cleanOldSnapshots } from './liquidity-tracker.js'
import { dataPath } from '@/core/paths.js'
import type { DexScreenerPair } from './dex-market-data.js'

function pair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: 'solana',
    pairAddress: 'testPair1',
    baseToken: { address: 'tok', symbol: 'X', name: 'X Coin' },
    quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
    priceUsd: '0.10',
    liquidity: { usd: 10_000 },
    txns: { h1: { buys: 10, sells: 5 } },
    ...overrides,
  }
}

async function snapshotFileExists(pairAddress: string): Promise<boolean> {
  try {
    await readFile(dataPath('snapshots', `${pairAddress}.json`), 'utf-8')
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  await rm(dataPath('snapshots'), { recursive: true, force: true })
})

afterEach(async () => {
  await rm(dataPath('snapshots'), { recursive: true, force: true })
})

describe('recordSnapshot', () => {
  it('creates the file on the first snapshot', async () => {
    await recordSnapshot(pair({ pairAddress: 'firstSnapshotPair' }))

    expect(await snapshotFileExists('firstSnapshotPair')).toBe(true)
    const raw = JSON.parse(await readFile(dataPath('snapshots', 'firstSnapshotPair.json'), 'utf-8'))
    expect(raw).toHaveLength(1)
    expect(raw[0].liquidityUsd).toBe(10_000)
    expect(raw[0].priceUsd).toBe(0.10)
    expect(raw[0].buyTxns1h).toBe(10)
    expect(raw[0].sellTxns1h).toBe(5)
  })

  it('accumulates up to 24 snapshots, then the 25th evicts the oldest', async () => {
    const pairAddress = 'accumulatingPair'
    for (let i = 0; i < 25; i++) {
      await recordSnapshot(pair({ pairAddress, liquidity: { usd: 1000 + i } }))
    }

    const raw = JSON.parse(await readFile(dataPath('snapshots', `${pairAddress}.json`), 'utf-8'))
    expect(raw).toHaveLength(24)
    // The 0th snapshot (liquidityUsd 1000) was evicted; the oldest remaining is index 1 (1001).
    expect(raw[0].liquidityUsd).toBe(1001)
    expect(raw[23].liquidityUsd).toBe(1024)
  })
})

describe('getLiquidityGrowth', () => {
  it('returns hasEnoughSnapshots: false when the file does not exist', async () => {
    const growth = await getLiquidityGrowth('neverRecordedPair')

    expect(growth.hasEnoughSnapshots).toBe(false)
    expect(growth.snapshotCount).toBe(0)
  })

  it('returns hasEnoughSnapshots: false with exactly 1 snapshot', async () => {
    const pairAddress = 'onlyOneSnapshotPair'
    await recordSnapshot(pair({ pairAddress }))

    const growth = await getLiquidityGrowth(pairAddress)

    expect(growth.hasEnoughSnapshots).toBe(false)
    expect(growth.snapshotCount).toBe(1)
  })

  it('reports isGrowing: true when liquidity increased between first and last snapshot', async () => {
    const pairAddress = 'growingPair'
    await recordSnapshot(pair({ pairAddress, liquidity: { usd: 10_000 } }))
    await recordSnapshot(pair({ pairAddress, liquidity: { usd: 15_000 } }))

    const growth = await getLiquidityGrowth(pairAddress)

    expect(growth.hasEnoughSnapshots).toBe(true)
    expect(growth.isGrowing).toBe(true)
    expect(growth.liquidityGrowthPct).toBeCloseTo(50, 5)
  })

  it('computes a -30% liquidityGrowthPct when liquidity drops by 30%', async () => {
    const pairAddress = 'drainingPair'
    await recordSnapshot(pair({ pairAddress, liquidity: { usd: 10_000 } }))
    await recordSnapshot(pair({ pairAddress, liquidity: { usd: 7_000 } }))

    const growth = await getLiquidityGrowth(pairAddress)

    expect(growth.liquidityGrowthPct).toBeCloseTo(-30, 5)
    expect(growth.isGrowing).toBe(false)
  })

  it('returns buyPressure: 0.5 (not NaN) when there are zero buys and zero sells', async () => {
    const pairAddress = 'noTxnsPair'
    await recordSnapshot(pair({ pairAddress, txns: { h1: { buys: 0, sells: 0 } } }))
    await recordSnapshot(pair({ pairAddress, txns: { h1: { buys: 0, sells: 0 } } }))

    const growth = await getLiquidityGrowth(pairAddress)

    expect(growth.buyPressure).toBe(0.5)
    expect(Number.isNaN(growth.buyPressure)).toBe(false)
  })

  it('computes priceChangePct and minutesTracked from the snapshot timestamps', async () => {
    const pairAddress = 'priceAndTimePair'
    const filePath = dataPath('snapshots', `${pairAddress}.json`)
    await mkdir(dataPath('snapshots'), { recursive: true })
    const now = Date.now()
    await writeFile(filePath, JSON.stringify([
      { pairAddress, liquidityUsd: 10_000, priceUsd: 0.10, buyTxns1h: 10, sellTxns1h: 5, timestamp: now - 20 * 60_000 },
      { pairAddress, liquidityUsd: 11_000, priceUsd: 0.12, buyTxns1h: 20, sellTxns1h: 5, timestamp: now },
    ]))

    const growth = await getLiquidityGrowth(pairAddress)

    expect(growth.priceChangePct).toBeCloseTo(20, 5)
    expect(growth.minutesTracked).toBeCloseTo(20, 1)
    expect(growth.buyPressure).toBeCloseTo(20 / 25, 5) // last snapshot's buys/(buys+sells)
  })

  it('returns hasEnoughSnapshots: false without crashing on a corrupted snapshot file', async () => {
    const pairAddress = 'corruptedPair'
    await mkdir(dataPath('snapshots'), { recursive: true })
    await writeFile(dataPath('snapshots', `${pairAddress}.json`), '{not valid json[[[')

    const growth = await getLiquidityGrowth(pairAddress)

    expect(growth.hasEnoughSnapshots).toBe(false)
    expect(growth.snapshotCount).toBe(0)
  })

  it('returns hasEnoughSnapshots: false without crashing when the file is valid JSON but not an array', async () => {
    const pairAddress = 'wrongShapePair'
    await mkdir(dataPath('snapshots'), { recursive: true })
    await writeFile(dataPath('snapshots', `${pairAddress}.json`), JSON.stringify({ oops: 'not an array' }))

    const growth = await getLiquidityGrowth(pairAddress)

    expect(growth.hasEnoughSnapshots).toBe(false)
  })
})

describe('cleanOldSnapshots', () => {
  it('deletes files older than maxAgeHours and keeps recent ones', async () => {
    await recordSnapshot(pair({ pairAddress: 'oldPair' }))
    await recordSnapshot(pair({ pairAddress: 'recentPair' }))

    // Backdate the "old" file's mtime to 10 hours ago.
    const oldPath = dataPath('snapshots', 'oldPair.json')
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(oldPath, tenHoursAgo, tenHoursAgo)

    await cleanOldSnapshots(2)

    expect(await snapshotFileExists('oldPair')).toBe(false)
    expect(await snapshotFileExists('recentPair')).toBe(true)
  })

  it('does not throw when the snapshots directory does not exist yet', async () => {
    await expect(cleanOldSnapshots(2)).resolves.toBeUndefined()
  })
})
