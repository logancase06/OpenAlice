import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Decimal from 'decimal.js'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { Order } from '@traderalice/ibkr'
import { dataPath } from '@/core/paths.js'
import { checkTokenSecurity, TokenSecurityGuard, type TokenSecurityConfig } from './TokenSecurityGuard.js'
import { makeContract } from '../brokers/mock/index.js'
import type { GuardContext } from './types.js'
import type { Operation } from '../git/types.js'
import type { DexScreenerPair } from '../brokers/dex/dex-market-data.js'
import '../contract-ext.js'

const fetchSpy = vi.fn()

function goPlusResponse(chain: 'evm' | 'solana', tokenAddress: string, data: Record<string, unknown>): Response {
  const result = chain === 'evm'
    ? { [tokenAddress.toLowerCase()]: data }
    : { [tokenAddress]: data }
  return new Response(JSON.stringify({ code: 1, message: 'OK', result }))
}

async function seedSnapshots(pairAddress: string, snapshots: Array<{ liquidityUsd: number; priceUsd: number; buyTxns1h: number; sellTxns1h: number; timestamp: number }>): Promise<void> {
  await mkdir(dataPath('snapshots'), { recursive: true })
  await writeFile(dataPath('snapshots', `${pairAddress}.json`), JSON.stringify(snapshots.map(s => ({ pairAddress, ...s }))))
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

afterEach(async () => {
  await rm(dataPath('snapshots'), { recursive: true, force: true })
})

describe('checkTokenSecurity', () => {
  it('rejects a honeypot token (EVM)', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('evm', '0xdead', {
      is_honeypot: '1', is_mintable: '0', holder_count: '500',
      holders: [], lp_holders: [{ percent: '0.9', is_locked: '1' }],
      buy_tax: '0', sell_tax: '0',
    }))

    const result = await checkTokenSecurity('ethereum', '0xdead', FULL_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/honeypot/i)
  })

  it('rejects a token with excessive sell tax (EVM)', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('evm', '0xtax', {
      is_honeypot: '0', is_mintable: '0', holder_count: '500',
      holders: [], lp_holders: [{ percent: '0.9', is_locked: '1' }],
      buy_tax: '0.02', sell_tax: '0.5',
    }))

    const result = await checkTokenSecurity('bsc', '0xtax', FULL_CONFIG)

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/sell tax/i)
  })

  it('passes a clean token (EVM)', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('evm', '0xclean', {
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
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'MintAddr111', {
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
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'BonkLikeMint', {
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

describe('checkTokenSecurity Solana structural blockers (transfer_hook, non_transferable, transfer_fee, balance_mutable_authority)', () => {
  // Unconditional — no config flag gates these, same precedent as
  // checkCrashGap — so an empty config `{}` is used throughout to prove
  // they fire regardless of what a strategy opted into.
  const CLEAN_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }

  it('rejects a token with an active transfer_hook', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'HookMint', {
      ...CLEAN_DATA,
      transfer_hook: [{ authority: 'SomeProgram1111111111111111111111111111111' }],
    }))

    const result = await checkTokenSecurity('solana', 'HookMint', {})

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/transfer hook/i)
  })

  it('passes when transfer_hook is an empty array', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'NoHookMint', { ...CLEAN_DATA, transfer_hook: [] }))

    const result = await checkTokenSecurity('solana', 'NoHookMint', {})

    expect(result.passed).toBe(true)
  })

  it('rejects a token marked non_transferable', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'FrozenMint', { ...CLEAN_DATA, non_transferable: '1' }))

    const result = await checkTokenSecurity('solana', 'FrozenMint', {})

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/non-transferable/i)
  })

  it('passes when non_transferable is "0"', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'TransferableMint', { ...CLEAN_DATA, non_transferable: '0' }))

    const result = await checkTokenSecurity('solana', 'TransferableMint', {})

    expect(result.passed).toBe(true)
  })

  it('rejects a token with a non-empty transfer_fee object, and logs its raw value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'TaxedMint', { ...CLEAN_DATA, transfer_fee: { transfer_fee_pct: '5' } }))

    const result = await checkTokenSecurity('solana', 'TaxedMint', {})

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/transfer fee/i)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('transfer_fee_pct'))
    logSpy.mockRestore()
  })

  it('passes when transfer_fee is an empty object (the only shape observed live so far)', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'NoFeeMint', { ...CLEAN_DATA, transfer_fee: {} }))

    const result = await checkTokenSecurity('solana', 'NoFeeMint', {})

    expect(result.passed).toBe(true)
  })

  it('rejects a token with an active balance_mutable_authority', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'MutableBalanceMint', { ...CLEAN_DATA, balance_mutable_authority: { status: '1' } }))

    const result = await checkTokenSecurity('solana', 'MutableBalanceMint', {})

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/balance-mutable authority/i)
  })

  it('passes when all four structural fields are absent from the GoPlus response entirely', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'BareMint', CLEAN_DATA))

    const result = await checkTokenSecurity('solana', 'BareMint', {})

    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('applies these checks regardless of strategy config — no flag needed, unlike rejectIfHoneypot', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'HookMint2', { ...CLEAN_DATA, non_transferable: '1' }))

    // Config explicitly does NOT set rejectIfHoneypot/rejectIfMintable/etc —
    // the structural blocker must still fire.
    const result = await checkTokenSecurity('solana', 'HookMint2', { minLiquidityUsd: 8000 })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/non-transferable/i)
  })
})

