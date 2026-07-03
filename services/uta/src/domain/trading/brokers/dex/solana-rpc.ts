/**
 * Solana RPC integration — read-only mint/freeze authority check via raw
 * JSON-RPC HTTP (no `@solana/web3.js`), matching Phase A's decision to avoid
 * a chain-SDK dependency for read-only checks. Fills the gap GoPlus leaves
 * for tokens it hasn't indexed yet (<2-6h old): mint/freeze authority is a
 * plain field on an SPL token's mint account, readable without GoPlus.
 *
 * Response shapes verified live against api.mainnet-beta.solana.com before
 * writing this file — four distinct cases exist, not just the "happy path"
 * a naive read of the RPC docs suggests:
 *   1. Real mint account: `result.value.data.parsed.info.{mintAuthority,...}`.
 *   2. A valid account that ISN'T a mint (e.g. a program account): confirmed
 *      live against the System Program address — `result.value.data` is a
 *      raw `[base64, "base64"]` tuple, no `.parsed` at all.
 *   3. Syntactically valid but non-existent account: confirmed live against
 *      a freshly-generated random pubkey — `result.value` is `null`, no
 *      `error` field; the RPC answered fine, there's just nothing there.
 *   4. Malformed/wrong-size address: confirmed live — no `result` at all,
 *      only `error: {code, message}`.
 * Cases 2 and 3 are treated as "not a usable mint" -> fail-safe reject, with
 * `rpcAvailable: true` (the RPC answered; the address just isn't a real
 * mint). Case 4 is also `rpcAvailable: true` for the same reason — the
 * endpoint is up and responding, our query was just rejected. Only genuine
 * network-level failures (timeout, non-2xx HTTP, unparseable body,
 * connection error) set `rpcAvailable: false`, which is the one condition
 * `TokenSecurityGuard` treats as "skip this check" rather than "reject."
 */

import { withRpcSlot } from './rpc-concurrency.js'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_RETRIES = 2
const RETRY_DELAY_MS = 1000
// Mint/freeze authority essentially never changes once set — 10min was
// overly conservative and drove needless repeat RPC traffic under Helius
// rate limits. 60min cuts that traffic ~6x with no real staleness risk.
const CACHE_TTL_MS = 60 * 60_000

/**
 * Public mainnet-beta rate-limits this module's call volume into the ground
 * (confirmed live: continuous HTTP 429 during a real scan run). `HELIUS_API_KEY`
 * routes to a dedicated Helius RPC instead — read at call time, not module
 * load, so a config change doesn't need a process restart to take effect.
 */
export function defaultSolanaRpcEndpoint(): string {
  const key = process.env['HELIUS_API_KEY']
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com'
}

export interface MintAuthorityCheck {
  hasMintAuthority: boolean
  hasFreezeAuthority: boolean
  decimals: number
  /** Raw token supply as a string (smallest unit, no decimals applied) — avoids bigint/JSON round-trip issues. */
  supply: string
  mintAddress: string
  fromCache: boolean
  /** False only for network-level failures (timeout, HTTP error, unparseable body) — see file header. */
  rpcAvailable: boolean
}

export interface SolanaRpcConfig {
  endpoint: string
  timeoutMs?: number
  maxRetries?: number
}

interface CacheEntry {
  result: MintAuthorityCheck
  expiresAt: number
}

const CACHE_PURGE_INTERVAL_MS = 5 * 60_000
// A scanner touches hundreds of unique mint addresses a day, the
// overwhelming majority never queried again — without a cap this cache
// otherwise grows forever across a multi-day "leave it running overnight"
// session (see solana-rpc.spec.ts).
const MAX_CACHE_SIZE = 500

const cache = new Map<string, CacheEntry>()

function purgeExpiredCacheEntries(): void {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key)
  }
}

/** Map preserves insertion order, and every entry uses the same TTL, so the first key iterated is also the oldest — no separate last-accessed timestamp needed for a FIFO/oldest-first eviction. */
function setCached(mintAddress: string, result: MintAuthorityCheck): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    purgeExpiredCacheEntries()
    while (cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }
  cache.set(mintAddress, { result, expiresAt: Date.now() + CACHE_TTL_MS })
}

// Unref'd — a periodic purge timer must never keep the process alive on its
// own, same convention as dex-price-feed.ts's DexPriceFeed timer.
const purgeTimer = setInterval(purgeExpiredCacheEntries, CACHE_PURGE_INTERVAL_MS)
purgeTimer.unref?.()

/** Test-only — lets specs force a deterministic purge/eviction instead of waiting on the real interval. */
export function __purgeExpiredCacheEntriesForTests(): void {
  purgeExpiredCacheEntries()
}

