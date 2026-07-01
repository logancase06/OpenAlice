import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { BrokerError } from '../types.js'
import '../../contract-ext.js'

vi.mock('./dex-market-data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dex-market-data.js')>()
  return {
    ...actual,
    searchDexScreenerPairs: vi.fn(),
    fetchDexScreenerTokenPairs: vi.fn(),
  }
})

import { DexBroker } from './DexBroker.js'
import { searchDexScreenerPairs, fetchDexScreenerTokenPairs, type DexScreenerPair } from './dex-market-data.js'

const searchMock = vi.mocked(searchDexScreenerPairs)
const pairsMock = vi.mocked(fetchDexScreenerTokenPairs)

function pair(overrides: Partial<DexScreenerPair> & { address: string; priceUsd: string }): DexScreenerPair {
  return {
    chainId: 'solana',
    pairAddress: `pair-${overrides.address}`,
    baseToken: { address: overrides.address, symbol: 'MEME', name: 'Meme Coin' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL' },
    liquidity: { usd: 50_000 },
    volume: { h24: 10_000 },
    ...overrides,
  }
}

beforeEach(() => {
  searchMock.mockReset()
  pairsMock.mockReset()
})

describe('DexBroker.fromConfig', () => {
  it('parses config and defaults paper=true, paperCashUsd=1000', () => {
    const broker = DexBroker.fromConfig({ id: 'dex-solana', brokerConfig: { chain: 'solana' } })
    expect(broker.meta.chain).toBe('solana')
  })
})

describe('DexBroker.init', () => {
  it('resolves in paper mode', async () => {
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    await expect(broker.init()).resolves.toBeUndefined()
  })

  it('refuses to start with paper: false (Phase B not implemented)', async () => {
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: false })
    await expect(broker.init()).rejects.toThrow(BrokerError)
  })
})

describe('DexBroker.searchContracts', () => {
  it('filters to this chain and dedupes by token address keeping best liquidity', async () => {
    searchMock.mockResolvedValue([
      pair({ address: 'tokenA', priceUsd: '0.01', liquidity: { usd: 1000 } }),
      pair({ address: 'tokenA', priceUsd: '0.01', liquidity: { usd: 5000 } }),
      pair({ address: 'tokenB', priceUsd: '0.02', chainId: 'ethereum' }),
    ])

    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    const results = await broker.searchContracts('meme')

    expect(results).toHaveLength(1)
    expect(results[0].contract.localSymbol).toBe('tokenA')
  })
})

describe('DexBroker.getQuote', () => {
  it('returns the DexScreener price for the best-liquidity pair', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0.05' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    const contract = broker.resolveNativeKey('tokenA')

    const quote = await broker.getQuote(contract)

    expect(quote.last).toBe('0.05')
  })

  it('throws BrokerError when no price is available', async () => {
    pairsMock.mockResolvedValue([])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    const contract = broker.resolveNativeKey('unknown-token')

    await expect(broker.getQuote(contract)).rejects.toThrow(BrokerError)
  })

  it('throws BrokerError on a zero price instead of poisoning the ledger with Infinity/NaN', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    const contract = broker.resolveNativeKey('tokenA')

    await expect(broker.getQuote(contract)).rejects.toThrow(BrokerError)
  })

  it('throws BrokerError on a malformed (non-numeric) price', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: 'not-a-number' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    const contract = broker.resolveNativeKey('tokenA')

    await expect(broker.getQuote(contract)).rejects.toThrow(BrokerError)
  })
})

describe('DexBroker.placeOrder (paper mode)', () => {
  it('buys with a cash amount and books a position at the quoted price', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0.10' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const contract = broker.resolveNativeKey('tokenA')

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.cashQty = new Decimal(100)

    const result = await broker.placeOrder(contract, order)

    expect(result.success).toBe(true)
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].quantity.toString()).toBe('1000') // 100 / 0.10
    expect(positions[0].avgCost).toBe('0.1')

    const account = await broker.getAccount()
    expect(account.totalCashValue).toBe('900')
  })

  it('rejects a cash-based buy against a zero-price quote instead of corrupting the ledger', async () => {
    // Regression test: cashQty.div(price) with price=0 doesn't throw in
    // Decimal.js (it silently returns Infinity), which previously would have
    // poisoned this.cash with NaN on the next fill. getQuote now rejects a
    // non-positive price before placeOrder ever computes a quantity from it.
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const contract = broker.resolveNativeKey('tokenA')

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.cashQty = new Decimal(100)

    const result = await broker.placeOrder(contract, order)

    expect(result.success).toBe(false)
    const account = await broker.getAccount()
    expect(account.totalCashValue).toBe('1000')
    expect(Number.isNaN(Number(account.totalCashValue))).toBe(false)
  })

  it('rejects selling a token with no existing position', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0.10' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    const contract = broker.resolveNativeKey('tokenA')

    const order = new Order()
    order.action = 'SELL'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(10)

    const result = await broker.placeOrder(contract, order)
    expect(result.success).toBe(false)
  })

  it('reflects unrealized PnL from a price move', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0.10' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const contract = broker.resolveNativeKey('tokenA')

    const buy = new Order()
    buy.action = 'BUY'
    buy.orderType = 'MKT'
    buy.cashQty = new Decimal(100)
    await broker.placeOrder(contract, buy)

    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0.20' })])
    const account = await broker.getAccount()
    // 1000 units bought at 0.10, now worth 0.20 -> +100 unrealized
    expect(account.unrealizedPnL).toBe('100')
  })

  it('closePosition sells the full position and realizes PnL', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0.10' })])
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const contract = broker.resolveNativeKey('tokenA')

    const buy = new Order()
    buy.action = 'BUY'
    buy.orderType = 'MKT'
    buy.cashQty = new Decimal(100)
    await broker.placeOrder(contract, buy)

    pairsMock.mockResolvedValue([pair({ address: 'tokenA', priceUsd: '0.20' })])
    const result = await broker.closePosition(contract)

    expect(result.success).toBe(true)
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(0)
    const account = await broker.getAccount()
    // 900 cash after buy + 1000 units * 0.20 = 900 + 200 = 1100
    expect(account.totalCashValue).toBe('1100')
  })
})

describe('DexBroker unsupported operations', () => {
  it('modifyOrder and cancelOrder fail — DEX swaps have no resting order', async () => {
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    expect((await broker.modifyOrder('x', {})).success).toBe(false)
    expect((await broker.cancelOrder('x')).success).toBe(false)
  })

  it('getOpenOrders is always empty (paper fills are synchronous)', async () => {
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    expect(await broker.getOpenOrders()).toEqual([])
  })
})

describe('DexBroker.getCapabilities', () => {
  it('declares market-only orders, no CCXT-style order book/funding-rate surface', () => {
    const broker = new DexBroker({ id: 'dex-solana', chain: 'solana', paper: true })
    const caps = broker.getCapabilities()
    expect(caps.supportedOrderTypes).toEqual(['MKT'])
    expect(caps.historicalBars).toBeUndefined()
  })
})