describe('checkTokenSecurity existingPair reuse', () => {
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }
  const knownPair: DexScreenerPair = {
    chainId: 'solana',
    pairAddress: 'pair-reuse',
    baseToken: { address: 'reuseMint', symbol: 'RE', name: 'Reuse Coin' },
    quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
    liquidity: { usd: 20_000 },
  }

  it('skips the DexScreener fetch entirely when an existingPair is provided — only GoPlus is called', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'reuseMint', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'reuseMint', {}, knownPair)

    expect(result.passed).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // GoPlus only
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/gopluslabs/)
  })

  it('still fetches DexScreener normally (pair + GoPlus) when no existingPair is provided', async () => {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) return new Response(JSON.stringify([knownPair]))
      return goPlusResponse('solana', 'reuseMint', CLEAN_GOPLUS_DATA)
    })

    const result = await checkTokenSecurity('solana', 'reuseMint', {})

    expect(result.passed).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // DexScreener pair fetch + GoPlus
  })
})

describe('checkTokenSecurity requireWebsite (EARLY_WEB_FILTERED_CONFIG)', () => {
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }
  function pairWithWebsite(websites: Array<{ url: string; label?: string }> | undefined): DexScreenerPair {
    return {
      chainId: 'solana',
      pairAddress: 'pair-web',
      baseToken: { address: 'webMint', symbol: 'WEB', name: 'Web Coin' },
      quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
      liquidity: { usd: 20_000 },
      info: websites === undefined ? undefined : { websites },
    }
  }

  it('rejects a token with no website when requireWebsite is true', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'webMint', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'webMint', { requireWebsite: true }, pairWithWebsite([]))

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/no website listed/i)
  })

  it('rejects when pair.info itself is absent (no website data at all) — missing data fails safe here, unlike other DexScreener checks', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'webMint', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'webMint', { requireWebsite: true }, pairWithWebsite(undefined))

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/no website listed/i)
  })

  it('passes a token with a website listed when requireWebsite is true', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'webMint', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'webMint', { requireWebsite: true }, pairWithWebsite([{ url: 'https://example.com' }]))

    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('skips the check entirely when requireWebsite is unset — a website-less token still passes', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'webMint', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'webMint', {}, pairWithWebsite([]))

    expect(result.passed).toBe(true)
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

  it('skips the liquidity REJECTION check when minLiquidityUsd is unset (checkCrashGap still fetches the pair unconditionally)', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'tok', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'tok', { ...LIQUIDITY_CONFIG, minLiquidityUsd: undefined })

    expect(result.passed).toBe(true)
    // 2 calls, not 1: checkCrashGap has no config flag and always needs the
    // pair snapshot now, so the DexScreener fetch happens regardless of
    // minLiquidityUsd — only the liquidity REJECTION logic is skipped.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('checkTokenSecurity crash-gap detection (checkCrashGap)', () => {
  // No config flag gates this — applies for every candidate regardless of
  // what else is configured, so an empty config `{}` is used throughout.
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }

  function mockPriceChangeAndGoPlus(priceChange: { m5?: number; h1?: number } | undefined): void {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) {
        const pairs = priceChange === undefined
          ? []
          : [{
            chainId: 'solana',
            pairAddress: 'pair-1',
            baseToken: { address: 'tok', symbol: 'X', name: 'X Coin' },
            quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
            liquidity: { usd: 20_000 },
            priceChange,
          }]
        return new Response(JSON.stringify(pairs))
      }
      return goPlusResponse('solana', 'tok', CLEAN_GOPLUS_DATA)
    })
  }

  it('rejects a token down more than 30% in the last 5 minutes', async () => {
    mockPriceChangeAndGoPlus({ m5: -35 })

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Crash detected.*>30%.*-35\.0%/)
  })

  it('rejects a token down more than 50% in the last hour', async () => {
    mockPriceChangeAndGoPlus({ h1: -60 })

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/freefall.*>50%.*-60\.0%/)
  })

  it('rejects a token in freefall at -87% h1 (matches the brokn/cat crashes\' actual magnitude, once the check does see it)', async () => {
    mockPriceChangeAndGoPlus({ h1: -87.2 })

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/freefall.*-87\.2%/)
  })

  it('passes a token with a mild dip that does not cross either threshold', async () => {
    mockPriceChangeAndGoPlus({ m5: -10, h1: -20 })

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(true)
  })

  it('is not gated by any config flag — applies even with a fully empty config', async () => {
    mockPriceChangeAndGoPlus({ m5: -40 })

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(false)
  })

  it('skips the check when priceChange data is missing entirely — not rejected', async () => {
    mockPriceChangeAndGoPlus({})

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(true)
  })

  it('treats no resolvable DexScreener pair as skipped, not rejected', async () => {
    mockPriceChangeAndGoPlus(undefined)

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(true)
  })
})

