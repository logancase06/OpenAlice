import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type { GitCommit, GitExportState } from '@traderalice/uta-protocol'

vi.mock('../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js', () => ({
  fetchDexScreenerTokenPairs: vi.fn(),
  bestPair: (pairs: unknown[]) => (pairs.length > 0 ? pairs[0] : null),
}))

vi.mock('../../services/uta/src/domain/trading/git-persistence.js', () => ({
  loadGitState: vi.fn(),
}))

import {
  parseArgs,
  loadCommitsInRange,
  reconstructPositions,
  resolveOpenPositions,
  summarize,
  formatTerminalReport,
  formatMarkdownReport,
} from './replay.js'
import { fetchDexScreenerTokenPairs } from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { loadGitState } from '../../services/uta/src/domain/trading/git-persistence.js'

const pairsMock = vi.mocked(fetchDexScreenerTokenPairs)
const loadGitStateMock = vi.mocked(loadGitState)

beforeEach(() => {
  pairsMock.mockReset()
  loadGitStateMock.mockReset()
})

function contract(symbol: string, localSymbol: string, exchange = 'solana'): Contract {
  return { symbol, localSymbol, exchange, secType: 'CRYPTO', currency: 'USD' } as unknown as Contract
}

function commit(overrides: Partial<GitCommit> & { positions: Array<{ contract: Contract; avgCost: string; quantity: Decimal | string }>; totalCashValue: string }): GitCommit {
  return {
    hash: overrides.hash ?? 'h',
    parentHash: overrides.parentHash ?? null,
    message: overrides.message ?? 'test commit',
    operations: overrides.operations ?? [],
    results: overrides.results ?? [],
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    stateAfter: {
      netLiquidation: overrides.totalCashValue,
      totalCashValue: overrides.totalCashValue,
      unrealizedPnL: '0',
      realizedPnL: '0',
      positions: overrides.positions.map(p => ({
        contract: p.contract,
        currency: 'USD',
        side: 'long' as const,
        quantity: p.quantity instanceof Decimal ? p.quantity : new Decimal(p.quantity),
        avgCost: p.avgCost,
        marketPrice: p.avgCost,
        marketValue: '0',
        unrealizedPnL: '0',
        realizedPnL: '0',
        multiplier: '1',
      })),
      pendingOrders: [],
    },
  } as GitCommit
}

