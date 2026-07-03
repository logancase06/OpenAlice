import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import {
  openPosition,
  closePosition,
  getOpenPositions,
  updatePeakPrice,
  getClosedToday,
  getDailyStats,
  type PositionExitConfig,
} from './position-tracker.js'
import { dataPath } from '@/core/paths.js'
import type { DexScreenerPair } from './dex-market-data.js'

const TEST_EXIT_CONFIG: PositionExitConfig = {
  stopLoss: -20,
  takeProfit: 200,
  trailingStopActivationPct: 12,
  trailingStopPct: -15,
  momentumThreshold: -10,
  timeExitMinutes: 180,
}

function pair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: 'solana',
    pairAddress: 'testPair1',
    baseToken: { address: 'tokAddr1', symbol: 'FOO', name: 'Foo Coin' },
    quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
    priceUsd: '0.10',
    liquidity: { usd: 10_000 },
    ...overrides,
  }
}

beforeEach(async () => {
  await rm(dataPath('positions'), { recursive: true, force: true })
})

afterEach(async () => {
  await rm(dataPath('positions'), { recursive: true, force: true })
})

describe('open/close/update cycle', () => {
  it('opens, updates peak, and closes a position, computing returnPct and holdingMinutes', async () => {
    const opened = await openPosition(pair(), 'conservative', 1.0, 45, TEST_EXIT_CONFIG)
    expect(opened.entryPrice).toBe(1.0)
    expect(opened.peakPrice).toBe(1.0)
    expect(opened.strategy).toBe('conservative')

    const open = await getOpenPositions()
    expect(open).toHaveLength(1)
    expect(open[0]!.id).toBe(opened.id)

    await updatePeakPrice(opened.id, 1.5)

    const closed = await closePosition(opened.id, 1.2, 'trailing_stop')
    expect(closed).not.toBeNull()
    expect(closed!.exitPrice).toBe(1.2)
    expect(closed!.exitReason).toBe('trailing_stop')
    expect(closed!.returnPct).toBeCloseTo(20, 5)
    expect(closed!.holdingMinutes).toBeGreaterThanOrEqual(0)

    expect(await getOpenPositions()).toHaveLength(0)
    const today = await getClosedToday()
    expect(today).toHaveLength(1)
    expect(today[0]!.id).toBe(opened.id)
  })

  it('closePosition returns null for an unknown/already-closed id', async () => {
    const result = await closePosition('does-not-exist', 1.0, 'manual')
    expect(result).toBeNull()
  })

  it('openPosition throws on a zero or negative entryPrice instead of persisting a division-by-zero trap', async () => {
    await expect(openPosition(pair(), 'conservative', 0, 45, TEST_EXIT_CONFIG)).rejects.toThrow()
    await expect(openPosition(pair(), 'conservative', -1, 45, TEST_EXIT_CONFIG)).rejects.toThrow()
    await expect(openPosition(pair(), 'conservative', NaN, 45, TEST_EXIT_CONFIG)).rejects.toThrow()
    expect(await getOpenPositions()).toHaveLength(0)
  })
})

describe('fastExitRegime', () => {
  it('is omitted from the persisted JSON (not written as false) when the caller passes nothing', async () => {
    await openPosition(pair(), 'conservative', 1.0, 45, TEST_EXIT_CONFIG)
    const raw = await readFile(dataPath('positions', 'open.json'), 'utf-8')
    expect(JSON.parse(raw)[0]).not.toHaveProperty('fastExitRegime')
  })

  it('is persisted as true when the caller explicitly passes true', async () => {
    const opened = await openPosition(pair(), 'grad_immediate', 1.0, 0, TEST_EXIT_CONFIG, [], true)
    expect(opened.fastExitRegime).toBe(true)

    const open = await getOpenPositions()
    expect(open[0]!.fastExitRegime).toBe(true)
  })

  it('carries through to the closed-position record unchanged', async () => {
    const opened = await openPosition(pair(), 'grad_immediate', 1.0, 0, TEST_EXIT_CONFIG, [], true)
    const closed = await closePosition(opened.id, 1.2, 'take_profit')
    expect(closed!.fastExitRegime).toBe(true)

    const today = await getClosedToday()
    expect(today[0]!.fastExitRegime).toBe(true)
  })

  it('a position opened before this field existed (absent in persisted JSON) reads back as undefined, not false — distinguishable from an explicit false', async () => {
    await mkdir(dataPath('positions'), { recursive: true })
    const legacyPosition = {
      id: 'legacy-1',
      pairAddress: 'testPair1',
      tokenAddress: 'tokAddr1',
      symbol: 'FOO',
      strategy: 'grad_immediate',
      entryPrice: 1.0,
      entryLiquidityUsd: 10_000,
      entryTimestamp: Date.now(),
      entryAgeMinutes: 0,
      peakPrice: 1.0,
      lastCheckedAt: Date.now(),
      buyerWallets: [],
      exitConfig: TEST_EXIT_CONFIG,
      // no fastExitRegime key at all — simulates a position persisted before this field was introduced
    }
    await writeFile(dataPath('positions', 'open.json'), JSON.stringify([legacyPosition]), 'utf-8')

    const open = await getOpenPositions()
    expect(open[0]!.fastExitRegime).toBeUndefined()
  })
})