describe('checkTokenSecurity maxPriceChangePct1h (checkOverextension, EARLY_STRICT)', () => {
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }

  function mockPriceChangeAndGoPlus(priceChange: { m5?: number; h1?: number } | undefined): void {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) {
        const pairs = priceChange === undefined
          ? []
          : [{
            chainId: 'solana',
            pairAddress: 'pair-1',
            baseToken: { address: 'tok', symbol: 'X', name: 'X Coin' },
            quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
            liquidity: { usd: 20_000 },
            priceChange,
          }]
        return new Response(JSON.stringify(pairs))
      }
      return goPlusResponse('solana', 'tok', CLEAN_GOPLUS_DATA)
    })
  }

  it('rejects a token up +160% in the last hour (> 150% threshold) — likely already topped out', async () => {
    mockPriceChangeAndGoPlus({ h1: 160 })

    const result = await checkTokenSecurity('solana', 'tok', { maxPriceChangePct1h: 150 })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/already topped out.*160\.0%/)
  })

  it('passes a token up +100% in the last hour (below the 150% threshold)', async () => {
    mockPriceChangeAndGoPlus({ h1: 100 })

    const result = await checkTokenSecurity('solana', 'tok', { maxPriceChangePct1h: 150 })

    expect(result.passed).toBe(true)
  })

  it('is skipped entirely when maxPriceChangePct1h is unset', async () => {
    mockPriceChangeAndGoPlus({ h1: 500 })

    const result = await checkTokenSecurity('solana', 'tok', {})

    expect(result.passed).toBe(true)
  })

  it('skips (does not reject) when h1 data is missing', async () => {
    mockPriceChangeAndGoPlus({})

    const result = await checkTokenSecurity('solana', 'tok', { maxPriceChangePct1h: 150 })

    expect(result.passed).toBe(true)
  })
})

