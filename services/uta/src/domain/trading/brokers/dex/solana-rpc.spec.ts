import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkMintAuthority, type SolanaRpcConfig } from './solana-rpc.js'

const fetchSpy = vi.fn()
const CONFIG: SolanaRpcConfig = { endpoint: 'https://api.mainnet-beta.solana.com', timeoutMs: 5000, maxRetries: 2 }

function rpcMintResponse(info: { mintAuthority: string | null; freezeAuthority: string | null; decimals?: number; supply?: string }): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    result: {
      context: { slot: 1 },
      value: {
        data: {
          parsed: {
            type: 'mint',
            info: { decimals: info.decimals ?? 6, supply: info.supply ?? '1000000', ...info },
          },
          program: 'spl-token',
        },
        executable: false,
        lamports: 1,
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    },
    id: 1,
  }))
}

beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})

describe('checkMintAuthority', () => {
  it('reports no authority for a mint with both authorities revoked (WSOL-like)', async () => {
    fetchSpy.mockResolvedValue(rpcMintResponse({ mintAuthority: null, freezeAuthority: null }))

    const result = await checkMintAuthority('So11111111111111111111111111111111111111112', CONFIG)

    expect(result.hasMintAuthority).toBe(false)
    expect(result.hasFreezeAuthority).toBe(false)
    expect(result.rpcAvailable).toBe(true)
    expect(result.fromCache).toBe(false)
  })

  it('reports active authorities for a mint that still has them (USDC-like)', async () => {
    fetchSpy.mockResolvedValue(rpcMintResponse({
      mintAuthority: 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG',
      freezeAuthority: '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar',
    }))

    const result = await checkMintAuthority('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', CONFIG)

    expect(result.hasMintAuthority).toBe(true)
    expect(result.hasFreezeAuthority).toBe(true)
  })

  it('parses decimals and supply', async () => {
    fetchSpy.mockResolvedValue(rpcMintResponse({ mintAuthority: null, freezeAuthority: null, decimals: 9, supply: '8486814848094986' }))

    const result = await checkMintAuthority('mintDecimalsTest', CONFIG)

    expect(result.decimals).toBe(9)
    expect(result.supply).toBe('8486814848094986')
  })

  it('fails safe on a network timeout (AbortError)', async () => {
    fetchSpy.mockImplementation(() => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })

    const result = await checkMintAuthority('timeoutMint', { ...CONFIG, maxRetries: 0 })

    expect(result.hasMintAuthority).toBe(true)
    expect(result.hasFreezeAuthority).toBe(true)
    expect(result.rpcAvailable).toBe(false)
  })

  it('fails safe on a malformed (non-JSON) response body', async () => {
    fetchSpy.mockResolvedValue(new Response('not json at all'))

    const result = await checkMintAuthority('malformedMint', { ...CONFIG, maxRetries: 0 })

    expect(result.hasMintAuthority).toBe(true)
    expect(result.hasFreezeAuthority).toBe(true)
    expect(result.rpcAvailable).toBe(false)
  })

  it('fails safe (but rpcAvailable=true) on a valid account that is not a parseable mint', async () => {
    // Real shape confirmed live against the System Program address: `data`
    // is a raw base64 tuple, no `.parsed` at all.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      result: { context: { slot: 1 }, value: { data: ['c29sYW5h', 'base64'], executable: true, lamports: 1, owner: 'NativeLoader1111111111111111111111111111111' } },
      id: 1,
    })))

    const result = await checkMintAuthority('notAMintAccount', CONFIG)

    expect(result.hasMintAuthority).toBe(true)
    expect(result.hasFreezeAuthority).toBe(true)
    expect(result.rpcAvailable).toBe(true) // RPC answered fine — the address just isn't a mint
  })

  it('fails safe (but rpcAvailable=true) on a syntactically valid, non-existent account', async () => {
    // Real shape confirmed live: result.value is null, no error field.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', result: { context: { slot: 1 }, value: null }, id: 1 })))

    const result = await checkMintAuthority('nonExistentMint', CONFIG)

    expect(result.hasMintAuthority).toBe(true)
    expect(result.rpcAvailable).toBe(true)
  })

  it('fails safe (but rpcAvailable=true) on a JSON-RPC error response (malformed address)', async () => {
    // Real shape confirmed live against a garbage address.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message: 'Invalid param: Invalid' }, id: 1 })))

    const result = await checkMintAuthority('badAddressMint', CONFIG)

    expect(result.hasMintAuthority).toBe(true)
    expect(result.rpcAvailable).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // RPC-level errors are deterministic — not retried
  })

  it('caches a result and skips the second network call within the TTL', async () => {
    fetchSpy.mockResolvedValue(rpcMintResponse({ mintAuthority: null, freezeAuthority: null }))

    const first = await checkMintAuthority('cachedMint', CONFIG)
    const second = await checkMintAuthority('cachedMint', CONFIG)

    expect(first.fromCache).toBe(false)
    expect(second.fromCache).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries on a network failure and succeeds on the second attempt', async () => {
    fetchSpy
      .mockImplementationOnce(() => Promise.reject(new Error('ECONNRESET')))
      .mockImplementationOnce(() => Promise.resolve(rpcMintResponse({ mintAuthority: null, freezeAuthority: null })))

    const result = await checkMintAuthority('retrySucceedsMint', CONFIG)

    expect(result.rpcAvailable).toBe(true)
    expect(result.hasMintAuthority).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does not cache a network-failure result — a later call retries fresh', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error('ECONNRESET')))

    const first = await checkMintAuthority('neverCachedMint', { ...CONFIG, maxRetries: 0 })
    expect(first.rpcAvailable).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    fetchSpy.mockResolvedValue(rpcMintResponse({ mintAuthority: null, freezeAuthority: null }))
    const second = await checkMintAuthority('neverCachedMint', { ...CONFIG, maxRetries: 0 })
    expect(second.rpcAvailable).toBe(true)
    expect(second.fromCache).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