describe('updatePeakPrice', () => {
  it('never regresses the peak price', async () => {
    const opened = await openPosition(pair(), 'early', 1.0, 10, TEST_EXIT_CONFIG)

    await updatePeakPrice(opened.id, 2.0)
    let [pos] = await getOpenPositions()
    expect(pos!.peakPrice).toBe(2.0)

    await updatePeakPrice(opened.id, 1.5)
    ;[pos] = await getOpenPositions()
    expect(pos!.peakPrice).toBe(2.0)

    await updatePeakPrice(opened.id, 3.0)
    ;[pos] = await getOpenPositions()
    expect(pos!.peakPrice).toBe(3.0)
  })

  it('is a no-op for an unknown id', async () => {
    await expect(updatePeakPrice('nope', 5.0)).resolves.toBeUndefined()
  })

  it('persists priceChange5m as lastPriceChange5m for the next cycle, overwriting each call', async () => {
    const opened = await openPosition(pair(), 'early', 1.0, 10, TEST_EXIT_CONFIG)
    expect(opened.lastPriceChange5m).toBeUndefined()

    await updatePeakPrice(opened.id, 1.0, -8)
    let [pos] = await getOpenPositions()
    expect(pos!.lastPriceChange5m).toBe(-8)

    await updatePeakPrice(opened.id, 1.0, -3) // less negative than before — still overwrites, no "worst so far" tracking
    ;[pos] = await getOpenPositions()
    expect(pos!.lastPriceChange5m).toBe(-3)
  })

  it('leaves lastPriceChange5m untouched when priceChange5m is omitted', async () => {
    const opened = await openPosition(pair(), 'early', 1.0, 10, TEST_EXIT_CONFIG)
    await updatePeakPrice(opened.id, 1.0, -8)

    await updatePeakPrice(opened.id, 1.1) // no 3rd arg
    const [pos] = await getOpenPositions()
    expect(pos!.lastPriceChange5m).toBe(-8)
  })
})

describe('getDailyStats', () => {
  it('returns zeros with no closed positions', async () => {
    const stats = await getDailyStats()
    expect(stats.totalClosed).toBe(0)
    expect(stats.winRate).toBe(0)
    expect(stats.avgReturn).toBe(0)
  })

  it('computes winRate, avgReturn, best/worst, and byReason correctly', async () => {
    const p1 = await openPosition(pair({ pairAddress: 'p1' }), 'momentum', 1.0, 60, TEST_EXIT_CONFIG)
    const p2 = await openPosition(pair({ pairAddress: 'p2' }), 'momentum', 1.0, 60, TEST_EXIT_CONFIG)
    const p3 = await openPosition(pair({ pairAddress: 'p3' }), 'momentum', 1.0, 60, TEST_EXIT_CONFIG)

    await closePosition(p1.id, 1.5, 'take_profit') // +50%
    await closePosition(p2.id, 0.9, 'stop_loss') // -10%
    await closePosition(p3.id, 1.1, 'time_exit') // +10%

    const stats = await getDailyStats()
    expect(stats.totalClosed).toBe(3)
    expect(stats.winRate).toBeCloseTo(2 / 3, 5)
    expect(stats.avgReturn).toBeCloseTo((50 - 10 + 10) / 3, 5)
    expect(stats.bestReturn).toBeCloseTo(50, 5)
    expect(stats.worstReturn).toBeCloseTo(-10, 5)
    expect(stats.byReason.take_profit).toBe(1)
    expect(stats.byReason.stop_loss).toBe(1)
    expect(stats.byReason.time_exit).toBe(1)
    expect(stats.byReason.trailing_stop).toBe(0)
  })
})