describe('checkTokenSecurity maxPriceChangePct1h bypass via wallet-bootstrapper.ts qualified signals', () => {
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }
  const QUALIFIED_WALLET_A = 'QualifiedWalletA1111111111111111111111111'
  const QUALIFIED_WALLET_B = 'QualifiedWalletB1111111111111111111111111'

  function mockOverextendedTokenWithBuyers(buyerPubkeys: string[]): void {
    fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) {
        return new Response(JSON.stringify([{
          chainId: 'solana',
          pairAddress: 'pair-1',
          baseToken: { address: 'tok', symbol: 'X', name: 'X Coin' },
          quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
          liquidity: { usd: 20_000 },
          priceChange: { h1: 999 }, // way past any maxPriceChangePct1h threshold
        }]))
      }
      const body = init?.body ? JSON.parse(init.body as string) as { method?: string; params?: unknown[] } : {}
      if (body.method === 'getSignaturesForAddress') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', result: buyerPubkeys.map((_, i) => ({ signature: `sig${i}`, blockTime: Math.floor(Date.now() / 1000) })) }))
      }
      if (body.method === 'getTransaction') {
        const sig = body.params?.[0] as string
        const idx = Number(sig.replace('sig', ''))
        return new Response(JSON.stringify({ jsonrpc: '2.0', result: { transaction: { message: { accountKeys: [{ pubkey: buyerPubkeys[idx], signer: true }] } } } }))
      }
      return goPlusResponse('solana', 'tok', CLEAN_GOPLUS_DATA)
    })
  }

  async function seedBootstrapped(qualifiedAddresses: string[]): Promise<void> {
    await mkdir(dataPath('wallets'), { recursive: true })
    await writeFile(dataPath('wallets', 'bootstrapped.json'), JSON.stringify({
      bootstrappedAt: Date.now(),
      walletCount: qualifiedAddresses.length,
      qualifiedWallets: [],
      allWallets: qualifiedAddresses.map(addr => ({
        walletAddress: addr,
        trades: [],
        computedStats: { totalTrades: 6, winRate: 0.7, avgReturn: 40, lastActiveAt: Date.now() },
      })),
    }))
  }

  afterEach(async () => {
    await rm(dataPath('wallets'), { recursive: true, force: true })
  })

  it('still rejects an overextended token when fewer than 2 qualified wallets bought it', async () => {
    await seedBootstrapped([QUALIFIED_WALLET_A])
    mockOverextendedTokenWithBuyers([QUALIFIED_WALLET_A])

    const result = await checkTokenSecurity('solana', 'tok', { maxPriceChangePct1h: 150 })

    expect(result.passed).toBe(false)
  })

  it('bypasses the overextension reject when 2+ qualified wallets bought it', async () => {
    await seedBootstrapped([QUALIFIED_WALLET_A, QUALIFIED_WALLET_B])
    mockOverextendedTokenWithBuyers([QUALIFIED_WALLET_A, QUALIFIED_WALLET_B])

    const result = await checkTokenSecurity('solana', 'tok', { maxPriceChangePct1h: 150 })

    expect(result.passed).toBe(true)
  })

  it('does not query bootstrapped signals at all when maxPriceChangePct1h is unset (no wasted RPC call)', async () => {
    mockOverextendedTokenWithBuyers([QUALIFIED_WALLET_A, QUALIFIED_WALLET_B])

    await checkTokenSecurity('solana', 'tok', {})

    const rpcCalls = fetchSpy.mock.calls.filter(([, init]) => {
      if (!init?.body) return false
      const method = (JSON.parse(init.body as string) as { method?: string }).method
      return method === 'getSignaturesForAddress' || method === 'getTransaction'
    })
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('checkTokenSecurity minBuyTxns1h / maxSellBuyRatio1h', () => {
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }

  function mockTxnsAndGoPlus(txns: { buys: number; sells: number } | undefined): void {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) {
        const pairs = txns === undefined
          ? []
          : [{
            chainId: 'solana',
            pairAddress: 'pair-1',
            baseToken: { address: 'tok', symbol: 'X', name: 'X Coin' },
            quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
            liquidity: { usd: 20_000 },
            txns: { h1: txns },
          }]
        return new Response(JSON.stringify(pairs))
      }
      return goPlusResponse('solana', 'tok', CLEAN_GOPLUS_DATA)
    })
  }

  it('rejects insufficient buy activity', async () => {
    mockTxnsAndGoPlus({ buys: 10, sells: 2 })

    const result = await checkTokenSecurity('solana', 'tok', { minBuyTxns1h: 15 })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Insufficient buy activity.*10 buys < 15/)
  })

  it('passes sufficient buy activity', async () => {
    mockTxnsAndGoPlus({ buys: 20, sells: 5 })

    const result = await checkTokenSecurity('solana', 'tok', { minBuyTxns1h: 15 })

    expect(result.passed).toBe(true)
  })

  it('rejects heavy sell pressure (sells > buys * ratio)', async () => {
    mockTxnsAndGoPlus({ buys: 10, sells: 40 })

    const result = await checkTokenSecurity('solana', 'tok', { maxSellBuyRatio1h: 3.0 })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Heavy sell pressure.*40 sells vs 10 buys \(ratio 4\.00 > 3\)/)
  })

  it('passes when sell pressure is within the ratio', async () => {
    mockTxnsAndGoPlus({ buys: 10, sells: 25 })

    const result = await checkTokenSecurity('solana', 'tok', { maxSellBuyRatio1h: 3.0 })

    expect(result.passed).toBe(true)
  })

  it('treats zero buys with nonzero sells as maximally sell-heavy, not a divide-by-zero pass', async () => {
    mockTxnsAndGoPlus({ buys: 0, sells: 5 })

    const result = await checkTokenSecurity('solana', 'tok', { maxSellBuyRatio1h: 3.0 })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/ratio ∞/)
  })

  it('treats zero buys and zero sells as no signal (passes)', async () => {
    mockTxnsAndGoPlus({ buys: 0, sells: 0 })

    const result = await checkTokenSecurity('solana', 'tok', { maxSellBuyRatio1h: 3.0 })

    expect(result.passed).toBe(true)
  })

  it('treats missing txns data as 0/0 — fails minBuyTxns1h, no signal for the ratio', async () => {
    mockTxnsAndGoPlus(undefined)

    const result = await checkTokenSecurity('solana', 'tok', { minBuyTxns1h: 15, maxSellBuyRatio1h: 3.0 })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Insufficient buy activity.*0 buys < 15/)
  })

  it('fetches DexScreener only once even with both minLiquidityUsd and a txns check configured', async () => {
    mockTxnsAndGoPlus({ buys: 20, sells: 5 })
    const dexScreenerCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('dexscreener.com')).length

    const result = await checkTokenSecurity('solana', 'tok', { minLiquidityUsd: 5000, minBuyTxns1h: 15 })

    expect(result.passed).toBe(true)
    expect(dexScreenerCalls()).toBe(1)
  })
})

