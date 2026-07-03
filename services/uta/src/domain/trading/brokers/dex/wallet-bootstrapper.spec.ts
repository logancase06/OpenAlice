import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { dataPath } from '@/core/paths.js'
import {
  bootstrapWallet,
  collectSeedWallets,
  runBootstrap,
  getBootstrappedSignals,
  __resetBootstrapStateForTests,
} from './wallet-bootstrapper.js'
import { __resetThrottleStateForTests } from './wallet-watcher.js'

const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const WALLET = 'WalletAddr1111111111111111111111111111111'
const MINT = 'Mint111111111111111111111111111111111111'

const fetchSpy = vi.fn()

function jsonRpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', result, id: 1 }))
}

async function bodyOf(init: RequestInit): Promise<{ method: string; params: unknown[] }> {
  return JSON.parse(init.body as string) as { method: string; params: unknown[] }
}

/** blockTime in seconds — buy at t0, optional sell at t0+60. */
function buyTx(blockTimeSec: number, mint = MINT, solSpent = 1, tokensReceived = 1000): unknown {
  return {
    blockTime: blockTimeSec,
    transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }, { pubkey: PUMPFUN_PROGRAM_ID, signer: false }] } },
    meta: {
      err: null,
      preBalances: [10_000_000_000, 0],
      postBalances: [10_000_000_000 - solSpent * 1e9, 0],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 0, mint, owner: WALLET, uiTokenAmount: { uiAmount: tokensReceived } }],
    },
  }
}

function nonPumpTx(blockTimeSec: number): unknown {
  return {
    blockTime: blockTimeSec,
    transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }, { pubkey: 'SomeOtherProgram11111111111111111111111111', signer: false }] } },
    meta: {
      err: null,
      preBalances: [10_000_000_000, 0],
      postBalances: [9_000_000_000, 0],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 0, mint: MINT, owner: WALLET, uiTokenAmount: { uiAmount: 1000 } }],
    },
  }
}

function sellTx(blockTimeSec: number, mint = MINT, tokensHeld = 1000, solReceived = 0.5): unknown {
  return {
    blockTime: blockTimeSec,
    transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }] } },
    meta: {
      err: null,
      preBalances: [9_000_000_000, 0],
      postBalances: [9_000_000_000 + solReceived * 1e9, 0],
      preTokenBalances: [{ accountIndex: 0, mint, owner: WALLET, uiTokenAmount: { uiAmount: tokensHeld } }],
      postTokenBalances: [{ accountIndex: 0, mint, owner: WALLET, uiTokenAmount: { uiAmount: 0 } }],
    },
  }
}

beforeEach(async () => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  __resetBootstrapStateForTests()
  __resetThrottleStateForTests()
  await rm(dataPath('wallets'), { recursive: true, force: true })
  await rm(dataPath('positions'), { recursive: true, force: true })
})

afterEach(async () => {
  await rm(dataPath('wallets'), { recursive: true, force: true })
  await rm(dataPath('positions'), { recursive: true, force: true })
})

describe('bootstrapWallet — parsing', () => {
  it('parses a pump.fun buy transaction into a trade (still open, no sell found)', async () => {
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method, params } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sigBuy', blockTime: 1000 }])
      if (method === 'getTransaction') {
        const sig = params[0]
        if (sig === 'sigBuy') return jsonRpcResponse(buyTx(1000))
      }
      throw new Error(`unexpected ${method}`)
    })

    const history = await bootstrapWallet(WALLET)

    expect(history.trades).toHaveLength(1)
    expect(history.trades[0]!.mintAddress).toBe(MINT)
    expect(history.trades[0]!.stillOpen).toBe(true)
    expect(history.trades[0]!.buyPriceSol).toBeCloseTo(0.001, 6) // 1 SOL / 1000 tokens
  })

  it('ignores a transaction from a program other than pump.fun — not parsed as a buy', async () => {
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method, params } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sigOther', blockTime: 1000 }])
      if (method === 'getTransaction' && params[0] === 'sigOther') return jsonRpcResponse(nonPumpTx(1000))
      throw new Error(`unexpected ${method}`)
    })

    const history = await bootstrapWallet(WALLET)

    expect(history.trades).toHaveLength(0)
  })

  it('finds the matching sell and computes returnPct, marking the trade closed', async () => {
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method, params } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') {
        return jsonRpcResponse([{ signature: 'sigBuy', blockTime: 1000 }, { signature: 'sigSell', blockTime: 1060 }])
      }
      if (method === 'getTransaction') {
        if (params[0] === 'sigBuy') return jsonRpcResponse(buyTx(1000, MINT, 1, 1000)) // buyPriceSol=0.001
        if (params[0] === 'sigSell') return jsonRpcResponse(sellTx(1060, MINT, 1000, 0.5)) // sellPriceSol=0.0005
      }
      throw new Error(`unexpected ${method}`)
    })

    const history = await bootstrapWallet(WALLET)

    expect(history.trades).toHaveLength(1)
    const trade = history.trades[0]!
    expect(trade.stillOpen).toBe(false)
    expect(trade.returnPct).toBeCloseTo(-50, 5) // 0.0005 vs 0.001 buy price
    expect(history.computedStats.totalTrades).toBe(1)
    expect(history.computedStats.winRate).toBe(0)
  })

  it('a wallet with 0 pump.fun trades is excluded from meaningful stats (totalTrades=0, winRate=0)', async () => {
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method, params } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sigOther', blockTime: 1000 }])
      if (method === 'getTransaction' && params[0] === 'sigOther') return jsonRpcResponse(nonPumpTx(1000))
      throw new Error(`unexpected ${method}`)
    })

    const history = await bootstrapWallet(WALLET)

    expect(history.trades).toHaveLength(0)
    expect(history.computedStats.totalTrades).toBe(0)
    expect(history.computedStats.winRate).toBe(0)
  })

  it('never throws when every RPC call fails — returns an empty, zero-stat history', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const history = await bootstrapWallet(WALLET)

    expect(history.trades).toHaveLength(0)
    expect(history.computedStats.totalTrades).toBe(0)
  })
})

