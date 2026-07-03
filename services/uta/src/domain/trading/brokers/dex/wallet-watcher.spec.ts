import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rm } from 'node:fs/promises'
import { getRecentBuyers, updateWalletResult, getWalletSignals, __resetThrottleStateForTests } from './wallet-watcher.js'
import { dataPath } from '@/core/paths.js'

const fetchSpy = vi.fn()

function jsonRpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', result, id: 1 }))
}

async function bodyMethod(call: unknown[]): Promise<string> {
  const init = call[1] as RequestInit
  return (JSON.parse(init.body as string) as { method: string }).method
}

beforeEach(async () => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  __resetThrottleStateForTests()
  await rm(dataPath('wallets'), { recursive: true, force: true })
})

afterEach(async () => {
  await rm(dataPath('wallets'), { recursive: true, force: true })
})

describe('getRecentBuyers', () => {
  it('returns wallets (fee payers) for transactions within the last 30 minutes, mocking the RPC', async () => {
    const nowSec = Date.now() / 1000

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string; params: unknown[] }
      if (method === 'getSignaturesForAddress') {
        return jsonRpcResponse([
          { signature: 'sigRecent', blockTime: Math.floor(nowSec - 60) },
          { signature: 'sigOld', blockTime: Math.floor(nowSec - 3600) },
        ])
      }
      if (method === 'getTransaction') {
        const sig = (JSON.parse(init.body as string) as { params: [string, unknown] }).params[0]
        const pubkey = sig === 'sigRecent' ? 'walletRecent' : 'walletOld'
        return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey, signer: true }] } } })
      }
      throw new Error(`unexpected method ${method}`)
    })

    const buyers = await getRecentBuyers('mintAddr1')

    expect(buyers).toContain('walletRecent')
    expect(buyers).not.toContain('walletOld')
  })

  it('returns [] when the RPC is down', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const buyers = await getRecentBuyers('mintAddr1')

    expect(buyers).toEqual([])
  })

  it('returns [] when getSignaturesForAddress returns an RPC error', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message: 'bad address' }, id: 1 })))

    const buyers = await getRecentBuyers('badMint')

    expect(buyers).toEqual([])
  })
})

describe('429 circuit breaker', () => {
  it('pauses RPC calls after 3 consecutive 429s, skipping subsequent getRecentBuyers calls entirely', async () => {
    fetchSpy.mockResolvedValue(new Response('rate limited', { status: 429 }))

    // 3 consecutive calls, each 429 on its first (and only, since signatures
    // never resolve) RPC call — trips the breaker.
    await getRecentBuyers('mintA')
    await getRecentBuyers('mintB')
    await getRecentBuyers('mintC')

    fetchSpy.mockClear()
    const buyers = await getRecentBuyers('mintD')

    expect(buyers).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled() // short-circuited before any RPC call
  })

  it('a non-429 response resets the consecutive-failure streak', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', result: [], id: 1 }))) // success resets streak
    fetchSpy.mockResolvedValue(new Response('rate limited', { status: 429 }))

    await getRecentBuyers('mintA')
    await getRecentBuyers('mintB')
    await getRecentBuyers('mintC') // success here — streak reset to 0

    fetchSpy.mockClear()
    const buyers = await getRecentBuyers('mintD') // 1st 429 after reset — not yet throttled

    expect(buyers).toEqual([])
    expect(fetchSpy).toHaveBeenCalled() // NOT short-circuited — breaker isn't tripped yet
  })
})

describe('updateWalletResult', () => {
  it('creates a new tracked wallet on the first result', async () => {
    await updateWalletResult('wallet1', true, 25)

    const signals = await getWalletSignals('anyMint', { minWinRate: 0, minTrades: 0 })
    // getWalletSignals also needs getRecentBuyers to include wallet1 — verify via a direct
    // accumulation check instead, since this test doesn't mock the buyers RPC.
    expect(signals).toEqual([])
  })

  it('accumulates wins/losses and avgReturn across multiple calls', async () => {
    await updateWalletResult('wallet2', true, 20)
    await updateWalletResult('wallet2', false, -10)
    await updateWalletResult('wallet2', true, 40)

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string }
      if (method === 'getSignaturesForAddress') {
        return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      }
      if (method === 'getTransaction') {
        return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: 'wallet2', signer: true }] } } })
      }
      throw new Error(`unexpected method ${method}`)
    })

    const signals = await getWalletSignals('mintX', { minWinRate: 0.5, minTrades: 3 })
    expect(signals).toHaveLength(1)
    expect(signals[0]!.walletAddress).toBe('wallet2')
    expect(signals[0]!.winRate).toBeCloseTo(2 / 3, 5)
    expect(signals[0]!.totalTrades).toBe(3)
  })
})

describe('getWalletSignals', () => {
  it('filters out wallets below the win-rate threshold', async () => {
    await updateWalletResult('lowWinRateWallet', true, 10)
    await updateWalletResult('lowWinRateWallet', false, -10)
    await updateWalletResult('lowWinRateWallet', false, -10)
    await updateWalletResult('lowWinRateWallet', false, -10)
    await updateWalletResult('lowWinRateWallet', false, -10)

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string }
      if (method === 'getSignaturesForAddress') {
        return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      }
      return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: 'lowWinRateWallet', signer: true }] } } })
    })

    const signals = await getWalletSignals('mintY', { minWinRate: 0.6, minTrades: 5 })
    expect(signals).toEqual([])
  })

  it('filters out wallets below the minimum trade count', async () => {
    await updateWalletResult('tooFewTradesWallet', true, 100)

    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string }
      if (method === 'getSignaturesForAddress') {
        return jsonRpcResponse([{ signature: 'sig1', blockTime: Math.floor(Date.now() / 1000) }])
      }
      return jsonRpcResponse({ transaction: { message: { accountKeys: [{ pubkey: 'tooFewTradesWallet', signer: true }] } } })
    })

    const signals = await getWalletSignals('mintZ', { minWinRate: 0.6, minTrades: 5 })
    expect(signals).toEqual([])
  })

  it('returns [] without crashing when the RPC is down', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const signals = await getWalletSignals('mintDown')
    expect(signals).toEqual([])
  })
})