describe('checkTokenSecurity useSolanaRpc', () => {
  // `checkMintAuthority` caches per mintAddress at module scope (by design —
  // authorities rarely change) — so each test below MUST use its own
  // tokenAddress, or a later test would silently read an earlier test's
  // cached RPC result instead of hitting its own mock.
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }

  function solanaRpcResponse(mintAuthority: string | null, freezeAuthority: string | null): Response {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      result: { context: { slot: 1 }, value: { data: { parsed: { type: 'mint', info: { mintAuthority, freezeAuthority, decimals: 6, supply: '1' } }, program: 'spl-token' } } },
      id: 1,
    }))
  }

  function mockRpcAndGoPlus(tokenAddress: string, rpc: { mintAuthority: string | null; freezeAuthority: string | null } | 'down'): void {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('solana.com')) {
        if (rpc === 'down') throw new Error('ECONNREFUSED')
        return solanaRpcResponse(rpc.mintAuthority, rpc.freezeAuthority)
      }
      return goPlusResponse('solana', tokenAddress, CLEAN_GOPLUS_DATA)
    })
  }

  it('rejects when mint authority is active via RPC', async () => {
    mockRpcAndGoPlus('mintActiveTok', { mintAuthority: 'someAuthority111', freezeAuthority: null })

    const result = await checkTokenSecurity('solana', 'mintActiveTok', { useSolanaRpc: true })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Mint authority active/)
  })

  it('rejects when freeze authority is active via RPC', async () => {
    mockRpcAndGoPlus('freezeActiveTok', { mintAuthority: null, freezeAuthority: 'someAuthority222' })

    const result = await checkTokenSecurity('solana', 'freezeActiveTok', { useSolanaRpc: true })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Freeze authority active/)
  })

  it('passes when both authorities are revoked via RPC', async () => {
    mockRpcAndGoPlus('bothRevokedTok', { mintAuthority: null, freezeAuthority: null })

    const result = await checkTokenSecurity('solana', 'bothRevokedTok', { useSolanaRpc: true })

    expect(result.passed).toBe(true)
  })

  it('passes (with a warning, not a rejection) when the Solana RPC is down — unlike GoPlus unavailability', async () => {
    mockRpcAndGoPlus('rpcDownTok', 'down')

    const result = await checkTokenSecurity('solana', 'rpcDownTok', { useSolanaRpc: true, solanaRpcEndpoint: 'https://api.mainnet-beta.solana.com' })

    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('never calls the RPC when useSolanaRpc is unset', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('solana', 'rpcUnsetTok', CLEAN_GOPLUS_DATA))

    const result = await checkTokenSecurity('solana', 'rpcUnsetTok', {})

    expect(result.passed).toBe(true)
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('solana.com'))).toBe(false)
  })

  it('never calls the RPC for an EVM chain even with useSolanaRpc: true', async () => {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('solana.com')) throw new Error('should never be called for an EVM chain')
      return goPlusResponse('evm', '0xtok', { is_honeypot: '0', is_mintable: '0', holder_count: '100', holders: [], lp_holders: [] })
    })

    const result = await checkTokenSecurity('ethereum', '0xtok', { useSolanaRpc: true })

    expect(result.passed).toBe(true)
  })
})

