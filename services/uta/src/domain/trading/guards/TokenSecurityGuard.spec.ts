import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { checkTokenSecurity, TokenSecurityGuard, type TokenSecurityConfig } from './TokenSecurityGuard.js'
import { makeContract } from '../brokers/mock/index.js'
import type { GuardContext } from './types.js'
import type { Operation } from '../git/types.js'
import '../contract-ext.js'

const fetchSpy = vi.fn()

function goPlusResponse(chain: 'evm' | 'solana', tokenAddress: string, data: Record<string, unknown>): Response {
  const result = chain === 'evm'
    ? { [tokenAddress.toLowerCase()]: data }
    : { [tokenAddress]: data }
  return new Response(JSON.stringify({ code: 1, message: 'OK', result }))
}

const FULL_CONFIG: TokenSecurityConfig = {
  rejectIfHoneypot: true,
  rejectIfMintable: true,
  rejectIfOwnerCanBlacklist: true,
  rejectIfHighTax: true,
  maxBuyTaxPercent: 10,
  maxSellTaxPercent: 10,
  minHolderCount: 20,
  maxTop10HolderPercent: 70,
  rejectIfLiquidityUnlocked: true,
}

beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})

describe('checkTokenSecurity', () => {
  it('rejects a honeypot token (EVM)', async () => {
    fetchSpy.mockResolvedValue(goPlusResponse('evm', '0xdead', {
      is_honeypot: '1', is_mintable: '0', holder_count: '500',
      holders: [], lp_holders: [{ percent: '0.9', is_locked: '1' }],
      buy_tax: '0', sell_tax: '0',
    }))

    const result = await checkTokenSecurity('ethereum', '0xdead', FULL_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/honeypot/i)
  })

  it('rejects a token with excessive sell tax (EVM)', async () => {
    fetchSpy.mockResolvedValue(goPlusResponse('evm', '0xtax', {
      is_honeypot: '0', is_mintable: '0', holder_count: '500',
      holders: [], lp_holders: [{ percent: '0.9', is_locked: '1' }],
      buy_tax: '0.02', sell_tax: '0.5',
    }))

    const result = await checkTokenSecurity('bsc', '0xtax', FULL_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/sell tax/i)
  })

  it('passes a clean token (EVM)', async () => {
    fetchSpy.mockResolvedValue(goPlusResponse('evm', '0xclean', {
      is_honeypot: '0', is_mintable: '0', is_blacklisted: '0', transfer_pausable: '0',
      holder_count: '5000', buy_tax: '0.01', sell_tax: '0.01',
      holders: [{ percent: '0.05' }],
      lp_holders: [{ percent: '0.95', is_locked: '1' }],
    }))

    const result = await checkTokenSecurity('base', '0xclean', FULL_CONFIG)

    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('rejects a mintable token (Solana)', async () => {
    fetchSpy.mockResolvedValue(goPlusResponse('solana', 'MintAddr111', {
      mintable: { status: '1' },
      freezable: { status: '0' },
    }))

    const result = await checkTokenSecurity('solana', 'MintAddr111', FULL_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/mintable/i)
  })

  it('passes a widely-held Solana token with near-zero burn_percent on its top pool', async () => {
    // Regression test: live-verified against real BONK. Concentrated-liquidity
    // pools (Raydium CLMM / Orca Whirlpools) routinely show burn_percent near 0
    // even for legitimate, non-scam tokens — this must NOT be treated as a
    // liquidity-lock red flag on Solana (see the comment in checkSolana).
    fetchSpy.mockResolvedValue(goPlusResponse('solana', 'BonkLikeMint', {
      mintable: { status: '0' },
      freezable: { status: '0' },
      holder_count: 999069,
      holders: [{ percent: '0.0795' }, { percent: '0.0535' }, { percent: '0.0503' }],
      dex: [{ tvl: '145794.32', burn_percent: 0 }],
    }))

    const result = await checkTokenSecurity('solana', 'BonkLikeMint', FULL_CONFIG)

    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('fails safe (passed=false) when GoPlus is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'))

    const result = await checkTokenSecurity('ethereum', '0xunknown', FULL_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/unavailable|unknown/i)
  })

  it('fails safe (passed=false) when GoPlus returns an error code', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ code: 5000, message: 'system error', result: null })))

    const result = await checkTokenSecurity('solana', '0xtimeout', FULL_CONFIG)

    expect(result.passed).toBe(false)
  })
})

