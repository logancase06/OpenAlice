/**
 * Anti-scam check for DEX meme-coin buys via the public GoPlus Security API
 * (no API key required). `checkTokenSecurity` is exported standalone (not
 * just as a guard method) so other callers — e.g. a future retro/backtest
 * tool — can run the exact same check without going through the guard
 * pipeline (which needs a live broker/account context they won't have).
 *
 * Fail-safe: any network/timeout/parse error rejects (`passed: false`) —
 * "in doubt, don't buy", same convention as the Python memecoin-bot's
 * `security.py`.
 */
import type { OperationGuard, GuardContext } from './types.js'
import { fetchDexScreenerTokenPairs, bestPair } from '../brokers/dex/dex-market-data.js'

const REQUEST_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 5 * 60_000

const GOPLUS_EVM_CHAIN_IDS: Record<string, string> = {
  ethereum: '1',
  bsc: '56',
  base: '8453',
}

export interface TokenSecurityConfig {
  rejectIfHoneypot?: boolean
  rejectIfMintable?: boolean
  rejectIfOwnerCanBlacklist?: boolean
  rejectIfHighTax?: boolean
  maxBuyTaxPercent?: number
  maxSellTaxPercent?: number
  minHolderCount?: number
  maxTop10HolderPercent?: number
  rejectIfLiquidityUnlocked?: boolean
  /**
   * Minimum pool liquidity (USD) required to buy — sourced from DexScreener,
   * not GoPlus (liquidity depth isn't a GoPlus field). Particularly load-
   * bearing on Solana: `rejectIfLiquidityUnlocked` is not enforced there
   * (see the comment in `checkSolana`), so this is the only remaining
   * defense against a thin, easily-manipulated/rugged pool on that chain.
   * Unset ⇒ check skipped (same "presence enables the check" convention as
   * `minHolderCount`/`maxTop10HolderPercent`). Inclusive: liquidity exactly
   * equal to the threshold passes.
   */
  minLiquidityUsd?: number
}

export interface TokenSecurityResult {
  passed: boolean
  reasons: string[]
}

function flagTrue(value: unknown): boolean {
  if (value && typeof value === 'object' && 'status' in value) {
    return flagTrue((value as { status: unknown }).status)
  }
  return String(value) === '1'
}