describe('corrupted files never crash', () => {
  it('getOpenPositions returns [] when open.json does not exist yet (ENOENT — normal on first run)', async () => {
    expect(await getOpenPositions()).toEqual([])
  })

  it('getOpenPositions throws (refuses to silently lose position state) on a corrupted open.json', async () => {
    const filePath = dataPath('positions', 'open.json')
    await mkdir(dataPath('positions'), { recursive: true })
    await writeFile(filePath, '{not valid json[[[')

    await expect(getOpenPositions()).rejects.toThrow()
  })

  it('getOpenPositions throws when open.json path is a directory instead of a file', async () => {
    const filePath = dataPath('positions', 'open.json')
    await mkdir(filePath, { recursive: true }) // path exists as a directory, not a file

    await expect(getOpenPositions()).rejects.toThrow()
  })

  it('getOpenPositions returns [] when the file is valid JSON but not an array', async () => {
    const filePath = dataPath('positions', 'open.json')
    await mkdir(dataPath('positions'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ oops: 'not an array' }))

    expect(await getOpenPositions()).toEqual([])
  })

  it('getClosedToday returns [] when today\'s file does not exist', async () => {
    expect(await getClosedToday()).toEqual([])
  })
})

describe('legacy positions without exitConfig', () => {
  it('backfills a default exitConfig on read instead of crashing evaluateExitRules downstream', async () => {
    const legacyPosition = {
      id: 'legacy-1',
      pairAddress: 'pair-legacy',
      tokenAddress: 'tok-legacy',
      symbol: 'OLD',
      strategy: 'early',
      entryPrice: 1.0,
      entryLiquidityUsd: 10_000,
      entryTimestamp: Date.now(),
      entryAgeMinutes: 60,
      peakPrice: 1.0,
      lastCheckedAt: Date.now(),
      buyerWallets: [],
      // no exitConfig — matches a position written before this field existed
    }
    const filePath = dataPath('positions', 'open.json')
    await mkdir(dataPath('positions'), { recursive: true })
    await writeFile(filePath, JSON.stringify([legacyPosition]))

    const [position] = await getOpenPositions()

    expect(position!.exitConfig).toBeDefined()
    expect(position!.exitConfig.stopLoss).toBe(-20)
    expect(position!.exitConfig.takeProfit).toBe(200)
  })

  it('leaves an already-migrated position\'s own exitConfig untouched', async () => {
    await openPosition(pair(), 'early', 1.0, 10, TEST_EXIT_CONFIG)

    const [position] = await getOpenPositions()

    expect(position!.exitConfig).toEqual(TEST_EXIT_CONFIG)
  })
})

describe('concurrent writes (lock contention)', () => {
  it('two concurrent openPosition() calls both persist — no silent loss under Promise.all', async () => {
    const [a, b] = await Promise.all([
      openPosition(pair({ pairAddress: 'concA' }), 'conservative', 1.0, 10, TEST_EXIT_CONFIG),
      openPosition(pair({ pairAddress: 'concB' }), 'early', 2.0, 10, TEST_EXIT_CONFIG),
    ])

    const open = await getOpenPositions()
    expect(open).toHaveLength(2)
    expect(open.map(p => p.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('many concurrent openPosition() calls all persist', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => openPosition(pair({ pairAddress: `conc${i}` }), 'early', 1.0 + i, 10, TEST_EXIT_CONFIG)),
    )

    const open = await getOpenPositions()
    expect(open).toHaveLength(8)
    expect(new Set(open.map(p => p.id)).size).toBe(8)
    expect(new Set(results.map(p => p.id)).size).toBe(8)
  })
})

describe('two positions on the same pairAddress', () => {
  it('are both tracked with distinct ids', async () => {
    const a = await openPosition(pair({ pairAddress: 'samePair' }), 'conservative', 1.0, 10, TEST_EXIT_CONFIG)
    const b = await openPosition(pair({ pairAddress: 'samePair' }), 'early', 1.0, 10, TEST_EXIT_CONFIG)

    expect(a.id).not.toBe(b.id)
    const open = await getOpenPositions()
    expect(open).toHaveLength(2)
    expect(new Set(open.map(p => p.id)).size).toBe(2)
  })
})