describe('collectSeedWallets', () => {
  it('collects unique buyerWallets from winning trades only, across every closed-positions file', async () => {
    await mkdir(dataPath('positions', 'closed'), { recursive: true })
    await writeFile(dataPath('positions', 'closed', '2026-07-01.jsonl'), [
      JSON.stringify({ returnPct: 20, buyerWallets: ['walletA', 'walletB'] }),
      JSON.stringify({ returnPct: -30, buyerWallets: ['walletRug'] }), // losing trade — excluded
    ].join('\n'))
    await writeFile(dataPath('positions', 'closed', '2026-07-02.jsonl'), [
      JSON.stringify({ returnPct: 50, buyerWallets: ['walletB', 'walletC'] }), // walletB repeated -> dedup
      JSON.stringify({ returnPct: 10, buyerWallets: [] }), // empty -> nothing added
    ].join('\n'))

    const seeds = await collectSeedWallets()

    expect(new Set(seeds)).toEqual(new Set(['walletA', 'walletB', 'walletC']))
    expect(seeds).not.toContain('walletRug')
  })

  it('returns [] when no closed-positions directory exists yet', async () => {
    const seeds = await collectSeedWallets()
    expect(seeds).toEqual([])
  })
})

describe('runBootstrap — checkpoint/resume', () => {
  it('a re-run skips wallets already recorded in bootstrap-progress.json', async () => {
    await mkdir(dataPath('positions', 'closed'), { recursive: true })
    await writeFile(dataPath('positions', 'closed', '2026-07-01.jsonl'), [
      JSON.stringify({ returnPct: 20, buyerWallets: ['walletAlready', 'walletNew'] }),
    ].join('\n'))
    await mkdir(dataPath('wallets'), { recursive: true })
    await writeFile(dataPath('wallets', 'bootstrap-progress.json'), JSON.stringify({ processedAddresses: ['walletAlready'], startedAt: Date.now() }))

    const calledFor = new Set<string>()
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method, params } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') {
        calledFor.add(params[0] as string)
        return jsonRpcResponse([])
      }
      throw new Error(`unexpected ${method}`)
    })

    await runBootstrap({ maxWallets: 500 })

    expect(calledFor.has('walletAlready')).toBe(false) // already in progress file — never re-queried
    expect(calledFor.has('walletNew')).toBe(true)
  })

  it('writes data/wallets/bootstrapped.json separately from tracked.json, with qualifiedWallets filtered by winRate>0.6 and trades>=5', async () => {
    await mkdir(dataPath('positions', 'closed'), { recursive: true })
    await writeFile(dataPath('positions', 'closed', '2026-07-01.jsonl'), JSON.stringify({ returnPct: 20, buyerWallets: [WALLET] }))

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method, params } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sigBuy', blockTime: 1000 }])
      if (method === 'getTransaction' && params[0] === 'sigBuy') return jsonRpcResponse(buyTx(1000))
      throw new Error(`unexpected ${method}`)
    })

    await runBootstrap({ maxWallets: 500 })

    const raw = JSON.parse(await readFile(dataPath('wallets', 'bootstrapped.json'), 'utf-8'))
    expect(raw.allWallets).toHaveLength(1)
    expect(raw.qualifiedWallets).toHaveLength(0) // stillOpen trade, no closed trade -> totalTrades=0, not qualified
    await expect(readFile(dataPath('wallets', 'tracked.json'), 'utf-8')).rejects.toThrow() // never touches tracked.json
  })
})