describe('checkTokenSecurity minLiquidityUsd', () => {
  // Only this describe block enables minLiquidityUsd, so every other test
  // above is unaffected (the liquidity fetch is gated by config presence —
  // no config, no extra call, no need to route the mock by URL there).
  const LIQUIDITY_CONFIG: TokenSecurityConfig = { minLiquidityUsd: 5000 }
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }

  function mockLiquidityAndGoPlus(liquidityUsd: number | undefined): void {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) {
        const pairs = liquidityUsd === undefined
          ? []
          : [{
            chainId: 'solana',
            pairAddress: 'pair-1',
            baseToken: { address: 'tok', symbol: 'X', name: 'X Coin' },
            quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
            liquidity: { usd: liquidityUsd },
          }]
        return new Response(JSON.stringify(pairs))
      }
      return goPlusResponse('solana', 'tok', CLEAN_GOPLUS_DATA)
    })
  }

  it('rejects a token below the liquidity threshold', async () => {
    mockLiquidityAndGoPlus(4999)

    const result = await checkTokenSecurity('solana', 'tok', LIQUIDITY_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/liquidity \$4999 below minimum \$5000/i)
  })

  it('passes a token exactly at the threshold — inclusive', async () => {
    mockLiquidityAndGoPlus(5000)

    const result = await checkTokenSecurity('solana', 'tok', LIQUIDITY_CONFIG)

    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('passes a token above the threshold when other checks pass', async () => {
    mockLiquidityAndGoPlus(10_000)

    const result = await checkTokenSecurity('solana', 'tok', LIQUIDITY_CONFIG)

    expect(result.passed).toBe(true)
  })

  it('treats missing liquidity data as 0 — fail-safe, not a pass', async () => {
    mockLiquidityAndGoPlus(undefined)

    const result = await checkTokenSecurity('solana', 'tok', LIQUIDITY_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/liquidity \$0 below minimum \$5000/i)
  })

  it('skips the liquidity check entirely when minLiquidityUsd is unset (no extra network call)', async () => {
    fetchSpy.mockResolvedValue(goPlusResponse('solana', 'tok', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'tok', { ...LIQUIDITY_CONFIG, minLiquidityUsd: undefined })

    expect(result.passed).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // GoPlus only — no DexScreener call
  })
})

describe('TokenSecurityGuard', () => {
  function makeBuyOp(tokenAddress: string, chain: string): Operation {
    // makeContract doesn't wire through `localSymbol`, so use `symbol` as the
    // stand-in token address — the guard reads `localSymbol || symbol`.
    const contract = makeContract({ symbol: tokenAddress, exchange: chain })
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(100)
    return { action: 'placeOrder', contract, order }
  }

  function makeCtx(op: Operation): GuardContext {
    return {
      operation: op,
      positions: [],
      account: { baseCurrency: 'USD', netLiquidation: '1000', totalCashValue: '1000', unrealizedPnL: '0', realizedPnL: '0' },
    }
  }

  it('no-ops on non-placeOrder operations', async () => {
    const guard = new TokenSecurityGuard(FULL_CONFIG as Record<string, unknown>)
    const ctx = makeCtx({ action: 'cancelOrder', orderId: 'x' })
    expect(await guard.check(ctx)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no-ops on SELL operations (only buys are screened)', async () => {
    const guard = new TokenSecurityGuard(FULL_CONFIG as Record<string, unknown>)
    const op = makeBuyOp('0xdead', 'ethereum')
    if (op.action === 'placeOrder') op.order.action = 'SELL'
    expect(await guard.check(makeCtx(op))).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a buy that fails the security check', async () => {
    fetchSpy.mockResolvedValue(goPlusResponse('evm', '0xdead', {
      is_honeypot: '1', holder_count: '500', holders: [], lp_holders: [],
    }))
    const guard = new TokenSecurityGuard(FULL_CONFIG as Record<string, unknown>)
    const rejection = await guard.check(makeCtx(makeBuyOp('0xdead', 'ethereum')))
    expect(rejection).toMatch(/token security check failed/i)
  })

  it('allows a buy that passes, and caches the verdict', async () => {
    fetchSpy.mockResolvedValue(goPlusResponse('evm', '0xclean', {
      is_honeypot: '0', is_mintable: '0', holder_count: '5000', buy_tax: '0', sell_tax: '0',
      holders: [], lp_holders: [{ percent: '0.9', is_locked: '1' }],
    }))
    const guard = new TokenSecurityGuard(FULL_CONFIG as Record<string, unknown>)
    const op = makeBuyOp('0xclean', 'ethereum')

    expect(await guard.check(makeCtx(op))).toBeNull()
    expect(await guard.check(makeCtx(op))).toBeNull()
    // Second check within the TTL window reuses the cached verdict.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