/** Test-only — resets module-level cache state between specs. */
export function __resetCacheForTests(): void {
  cache.clear()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `defaultSolanaRpcEndpoint()` embeds HELIUS_API_KEY directly in the
 * request URL — no log line here ever prints that URL, but some fetch
 * failure messages (DNS/connection errors) can include the request URL
 * verbatim depending on the runtime, and every error message in this file
 * flows through a console.warn/error. Strip the key defensively rather than
 * audit every current and future call site for whether it happens to be
 * one of those cases.
 */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const apiKey = process.env['HELIUS_API_KEY']
  return apiKey && msg.includes(apiKey) ? msg.replaceAll(apiKey, '***REDACTED***') : msg
}

function failSafeResult(mintAddress: string, rpcAvailable: boolean): MintAuthorityCheck {
  return {
    hasMintAuthority: true,
    hasFreezeAuthority: true,
    decimals: 0,
    supply: '0',
    mintAddress,
    fromCache: false,
    rpcAvailable,
  }
}

interface ParsedMintInfo {
  mintAuthority: string | null
  freezeAuthority: string | null
  decimals: number
  supply: string
}

type AccountInfoValue = { data?: { parsed?: { type?: string; info?: ParsedMintInfo } } } | null

type RpcCallResult =
  | { kind: 'value'; value: AccountInfoValue }
  | { kind: 'rpc-error'; message: string }
  | { kind: 'network-error'; message: string }

async function fetchAccountInfoOnce(endpoint: string, mintAddress: string, timeoutMs: number): Promise<RpcCallResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mintAddress, { encoding: 'jsonParsed' }],
      }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      return { kind: 'network-error', message: `HTTP ${resp.status}` }
    }

    let payload: { result?: { value: unknown }; error?: { code: number; message: string } }
    try {
      payload = await resp.json()
    } catch (err) {
      return { kind: 'network-error', message: `Malformed JSON response: ${sanitizeError(err)}` }
    }

    if (payload.error) {
      // The RPC answered — this is a query-level rejection (bad address
      // format, etc.), not a network failure. Not worth retrying.
      return { kind: 'rpc-error', message: `RPC error ${payload.error.code}: ${payload.error.message}` }
    }
    return { kind: 'value', value: (payload.result?.value as AccountInfoValue) ?? null }
  } catch (err) {
    return { kind: 'network-error', message: sanitizeError(err) }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Check an SPL token mint's mint/freeze authority via raw JSON-RPC HTTP.
 * Retries only on network-level failures (an RPC-level rejection like a
 * malformed address is deterministic — retrying won't change the answer).
 * Fail-safe on any unresolved case: `hasMintAuthority`/`hasFreezeAuthority`
 * both default to `true` (dangerous) rather than assume safety.
 */
export async function checkMintAuthority(mintAddress: string, config: SolanaRpcConfig): Promise<MintAuthorityCheck> {
  const cached = cache.get(mintAddress)
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, fromCache: true }
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  let lastResult: RpcCallResult = { kind: 'network-error', message: 'no attempt made' }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      lastResult = await withRpcSlot(() => fetchAccountInfoOnce(config.endpoint, mintAddress, timeoutMs))
    } catch (err) {
      // withRpcSlot's acquire() can throw on its own (queue full) before
      // fetchAccountInfoOnce ever runs — folding that into the same
      // 'network-error' kind reuses the existing retry/fail-safe machinery
      // below instead of needing a separate uncaught-throw path.
      lastResult = { kind: 'network-error', message: sanitizeError(err) }
    }
    if (lastResult.kind !== 'network-error') break
    console.warn(`solana-rpc: getAccountInfo(${mintAddress}) attempt ${attempt + 1}/${maxRetries + 1} failed — ${lastResult.message}`)
    if (attempt < maxRetries) await sleep(RETRY_DELAY_MS)
  }

  if (lastResult.kind === 'network-error') {
    console.warn(`solana-rpc: getAccountInfo(${mintAddress}) unavailable after retries — ${lastResult.message}`)
    // Not cached — an outage shouldn't poison the cache for 10 minutes once the RPC recovers.
    return failSafeResult(mintAddress, false)
  }

  if (lastResult.kind === 'rpc-error') {
    console.warn(`solana-rpc: getAccountInfo(${mintAddress}) rejected by RPC — ${lastResult.message}`)
    const result = failSafeResult(mintAddress, true)
    setCached(mintAddress, result)
    return result
  }

  const parsed = lastResult.value?.data?.parsed
  if (!lastResult.value || parsed?.type !== 'mint' || !parsed.info) {
    console.warn(`solana-rpc: ${mintAddress} is not a parseable SPL mint account (value=${lastResult.value === null ? 'null' : 'present, not a mint'})`)
    const result = failSafeResult(mintAddress, true)
    setCached(mintAddress, result)
    return result
  }

  const info = parsed.info
  const result: MintAuthorityCheck = {
    hasMintAuthority: info.mintAuthority != null,
    hasFreezeAuthority: info.freezeAuthority != null,
    decimals: Number(info.decimals ?? 0),
    supply: String(info.supply ?? '0'),
    mintAddress,
    fromCache: false,
    rpcAvailable: true,
  }
  setCached(mintAddress, result)
  return result
}
