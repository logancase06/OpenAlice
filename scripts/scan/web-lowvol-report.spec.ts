import { describe, it, expect } from 'vitest'
import {
  GRADUATION_MIN_UNIQUE_TOKENS,
  tokenWeightedStats,
  quartileSplit,
  hasSignReversal,
  evaluateGraduationBar,
} from './web-lowvol-report.js'
import type { ClosedPosition } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'

const T0 = 1_800_000_000_000

function trade(tokenAddress: string, returnPct: number, entryOffsetMin = 0): ClosedPosition {
  return { tokenAddress, returnPct, entryTimestamp: T0 + entryOffsetMin * 60_000, strategy: 'web_lowvol' } as ClosedPosition
}

describe('tokenWeightedStats', () => {
  it('weights each token once — two trades on the same token average before counting', () => {
    // tokenA: (+10 -30)/2 = -10 ; tokenB: +40 → token-weighted (−10+40)/2 = +15
    // trade-weighted would be (+10−30+40)/3 = +6.67 — the two must differ here.
    const stats = tokenWeightedStats([trade('A', 10), trade('A', -30), trade('B', 40)])
    expect(stats).toMatchObject({ nTrades: 3, nTokens: 2 })
    expect(stats!.tokenWeightedAvgPct).toBeCloseTo(15)
    expect(stats!.tradeWeightedAvgPct).toBeCloseTo(6.67, 1)
    expect(stats!.tokenWinRatePct).toBe(50)
  })

  it('returns null on an empty set', () => {
    expect(tokenWeightedStats([])).toBeNull()
  })
})

describe('quartileSplit', () => {
  it('splits tokens chronologically by FIRST entry and averages token-weighted per bucket', () => {
    const trades = [
      trade('t1', 10, 0), trade('t2', 20, 10), trade('t3', -30, 20), trade('t4', 40, 30),
      trade('t1', 30, 99), // second trade on t1, later — must not move t1 out of Q1
    ]
    const q = quartileSplit(trades)
    expect(q).toHaveLength(4)
    expect(q[0]).toBeCloseTo(20) // t1 avg (10+30)/2
    expect(q[3]).toBeCloseTo(40)
  })

  it('returns [] below 4 unique tokens — a quartile split of 3 tokens is meaningless', () => {
    expect(quartileSplit([trade('a', 1), trade('b', 2), trade('c', 3)])).toEqual([])
  })
})

describe('hasSignReversal', () => {
  it('flags a positive→negative adjacent transition (the Q3→Q4 pattern that suspended early_web_filtered)', () => {
    expect(hasSignReversal([-12.1, -4.6, 1.8, -1.5])).toBe(true)
  })

  it('does NOT flag negative→positive (improvement) or all-positive sequences', () => {
    expect(hasSignReversal([-5, -1, 2, 4])).toBe(false)
    expect(hasSignReversal([1, 2, 3, 4])).toBe(false)
  })
})

describe('evaluateGraduationBar', () => {
  const manyTokens = (avg: number[]): ClosedPosition[] =>
    avg.map((r, i) => trade(`tok${i}`, r, i))

  it('stays in_progress below the unique-token bar even with great numbers', () => {
    const bar = evaluateGraduationBar(manyTokens(Array.from({ length: 10 }, () => 20)))
    expect(bar.verdict).toBe('in_progress')
    expect(bar.nTokens).toBe(10)
  })

  it('graduates at n>=30 tokens, positive token-weighted avg, no reversal', () => {
    const bar = evaluateGraduationBar(manyTokens(Array.from({ length: GRADUATION_MIN_UNIQUE_TOKENS }, () => 5)))
    expect(bar).toMatchObject({ nOk: true, avgOk: true, quartilesOk: true, verdict: 'graduate' })
  })

  it('suspends at volume when the last quartile flips negative even if the overall avg is positive', () => {
    // 3 quartiles strongly positive, last one negative — overall avg stays > 0.
    const returns = [
      ...Array.from({ length: 24 }, () => 10),
      ...Array.from({ length: 8 }, () => -5),
    ]
    const bar = evaluateGraduationBar(manyTokens(returns))
    expect(bar.nOk).toBe(true)
    expect(bar.avgOk).toBe(true)
    expect(bar.quartilesOk).toBe(false)
    expect(bar.verdict).toBe('suspend')
  })
})