describe('getBootstrappedSignals', () => {
  it('returns [] when bootstrapped.json does not exist yet, without throwing', async () => {
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      if (method === 'getTransaction') return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }] } } })
      throw new Error(`unexpected ${method}`)
    })

    const signals = await getBootstrappedSignals(MINT)

    expect(signals).toEqual([])
  })

  it('returns a qualified wallet that is among the token\'s recent buyers', async () => {
    await mkdir(dataPath('wallets'), { recursive: true })
    await writeFile(dataPath('wallets', 'bootstrapped.json'), JSON.stringify({
      bootstrappedAt: Date.now(),
      walletCount: 1,
      qualifiedWallets: [],
      allWallets: [{
        walletAddress: WALLET,
        trades: [],
        computedStats: { totalTrades: 6, winRate: 0.7, avgReturn: 55, lastActiveAt: Date.now() },
      }],
    }))

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      if (method === 'getTransaction') return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }] } } })
      throw new Error(`unexpected ${method}`)
    })

    const signals = await getBootstrappedSignals(MINT)

    expect(signals).toEqual([{ walletAddress: WALLET, winRate: 0.7, totalTrades: 6 }])
  })

  it('excludes a wallet below the qualification threshold even if it is a recent buyer', async () => {
    await mkdir(dataPath('wallets'), { recursive: true })
    await writeFile(dataPath('wallets', 'bootstrapped.json'), JSON.stringify({
      bootstrappedAt: Date.now(),
      walletCount: 1,
      qualifiedWallets: [],
      allWallets: [{
        walletAddress: WALLET,
        trades: [],
        computedStats: { totalTrades: 2, winRate: 1.0, avgReturn: 55, lastActiveAt: Date.now() }, // trades<5 -> not qualified
      }],
    }))

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      if (method === 'getTransaction') return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }] } } })
      throw new Error(`unexpected ${method}`)
    })

    const signals = await getBootstrappedSignals(MINT)

    expect(signals).toEqual([])
  })

  it('finds a qualified wallet sourced ONLY from external-wallets.json (bootstrapped.json absent)', async () => {
    const EXTERNAL_WALLET = 'ExternalWallet1111111111111111111111111111'
    await mkdir(dataPath('wallets'), { recursive: true })
    await writeFile(dataPath('wallets', 'external-wallets.json'), JSON.stringify({
      source: 'gmgn',
      fetchedAt: Date.now(),
      qualifiedWallets: [{ walletAddress: EXTERNAL_WALLET, winRate: 0.72, totalTrades: 45, avgReturn: 23.4, source: 'gmgn_7d' }],
    }))

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      if (method === 'getTransaction') return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: EXTERNAL_WALLET, signer: true }] } } })
      throw new Error(`unexpected ${method}`)
    })

    const signals = await getBootstrappedSignals(MINT)

    expect(signals).toEqual([{ walletAddress: EXTERNAL_WALLET, winRate: 0.72, totalTrades: 45 }])
  })

  it('prefers our own bootstrapped.json stats over external-wallets.json for the same address', async () => {
    await mkdir(dataPath('wallets'), { recursive: true })
    await writeFile(dataPath('wallets', 'bootstrapped.json'), JSON.stringify({
      bootstrappedAt: Date.now(),
      walletCount: 1,
      qualifiedWallets: [],
      allWallets: [{ walletAddress: WALLET, trades: [], computedStats: { totalTrades: 6, winRate: 0.9, avgReturn: 55, lastActiveAt: Date.now() } }],
    }))
    await writeFile(dataPath('wallets', 'external-wallets.json'), JSON.stringify({
      source: 'gmgn',
      fetchedAt: Date.now(),
      qualifiedWallets: [{ walletAddress: WALLET, winRate: 0.61, totalTrades: 20, avgReturn: 5, source: 'gmgn_7d' }],
    }))

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = await bodyOf(init)
      if (method === 'getSignaturesForAddress') return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      if (method === 'getTransaction') return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }] } } })
      throw new Error(`unexpected ${method}`)
    })

    const signals = await getBootstrappedSignals(MINT)

    expect(signals).toEqual([{ walletAddress: WALLET, winRate: 0.9, totalTrades: 6 }]) // our own 0.9/6, not external's 0.61/20
  })
})