function safeFloat(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

async function fetchGoPlusData(chain: string, tokenAddress: string): Promise<Record<string, unknown> | null> {
  const goPlusChainId = chain === 'solana' ? 'solana' : GOPLUS_EVM_CHAIN_IDS[chain]
  if (!goPlusChainId) {
    console.warn(`TokenSecurityGuard: unsupported chain "${chain}" for ${tokenAddress}`)
    return null
  }
  const url = chain === 'solana'
    ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${tokenAddress}`
    : `https://api.gopluslabs.io/api/v1/token_security/${goPlusChainId}?contract_addresses=${tokenAddress}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) {
      console.warn(`TokenSecurityGuard: GoPlus HTTP ${resp.status} for ${chain}:${tokenAddress}`)
      return null
    }
    const payload = await resp.json() as { code?: number; message?: string; result?: Record<string, unknown> }
    if (payload.code !== 1) {
      console.warn(`TokenSecurityGuard: GoPlus error for ${chain}:${tokenAddress} — ${payload.message ?? `code ${payload.code}`}`)
      return null
    }
    const result = payload.result ?? {}
    const data = result[tokenAddress] ?? result[tokenAddress.toLowerCase()]
    if (data) return data as Record<string, unknown>
    const values = Object.values(result)
    return (values[0] as Record<string, unknown>) ?? null
  } catch (err) {
    console.warn(`TokenSecurityGuard: GoPlus request failed for ${chain}:${tokenAddress} — ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function checkEvm(data: Record<string, unknown>, cfg: TokenSecurityConfig): string[] {
  const reasons: string[] = []

  if (cfg.rejectIfHoneypot && flagTrue(data.is_honeypot)) {
    reasons.push('Honeypot detected (cannot sell)')
  }
  if (cfg.rejectIfMintable && flagTrue(data.is_mintable)) {
    reasons.push('Token is mintable (creator can mint unlimited supply)')
  }
  if (cfg.rejectIfOwnerCanBlacklist && (flagTrue(data.is_blacklisted) || flagTrue(data.transfer_pausable))) {
    reasons.push('Owner can blacklist/pause transfers')
  }
  if (cfg.rejectIfHighTax) {
    const buyTax = safeFloat(data.buy_tax) * 100
    const sellTax = safeFloat(data.sell_tax) * 100
    const maxBuy = cfg.maxBuyTaxPercent ?? 10
    const maxSell = cfg.maxSellTaxPercent ?? 10
    if (buyTax > maxBuy) reasons.push(`Buy tax too high: ${buyTax.toFixed(1)}% > ${maxBuy}%`)
    if (sellTax > maxSell) reasons.push(`Sell tax too high: ${sellTax.toFixed(1)}% > ${maxSell}%`)
  }
  if (cfg.minHolderCount != null) {
    const holderCount = Math.trunc(safeFloat(data.holder_count))
    if (holderCount < cfg.minHolderCount) {
      reasons.push(`Too few holders: ${holderCount} < ${cfg.minHolderCount}`)
    }
  }
  if (cfg.maxTop10HolderPercent != null) {
    const holders = (data.holders as Array<{ percent?: unknown }> | undefined) ?? []
    const top10Percent = holders.slice(0, 10).reduce((sum, h) => sum + safeFloat(h.percent), 0) * 100
    if (top10Percent > cfg.maxTop10HolderPercent) {
      reasons.push(`Top-10 holder concentration too high: ${top10Percent.toFixed(1)}% > ${cfg.maxTop10HolderPercent}%`)
    }
  }
  if (cfg.rejectIfLiquidityUnlocked) {
    const lpHolders = (data.lp_holders as Array<{ percent?: unknown; is_locked?: unknown }> | undefined) ?? []
    const lockedPercent = lpHolders
      .filter(h => flagTrue(h.is_locked))
      .reduce((sum, h) => sum + safeFloat(h.percent), 0) * 100
    if (lpHolders.length === 0 || lockedPercent < 50) {
      reasons.push(`Liquidity unlocked or insufficient (${lockedPercent.toFixed(1)}% locked)`)
    }
  }

  return reasons
}

function checkSolana(data: Record<string, unknown>, cfg: TokenSecurityConfig): string[] {
  const reasons: string[] = []

  if (cfg.rejectIfMintable && flagTrue(data.mintable)) {
    reasons.push('Token is mintable (mint authority still active)')
  }
  if (cfg.rejectIfOwnerCanBlacklist && flagTrue(data.freezable)) {
    reasons.push('Freeze authority active (accounts can be frozen)')
  }
  // GoPlus Solana doesn't always surface honeypot/tax fields — only check
  // when present, never treat absence as a pass.
  if (cfg.rejectIfHoneypot && 'is_honeypot' in data && flagTrue(data.is_honeypot)) {
    reasons.push('Honeypot detected (cannot sell)')
  }
  if (cfg.maxTop10HolderPercent != null) {
    let top10Percent: number
    if (data.top10_holder_rate != null) {
      top10Percent = safeFloat(data.top10_holder_rate) * 100
    } else {
      const holders = (data.holders as Array<{ percent?: unknown }> | undefined) ?? []
      top10Percent = holders.slice(0, 10).reduce((sum, h) => sum + safeFloat(h.percent), 0) * 100
    }
    if (top10Percent > cfg.maxTop10HolderPercent) {
      reasons.push(`Top-10 holder concentration too high: ${top10Percent.toFixed(1)}% > ${cfg.maxTop10HolderPercent}%`)
    }
  }
  // `rejectIfLiquidityUnlocked` is intentionally NOT enforced for Solana.
  // GoPlus's Solana schema has no `lp_holders` data (always empty) and its
  // `dex[].burn_percent` doesn't mean what it means on EVM: modern Solana
  // pools (Raydium CLMM, Orca Whirlpools) manage liquidity via concentrated
  // positions, not burnable constant-product LP tokens, so legitimate,
  // widely-held tokens routinely show `burn_percent` near 0 on their top
  // pool — verified live against BONK, which is not a scam. Enforcing this
  // threshold would reject good tokens on a signal that isn't meaningful
  // for how these pools work, without reliably catching bad ones either.

  return reasons
}

/**
 * Pool liquidity (USD) for the token's best-liquidity pair, from DexScreener
 * — reuses the same `fetchDexScreenerTokenPairs`/`bestPair` helpers
 * `DexBroker.getQuote`/`getContractDetails` already call, rather than adding
 * a second integration for the same data. No pair found / no liquidity
 * field ⇒ treated as 0 (fail-safe: unknown liquidity never passes a
 * minimum-liquidity check).
 */
async function fetchLiquidityUsd(chain: string, tokenAddress: string): Promise<number> {
  const pairs = await fetchDexScreenerTokenPairs(chain, tokenAddress)
  return bestPair(pairs)?.liquidity?.usd ?? 0
}

/**
 * Check a token via GoPlus Security (honeypot/mint/freeze/tax/holders) plus
 * a DexScreener liquidity floor, against the configured thresholds.
 * Fail-safe: any API/network error or unknown token → `passed: false`.
 */
export async function checkTokenSecurity(
  chain: string,
  tokenAddress: string,
  config: TokenSecurityConfig,
): Promise<TokenSecurityResult> {
  const reasons: string[] = []

  if (config.minLiquidityUsd != null) {
    const liquidityUsd = await fetchLiquidityUsd(chain, tokenAddress)
    if (liquidityUsd < config.minLiquidityUsd) {
      reasons.push(`Liquidity $${liquidityUsd.toFixed(0)} below minimum $${config.minLiquidityUsd}`)
    }
  }

  const data = await fetchGoPlusData(chain, tokenAddress)
  if (!data) {
    reasons.push('Could not verify token security (GoPlus API unavailable or unknown token)')
    return { passed: false, reasons }
  }

  reasons.push(...(chain === 'solana' ? checkSolana(data, config) : checkEvm(data, config)))
  return { passed: reasons.length === 0, reasons }
}

interface CacheEntry {
  result: TokenSecurityResult
  expiresAt: number
}

/**
 * Guards buy-side `placeOrder` operations with `checkTokenSecurity`. Caches
 * a passing/failing verdict per `chain:tokenAddress` for a few minutes so a
 * position already validated this session doesn't re-hit GoPlus on every
 * cycle (same spirit as `CooldownGuard`'s in-memory `Map` state).
 */
export class TokenSecurityGuard implements OperationGuard {
  readonly name = 'token-security'
  private config: TokenSecurityConfig
  private cache = new Map<string, CacheEntry>()

  constructor(options: Record<string, unknown>) {
    this.config = options as TokenSecurityConfig
  }

  async check(ctx: GuardContext): Promise<string | null> {
    if (ctx.operation.action !== 'placeOrder') return null
    if (ctx.operation.order.action?.toUpperCase() !== 'BUY') return null

    const contract = ctx.operation.contract
    const chain = contract.exchange
    const tokenAddress = contract.localSymbol || contract.symbol
    if (!chain || !tokenAddress) return null

    const cacheKey = `${chain}:${tokenAddress}`
    const cached = this.cache.get(cacheKey)
    const result = cached && cached.expiresAt > Date.now()
      ? cached.result
      : await checkTokenSecurity(chain, tokenAddress, this.config)

    this.cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS })

    return result.passed ? null : `Token security check failed: ${result.reasons.join('; ')}`
  }
}