describe('checkTokenSecurity useLiquidityTracker', () => {
  const CLEAN_GOPLUS_DATA = { mintable: { status: '0' }, freezable: { status: '0' } }

  function mockPairAndGoPlus(tokenAddress: string, pairAddress: string): void {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) {
        return new Response(JSON.stringify([{
          chainId: 'solana',
          pairAddress,
          baseToken: { address: tokenAddress, symbol: 'X', name: 'X Coin' },
          quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
          liquidity: { usd: 20_000 },
          txns: { h1: { buys: 10, sells: 2 } },
        }]))
      }
      return goPlusResponse('solana', tokenAddress, CLEAN_GOPLUS_DATA)
    })
  }

  it('passes (skips silently) when there is not enough snapshot history and requireEnoughSnapshots is unset', async () => {
    mockPairAndGoPlus('noHistoryTok', 'noHistoryPair')
    // No snapshots seeded at all — file doesn't exist.

    const result = await checkTokenSecurity('solana', 'noHistoryTok', { useLiquidityTracker: true })

    expect(result.passed).toBe(true)
  })

  it('rejects when there is not enough snapshot history and requireEnoughSnapshots is true', async () => {
    mockPairAndGoPlus('requireHistoryTok', 'requireHistoryPair')

    const result = await checkTokenSecurity('solana', 'requireHistoryTok', { useLiquidityTracker: true, requireEnoughSnapshots: true })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Insufficient tracking data/)
  })

  it('rejects when liquidity has drained more than the default -20% threshold', async () => {
    const now = Date.now()
    await seedSnapshots('drainPair', [
      { liquidityUsd: 20_000, priceUsd: 0.10, buyTxns1h: 10, sellTxns1h: 2, timestamp: now - 20 * 60_000 },
      { liquidityUsd: 15_000, priceUsd: 0.10, buyTxns1h: 10, sellTxns1h: 2, timestamp: now }, // -25%
    ])
    mockPairAndGoPlus('drainTok', 'drainPair')

    const result = await checkTokenSecurity('solana', 'drainTok', { useLiquidityTracker: true })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Liquidity draining -25\.0% — possible rug in progress/)
  })

  it('rejects when sell pressure exceeds the default 0.7 threshold', async () => {
    const now = Date.now()
    await seedSnapshots('sellPressurePair', [
      { liquidityUsd: 20_000, priceUsd: 0.10, buyTxns1h: 10, sellTxns1h: 2, timestamp: now - 20 * 60_000 },
      { liquidityUsd: 20_000, priceUsd: 0.10, buyTxns1h: 2, sellTxns1h: 8, timestamp: now }, // 80% sells
    ])
    mockPairAndGoPlus('sellPressureTok', 'sellPressurePair')

    const result = await checkTokenSecurity('solana', 'sellPressureTok', { useLiquidityTracker: true })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Sell pressure dominant \(80\.0% sells in last hour\)/)
  })

  it('passes when liquidity is stable/growing and sell pressure is within bounds', async () => {
    const now = Date.now()
    await seedSnapshots('healthyPair', [
      { liquidityUsd: 20_000, priceUsd: 0.10, buyTxns1h: 10, sellTxns1h: 2, timestamp: now - 20 * 60_000 },
      { liquidityUsd: 22_000, priceUsd: 0.11, buyTxns1h: 15, sellTxns1h: 3, timestamp: now },
    ])
    mockPairAndGoPlus('healthyTok', 'healthyPair')

    const result = await checkTokenSecurity('solana', 'healthyTok', { useLiquidityTracker: true })

    expect(result.passed).toBe(true)
  })
})

