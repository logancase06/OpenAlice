import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js', () => ({
  fetchLatestTokenProfiles: vi.fn(),
  fetchDexScreenerTokenPairs: vi.fn(),
  bestPair: (pairs: unknown[]) => (pairs.length > 0 ? pairs[0] : null),
}))

vi.mock('../../services/uta/src/domain/trading/guards/TokenSecurityGuard.js', () => ({
  checkTokenSecurity: vi.fn(),
}))

import { parseArgs, buildRetroTodayReport, formatTerminalReport, formatMarkdownReport } from './today.js'
import {
  fetchLatestTokenProfiles,
  fetchDexScreenerTokenPairs,
} from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { checkTokenSecurity } from '../../services/uta/src/domain/trading/guards/TokenSecurityGuard.js'

const profilesMock = vi.mocked(fetchLatestTokenProfiles)
const pairsMock = vi.mocked(fetchDexScreenerTokenPairs)
const securityMock = vi.mocked(checkTokenSecurity)

function pairFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    chainId: 'solana',
    pairAddress: 'p1',
    baseToken: { address: 'tok1', symbol: 'MEME', name: 'Meme Coin' },
    quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
    priceUsd: '0.01',
    liquidity: { usd: 20_000 },
    priceChange: { h1: 10, h6: 20, h24: 30 },
    pairCreatedAt: Date.now() - 30 * 60_000, // 30 minutes ago
    ...overrides,
  }
}

beforeEach(() => {
  profilesMock.mockReset()
  pairsMock.mockReset()
  securityMock.mockReset()
})

describe('parseArgs', () => {
  it('defaults to chain=all, minLiquidityUsd=5000', () => {
    expect(parseArgs([])).toEqual({ chain: 'all', minLiquidityUsd: 5000 })
  })

  it('parses --chain and --min-liquidity', () => {
    expect(parseArgs(['--chain', 'solana', '--min-liquidity', '1000'])).toEqual({ chain: 'solana', minLiquidityUsd: 1000 })
  })

  it('throws on an invalid --chain', () => {
    expect(() => parseArgs(['--chain', 'dogecoin-chain'])).toThrow(/Invalid --chain/)
  })

  it('throws on an invalid --min-liquidity', () => {
    expect(() => parseArgs(['--min-liquidity', 'not-a-number'])).toThrow(/Invalid --min-liquidity/)
  })
})

describe('buildRetroTodayReport', () => {
  it('filters by chain and by age (last 24h only)', async () => {
    profilesMock.mockResolvedValue([
      { chainId: 'solana', tokenAddress: 'tok1' },
      { chainId: 'ethereum', tokenAddress: 'tok2' }, // wrong chain, filtered out
      { chainId: 'solana', tokenAddress: 'tok3' }, // too old, filtered out
    ])
    pairsMock.mockImplementation(async (_chain: string, tokenAddress: string) => {
      if (tokenAddress === 'tok1') return [pairFixture({ baseToken: { address: 'tok1', symbol: 'FRESH', name: 'Fresh' } })]
      if (tokenAddress === 'tok3') {
        return [pairFixture({
          baseToken: { address: 'tok3', symbol: 'OLD', name: 'Old' },
          pairCreatedAt: Date.now() - 25 * 60 * 60_000, // 25h ago -> excluded
        })]
      }
      return []
    })
    securityMock.mockResolvedValue({ passed: true, reasons: [] })

    const rows = await buildRetroTodayReport('solana', 5000)

    expect(rows).toHaveLength(1)
    expect(rows[0].symbol).toBe('FRESH')
    expect(pairsMock).not.toHaveBeenCalledWith('ethereum', 'tok2')
  })

  it('picks the priceChange window nearest the token age', async () => {
    profilesMock.mockResolvedValue([
      { chainId: 'solana', tokenAddress: 'young' },
      { chainId: 'solana', tokenAddress: 'medium' },
      { chainId: 'solana', tokenAddress: 'old' },
    ])
    pairsMock.mockImplementation(async (_chain: string, tokenAddress: string) => [
      pairFixture({
        baseToken: { address: tokenAddress, symbol: tokenAddress, name: tokenAddress },
        pairCreatedAt:
          tokenAddress === 'young' ? Date.now() - 30 * 60_000
            : tokenAddress === 'medium' ? Date.now() - 3 * 60 * 60_000
              : Date.now() - 10 * 60 * 60_000,
      }),
    ])
    securityMock.mockResolvedValue({ passed: true, reasons: [] })

    const rows = await buildRetroTodayReport('solana', 5000)
    const byToken = Object.fromEntries(rows.map(r => [r.tokenAddress, r]))

    expect(byToken.young.priceChangeWindow).toBe('h1')
    expect(byToken.medium.priceChangeWindow).toBe('h6')
    expect(byToken.old.priceChangeWindow).toBe('h24')
  })

  it('passes minLiquidityUsd through to checkTokenSecurity and reuses its verdict verbatim', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'tok1' }])
    pairsMock.mockResolvedValue([pairFixture()])
    securityMock.mockResolvedValue({ passed: false, reasons: ['Liquidity $100 below minimum $9999'] })

    const rows = await buildRetroTodayReport('solana', 9999)

    expect(securityMock).toHaveBeenCalledWith('solana', 'tok1', expect.objectContaining({ minLiquidityUsd: 9999 }))
    expect(rows[0].passed).toBe(false)
    expect(rows[0].reasons).toEqual(['Liquidity $100 below minimum $9999'])
  })

  it('sorts rows by priceChangePercent descending', async () => {
    profilesMock.mockResolvedValue([
      { chainId: 'solana', tokenAddress: 'low' },
      { chainId: 'solana', tokenAddress: 'high' },
    ])
    pairsMock.mockImplementation(async (_chain: string, tokenAddress: string) => [
      pairFixture({
        baseToken: { address: tokenAddress, symbol: tokenAddress, name: tokenAddress },
        priceChange: { h1: tokenAddress === 'low' ? -50 : 200 },
      }),
    ])
    securityMock.mockResolvedValue({ passed: true, reasons: [] })

    const rows = await buildRetroTodayReport('solana', 5000)

    expect(rows.map(r => r.symbol)).toEqual(['high', 'low'])
  })

  it('skips a candidate with no known pool / no pairCreatedAt', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'ghost' }])
    pairsMock.mockResolvedValue([])

    const rows = await buildRetroTodayReport('solana', 5000)

    expect(rows).toEqual([])
    expect(securityMock).not.toHaveBeenCalled()
  })
})

describe('report formatting', () => {
  const rows = [
    {
      chain: 'solana', symbol: 'MEME', tokenAddress: 'tok1', liquidityUsd: 12345,
      ageMinutes: 42, priceChangeWindow: 'h1' as const, priceChangePercent: 88.8,
      passed: true, reasons: [],
    },
  ]

  it('formatTerminalReport includes the approximation disclaimer and the row', () => {
    const text = formatTerminalReport(rows, 'solana', 5000)
    expect(text).toMatch(/approximation/i)
    expect(text).toMatch(/MEME/)
    expect(text).toMatch(/88\.8%/)
  })

  it('formatTerminalReport handles an empty result set', () => {
    const text = formatTerminalReport([], 'solana', 5000)
    expect(text).toMatch(/No candidates found/i)
  })

  it('formatMarkdownReport produces a markdown table with the disclaimer', () => {
    const md = formatMarkdownReport(rows, 'solana', 5000)
    expect(md).toMatch(/^# Retro report/)
    expect(md).toMatch(/Approximation, not a simulation/)
    expect(md).toMatch(/\| solana \| MEME \|/)
  })
})