describe('parseArgs', () => {
  it('requires --account', () => {
    expect(() => parseArgs([])).toThrow(/--account/)
  })

  it('parses --account, --from, --to', () => {
    const result = parseArgs(['--account', 'dex-solana-a1', '--from', '2026-01-01', '--to', '2026-01-31'])
    expect(result.account).toBe('dex-solana-a1')
    expect(result.from?.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(result.to?.toISOString().slice(0, 10)).toBe('2026-01-31')
  })

  it('throws on an invalid --from', () => {
    expect(() => parseArgs(['--account', 'x', '--from', 'not-a-date'])).toThrow(/Invalid --from/)
  })
})

describe('reconstructPositions', () => {
  const tokenA = contract('TOKENA', 'TokenAAddr111')
  const tokenB = contract('TOKENB', 'TokenBAddr222')

  it('closes a position and derives exit price from the cash delta, leaves the other open', () => {
    const commits = [
      commit({
        hash: 'c1', timestamp: '2026-06-30T10:00:00.000Z', totalCashValue: '900',
        positions: [{ contract: tokenA, avgCost: '0.1', quantity: '1000' }],
      }),
      commit({
        hash: 'c2', parentHash: 'c1', timestamp: '2026-06-30T11:00:00.000Z', totalCashValue: '850',
        positions: [
          { contract: tokenA, avgCost: '0.1', quantity: '1000' },
          { contract: tokenB, avgCost: '0.1', quantity: '500' },
        ],
      }),
      commit({
        hash: 'c3', parentHash: 'c2', timestamp: '2026-06-30T14:00:00.000Z', totalCashValue: '1050',
        positions: [{ contract: tokenB, avgCost: '0.1', quantity: '500' }],
      }),
    ]

    const { closed, stillOpen } = reconstructPositions(commits)

    expect(closed).toHaveLength(1)
    expect(closed[0].symbol).toBe('TOKENA')
    // (1050 - 850) / 1000 = 0.2 exit price -> pnl = (0.2-0.1)*1000 = 100
    expect(closed[0].exitPrice).toBe('0.2')
    expect(closed[0].pnl).toBe('100')
    expect(closed[0].pnlPercent).toBe(100)
    expect(closed[0].openedAt).toBe('2026-06-30T10:00:00.000Z')
    expect(closed[0].closedAt).toBe('2026-06-30T14:00:00.000Z')

    expect(stillOpen.size).toBe(1)
    expect(stillOpen.get('TokenBAddr222')?.avgCost).toBe('0.1')
  })

  it('tracks avgCost from the last snapshot before a position closes, not the very first buy', () => {
    const tokenC = contract('TOKENC', 'TokenCAddr333')
    const commits = [
      // first buy: 1000 @ 0.1
      commit({ hash: 'c1', timestamp: 't1', totalCashValue: '900', positions: [{ contract: tokenC, avgCost: '0.1', quantity: '1000' }] }),
      // top-up buy raises avgCost to 0.15, qty to 1500
      commit({ hash: 'c2', parentHash: 'c1', timestamp: 't2', totalCashValue: '825', positions: [{ contract: tokenC, avgCost: '0.15', quantity: '1500' }] }),
      // fully closed
      commit({ hash: 'c3', parentHash: 'c2', timestamp: 't3', totalCashValue: '1125', positions: [] }),
    ]

    const { closed } = reconstructPositions(commits)

    expect(closed).toHaveLength(1)
    expect(closed[0].entryPrice).toBe('0.15') // uses the latest avgCost, not the original 0.1
    expect(closed[0].quantity).toBe('1500')
    // (1125 - 825) / 1500 = 0.2 exit -> pnl = (0.2-0.15)*1500 = 75
    expect(closed[0].pnl).toBe('75')
  })
})

describe('resolveOpenPositions', () => {
  it('marks an open position to the live DexScreener price', async () => {
    pairsMock.mockResolvedValue([{
      chainId: 'solana', pairAddress: 'p', baseToken: { address: 'tok', symbol: 'X', name: 'X' },
      quoteToken: { address: 'q', symbol: 'SOL', name: 'SOL' }, priceUsd: '0.2', liquidity: { usd: 10_000 },
    }])
    const stillOpen = new Map([['tok', { contract: contract('X', 'tok'), avgCost: '0.1', quantity: new Decimal(1000), openedAt: 't0' }]])

    const [result] = await resolveOpenPositions(stillOpen)

    expect(result.status).toBe('open')
    expect(result.currentPrice).toBe('0.2')
    expect(result.pnl).toBe('100')
    expect(result.pnlPercent).toBe(100)
  })

  it('leaves currentPrice/pnl unresolved when DexScreener has no data for the token', async () => {
    pairsMock.mockResolvedValue([])
    const stillOpen = new Map([['tok', { contract: contract('X', 'tok'), avgCost: '0.1', quantity: new Decimal(1000), openedAt: 't0' }]])

    const [result] = await resolveOpenPositions(stillOpen)

    expect(result.currentPrice).toBeUndefined()
    expect(result.pnl).toBe('0')
  })
})

describe('summarize', () => {
  it('excludes unresolved open positions from win-rate/avg-return but counts them as still-open', () => {
    const all = [
      { nativeKey: 'a', symbol: 'A', chain: 'solana', status: 'closed' as const, entryPrice: '0.1', quantity: '10', exitPrice: '0.2', pnl: '1', pnlPercent: 100, openedAt: 't', closedAt: 't' },
      { nativeKey: 'b', symbol: 'B', chain: 'solana', status: 'closed' as const, entryPrice: '0.1', quantity: '10', exitPrice: '0.05', pnl: '-0.5', pnlPercent: -50, openedAt: 't', closedAt: 't' },
      { nativeKey: 'c', symbol: 'C', chain: 'solana', status: 'open' as const, entryPrice: '0.1', quantity: '10', currentPrice: undefined, pnl: '0', pnlPercent: 0, openedAt: 't' },
    ]

    const summary = summarize(all)

    expect(summary.evaluatedCount).toBe(2) // C excluded — no currentPrice
    expect(summary.winRatePercent).toBe(50)
    expect(summary.avgReturnPercent).toBe(25) // (100 + -50) / 2
    expect(summary.best?.symbol).toBe('A')
    expect(summary.worst?.symbol).toBe('B')
    expect(summary.stillOpenCount).toBe(1)
  })

  it('handles an empty position list without throwing', () => {
    const summary = summarize([])
    expect(summary.evaluatedCount).toBe(0)
    expect(summary.winRatePercent).toBe(0)
    expect(summary.best).toBeNull()
    expect(summary.worst).toBeNull()
  })
})

describe('loadCommitsInRange', () => {
  it('returns [] when no git state exists for the account', async () => {
    loadGitStateMock.mockResolvedValue(undefined)
    const commits = await loadCommitsInRange('no-such-account')
    expect(commits).toEqual([])
  })

  it('loads, rehydrates, and filters commits by [from, to]', async () => {
    const tokenA = contract('TOKENA', 'TokenAAddr111')
    const state: GitExportState = {
      head: 'c2',
      commits: [
        commit({ hash: 'c1', timestamp: '2026-06-01T00:00:00.000Z', totalCashValue: '900', positions: [{ contract: tokenA, avgCost: '0.1', quantity: '1000' }] }),
        commit({ hash: 'c2', parentHash: 'c1', timestamp: '2026-06-15T00:00:00.000Z', totalCashValue: '1000', positions: [] }),
      ],
    }
    loadGitStateMock.mockResolvedValue(state)

    const allCommits = await loadCommitsInRange('dex-solana-test')
    expect(allCommits.map(c => c.hash)).toEqual(['c1', 'c2'])
    // Rehydration confirmed: quantity comes back as a real Decimal instance.
    expect(allCommits[0].stateAfter.positions[0].quantity).toBeInstanceOf(Decimal)

    const filtered = await loadCommitsInRange('dex-solana-test', new Date('2026-06-10'))
    expect(filtered.map(c => c.hash)).toEqual(['c2'])
  })
})

describe('report formatting', () => {
  const all = [
    { nativeKey: 'a', symbol: 'TOKENA', chain: 'solana', status: 'closed' as const, entryPrice: '0.1', quantity: '1000', exitPrice: '0.2', pnl: '100', pnlPercent: 100, openedAt: 't1', closedAt: 't2' },
  ]
  const summary = summarize(all)

  it('formatTerminalReport shows the position and summary stats', () => {
    const text = formatTerminalReport('dex-solana-test', all, summary)
    expect(text).toMatch(/RETRO:REPLAY/)
    expect(text).toMatch(/TOKENA/)
    expect(text).toMatch(/Win rate: 100%/)
  })

  it('formatTerminalReport handles no positions found', () => {
    const text = formatTerminalReport('dex-solana-test', [], summarize([]))
    expect(text).toMatch(/No positions found/i)
  })

  it('formatMarkdownReport produces a markdown table', () => {
    const md = formatMarkdownReport('dex-solana-test', all, summary)
    expect(md).toMatch(/^# Retro replay/)
    expect(md).toMatch(/\| solana \| TOKENA \| closed \|/)
  })
})