describe('checkTokenSecurity requireGoPlus', () => {
  function solanaRpcResponse(mintAuthority: string | null, freezeAuthority: string | null): Response {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      result: { context: { slot: 1 }, value: { data: { parsed: { type: 'mint', info: { mintAuthority, freezeAuthority, decimals: 6, supply: '1' } }, program: 'spl-token' } } },
      id: 1,
    }))
  }

  function goPlusUnavailableResponse(): Response {
    return new Response(JSON.stringify({ code: 5000, message: 'system error', result: null }))
  }

  function mockStack(opts: {
    tokenAddress: string
    pairAddress: string
    liquidityUsd: number
    rpc: { mintAuthority: string | null; freezeAuthority: string | null }
    goPlusAvailable: boolean
    goPlusData?: Record<string, unknown>
  }): void {
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('dexscreener.com')) {
        return new Response(JSON.stringify([{
          chainId: 'solana',
          pairAddress: opts.pairAddress,
          baseToken: { address: opts.tokenAddress, symbol: 'X', name: 'X Coin' },
          quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
          liquidity: { usd: opts.liquidityUsd },
        }]))
      }
      if (u.includes('solana.com')) {
        return solanaRpcResponse(opts.rpc.mintAuthority, opts.rpc.freezeAuthority)
      }
      // gopluslabs.io
      return opts.goPlusAvailable
        ? goPlusResponse('solana', opts.tokenAddress, opts.goPlusData ?? { mintable: { status: '0' }, freezable: { status: '0' } })
        : goPlusUnavailableResponse()
    })
  }

  it('requireGoPlus: false + GoPlus unavailable + RPC clean + liquidity OK -> passes', async () => {
    mockStack({
      tokenAddress: 'rgpPassTok', pairAddress: 'rgpPassPair', liquidityUsd: 10_000,
      rpc: { mintAuthority: null, freezeAuthority: null }, goPlusAvailable: false,
    })

    const result = await checkTokenSecurity('solana', 'rgpPassTok', {
      requireGoPlus: false, minLiquidityUsd: 8000, useSolanaRpc: true,
    })

    expect(result.passed).toBe(true)
  })

  it('requireGoPlus: false + GoPlus unavailable + mint authority active -> rejects (RPC check still mandatory)', async () => {
    mockStack({
      tokenAddress: 'rgpMintTok', pairAddress: 'rgpMintPair', liquidityUsd: 10_000,
      rpc: { mintAuthority: 'someAuthority', freezeAuthority: null }, goPlusAvailable: false,
    })

    const result = await checkTokenSecurity('solana', 'rgpMintTok', {
      requireGoPlus: false, minLiquidityUsd: 8000, useSolanaRpc: true,
    })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Mint authority active/)
    expect(result.reasons.join(' ')).not.toMatch(/Could not verify token security/)
  })

  it('requireGoPlus: false + GoPlus available -> GoPlus is still called and still applies', async () => {
    mockStack({
      tokenAddress: 'rgpAvailableTok', pairAddress: 'rgpAvailablePair', liquidityUsd: 10_000,
      rpc: { mintAuthority: null, freezeAuthority: null }, goPlusAvailable: true,
      goPlusData: { is_honeypot: '1', mintable: { status: '0' }, freezable: { status: '0' } },
    })

    const result = await checkTokenSecurity('solana', 'rgpAvailableTok', {
      requireGoPlus: false, rejectIfHoneypot: true, minLiquidityUsd: 8000, useSolanaRpc: true,
    })

    // GoPlus responded and flagged a honeypot — requireGoPlus: false does not suppress that.
    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Honeypot detected/)
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('gopluslabs.io'))).toBe(true)
  })

  it('requireGoPlus: true (default) + GoPlus unavailable -> still rejects, unchanged behavior', async () => {
    mockStack({
      tokenAddress: 'rgpDefaultTok', pairAddress: 'rgpDefaultPair', liquidityUsd: 10_000,
      rpc: { mintAuthority: null, freezeAuthority: null }, goPlusAvailable: false,
    })

    const result = await checkTokenSecurity('solana', 'rgpDefaultTok', {
      minLiquidityUsd: 8000, useSolanaRpc: true, // requireGoPlus omitted -> defaults to strict
    })

    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/Could not verify token security/)
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
    fetchSpy.mockImplementation(async () => goPlusResponse('evm', '0xdead', {
      is_honeypot: '1', holder_count: '500', holders: [], lp_holders: [],
    }))
    const guard = new TokenSecurityGuard(FULL_CONFIG as Record<string, unknown>)
    const rejection = await guard.check(makeCtx(makeBuyOp('0xdead', 'ethereum')))
    expect(rejection).toMatch(/token security check failed/i)
  })

  it('allows a buy that passes, and caches the verdict', async () => {
    fetchSpy.mockImplementation(async () => goPlusResponse('evm', '0xclean', {
      is_honeypot: '0', is_mintable: '0', holder_count: '5000', buy_tax: '0', sell_tax: '0',
      holders: [], lp_holders: [{ percent: '0.9', is_locked: '1' }],
    }))
    const guard = new TokenSecurityGuard(FULL_CONFIG as Record<string, unknown>)
    const op = makeBuyOp('0xclean', 'ethereum')

    expect(await guard.check(makeCtx(op))).toBeNull()
    expect(await guard.check(makeCtx(op))).toBeNull()
    // Second check within the TTL window reuses the cached verdict — no new
    // calls from it. The first check makes 2 (GoPlus + the now-unconditional
    // DexScreener fetch for checkCrashGap), not 1.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
