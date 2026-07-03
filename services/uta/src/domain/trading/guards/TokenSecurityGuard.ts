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
import { fetchDexScreenerTokenPairs, bestPair, type DexScreenerPair } from '../brokers/dex/dex-market-data.js'
import { checkMintAuthority, defaultSolanaRpcEndpoint } from '../brokers/dex/solana-rpc.js'
import { getLiquidityGrowth } from '../brokers/dex/liquidity-tracker.js'
import { checkTokenName } from '../brokers/dex/dex-name-filter.js'
import { getWalletSignals } from '../brokers/dex/wallet-watcher.js'
import { getBootstrappedSignals } from '../brokers/dex/wallet-bootstrapper.js'

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
  /**
   * Minimum buy-transaction COUNT in the last hour (DexScreener `txns.h1.buys`)
   * required to buy. This is a transaction-count signal, not a unique-wallet
   * count — DexScreener doesn't expose unique buyers, so a single actor
   * issuing many transactions looks identical to many distinct buyers here.
   * Treat as "is there any real trading activity", not "how distributed is
   * ownership" (that's what `maxTop10HolderPercent` is for, when GoPlus data
   * is available). Unset ⇒ check skipped.
   */
  minBuyTxns1h?: number
  /**
   * Maximum sells:buys ratio over the last hour (DexScreener `txns.h1`)
   * required to buy — a proxy for "sell pressure dominating the last hour."
   * A pool with buys=0 and sells>0 is treated as maximally sell-heavy
   * (fail-safe) rather than passing on a divide-by-zero. Unset ⇒ check
   * skipped.
   */
  maxSellBuyRatio1h?: number
  /**
   * Verify Solana mint/freeze authority via a direct RPC call
   * (`checkMintAuthority`), independent of GoPlus — fills the gap for
   * tokens GoPlus hasn't indexed yet. Solana-only; ignored for EVM chains.
   * Unlike GoPlus unavailability (which always fails safe to reject), RPC
   * unavailability here does NOT block the buy — it's a supplementary
   * check on top of GoPlus, not a replacement, so losing it just means
   * losing the supplement, not losing the ability to trade at all.
   * Unset/false ⇒ check skipped entirely (no RPC call).
   */
  useSolanaRpc?: boolean
  /** Defaults to the public mainnet-beta endpoint if unset. */
  solanaRpcEndpoint?: string
  /**
   * Evaluate `getLiquidityGrowth()` (see `liquidity-tracker.ts`) — detects
   * liquidity draining and sustained sell pressure from locally-recorded
   * snapshot history. This guard only ever READS that history; a separate
   * live scanner (not built yet) is responsible for calling
   * `recordSnapshot()` every poll cycle. Unset/false ⇒ check skipped
   * entirely (no snapshot file read).
   */
  useLiquidityTracker?: boolean
  /** Reject if liquidity dropped more than this percent since the oldest tracked snapshot. Defaults to -20 when `useLiquidityTracker` is on and this is unset. */
  minLiquidityGrowthPct?: number
  /** Reject if sell pressure (1 - buyPressure) exceeds this fraction. Defaults to 0.7 when `useLiquidityTracker` is on and this is unset. */
  maxSellPressure?: number
  /**
   * When there isn't yet enough snapshot history (`hasEnoughSnapshots: false`
   * — fewer than 2 recorded snapshots, e.g. a scanner hasn't been tracking
   * this pool long enough yet), `true` rejects the buy outright; `false`
   * (default) just skips this check and lets the other checks decide.
   */
  requireEnoughSnapshots?: boolean
  /**
   * `false` tolerates GoPlus being *unavailable* (fresh, unindexed token) —
   * it does NOT skip GoPlus in general. GoPlus is still called and, if it
   * responds, its checks (honeypot/mint/tax/holder-concentration) still
   * apply exactly as with `true`. Only when GoPlus fails to answer does
   * this change anything: instead of rejecting outright, the verdict falls
   * back to whatever the other configured checks (`minLiquidityUsd`,
   * `useSolanaRpc`, the txns checks, `useLiquidityTracker`) already
   * decided — those are unaffected by this flag and remain fully
   * mandatory whenever they're configured. Defaults to `true` (unchanged
   * fail-safe behavior: GoPlus unavailable always rejects).
   */
  requireGoPlus?: boolean
  /** Reject on negative short-term price momentum (DexScreener `priceChange.m5`/`h1`). Unset/false ⇒ check skipped entirely. */
  requirePositiveMomentum?: boolean
  /** Minimum 5-minute price change percent required when `requirePositiveMomentum` is on. Defaults to 0. Missing data ⇒ skipped, not rejected. */
  minPriceChangePct5m?: number
  /** Minimum 1-hour price change percent required when `requirePositiveMomentum` is on. Defaults to 0. Missing data ⇒ skipped, not rejected. */
  minPriceChangePct1h?: number
  /**
   * Reject if 1h price change EXCEEDS this — a proxy for "probably already
   * topped out." Independent of `requirePositiveMomentum`: has its own gate
   * (config presence), so a strategy can use this without opting into the
   * min-momentum checks above. Adopted 2026-07-02 from real data: the 5
   * largest crashes in the 2026-07-01/02 dataset had an average entry-time
   * h1 of +183.8%, higher than winners' +104.4% average — buying a token
   * already up huge in the last hour skewed toward crashing, not confirming
   * further upside, in that sample. Unset ⇒ check skipped. Missing data ⇒
   * skipped, not rejected.
   */
  maxPriceChangePct1h?: number
  /** Reject if 1h volume / liquidity is below this ratio — too little real trading activity relative to pool size. Unset ⇒ check skipped. Missing volume/liquidity data ⇒ skipped, not rejected. */
  minVolumeLiquidityRatio1h?: number
  /** Reject if 1h volume / liquidity is above this ratio — a proxy for probable wash trading. Unset ⇒ check skipped. */
  maxVolumeLiquidityRatio1h?: number
  /** Reject if the token's symbol/name heuristic risk score (see `dex-name-filter.ts`) exceeds this value. Unset ⇒ check skipped entirely. */
  maxNameRiskScore?: number
  /**
   * Require at least one tracked wallet with a strong win rate to have
   * recently bought this token (see `wallet-watcher.ts`). Solana-only —
   * ignored on EVM chains. Fails closed like every other check here
   * (unlike `useSolanaRpc`): an empty/unavailable signal rejects, since the
   * whole point of this check is "someone with a track record is buying,"
   * and no signal is indistinguishable from "no one with a track record is
   * buying" at this stage. Unset/false ⇒ check skipped entirely.
   */
  useWalletWatcher?: boolean
  /** Minimum tracked win rate for a wallet to count as a signal. Defaults to 0.6. */
  minWalletWinRate?: number
  /** Minimum tracked trade count for a wallet to count as a signal. Defaults to 5 — a wallet needs some accumulated history before its win rate means anything. */
  minWalletTrades?: number
  /**
   * Require at least this many `wallet-bootstrapper.ts` qualified wallets
   * (real, independently-measured win rate — see that file's header, as
   * opposed to `useWalletWatcher`'s `tracked.json`) among this token's
   * recent buyers. Solana-only. Fails closed like `useWalletWatcher`, same
   * rationale. Unset ⇒ check skipped entirely — this is COPY_WALLET's core
   * gate (see `COPY_WALLET_CONFIG` in `live-scan.ts`), not applied to any
   * other strategy.
   */
  minBootstrappedSignals?: number
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

  // Structural blockers — unconditional (no config flag), same precedent as
  // checkCrashGap: these represent an active mechanism that can prevent
  // selling or drain funds directly, independent of any strategy's risk
  // tolerance, so no strategy should be able to opt out of them. Adopted
  // 2026-07-02: GoPlus responds for pump.fun-origin tokens on this scanner's
  // population only ~3.7% of the time (1/27 sampled), and 0/29 addresses
  // checked across this session ever returned `is_honeypot`/`holders`/
  // `top10_holder_rate` — so gating these behind a config flag the way
  // rejectIfHoneypot/maxTop10HolderPercent are would cost strategies nothing
  // to disable and gain nothing to enable; keeping them unconditional costs
  // nothing in volume (checkSolana only runs on the ~4% of candidates GoPlus
  // answers for at all) and closes a real gap on the rare token where it
  // does respond. Fail-open on absence, same convention as every field
  // above — see the fail-open/fail-closed audit from the same session.
  if (Array.isArray(data.transfer_hook) && data.transfer_hook.length > 0) {
    reasons.push('Transfer hook active — custom program logic can block or redirect transfers')
  }
  if (flagTrue(data.non_transferable)) {
    reasons.push('Token marked non-transferable — cannot be sold under any circumstance')
  }
  if (data.transfer_fee && typeof data.transfer_fee === 'object' && Object.keys(data.transfer_fee as object).length > 0) {
    // Every real GoPlus response sampled this session (n=3) showed
    // `transfer_fee: {}` — this branch has never actually been observed to
    // trigger yet, so its exact shape is inferred from the field name, not
    // confirmed. Logging the raw value the first time it fires in
    // production lets us verify that shape before trusting it further.
    console.log(`TokenSecurityGuard: transfer_fee triggered — raw value: ${JSON.stringify(data.transfer_fee)}`)
    reasons.push('Transfer fee configured — a tax can be levied on sell')
  }
  if (flagTrue(data.balance_mutable_authority)) {
    reasons.push('Balance-mutable authority active — an address can directly alter holder balances')
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
 * The token's best-liquidity DexScreener pair — single fetch point shared by
 * the liquidity, buy-activity, and sell-pressure checks below (reuses the
 * same `fetchDexScreenerTokenPairs`/`bestPair` helpers `DexBroker.getQuote`/
 * `getContractDetails` already call), so configuring more than one of these
 * checks doesn't cost more than one DexScreener request. `null` on no pair
 * found — each check below applies its own fail-safe default for that case.
 */
async function fetchPairSnapshot(chain: string, tokenAddress: string): Promise<DexScreenerPair | null> {
  const pairs = await fetchDexScreenerTokenPairs(chain, tokenAddress)
  return bestPair(pairs)
}

function checkLiquidity(pair: DexScreenerPair | null, cfg: TokenSecurityConfig): string[] {
  if (cfg.minLiquidityUsd == null) return []
  const liquidityUsd = pair?.liquidity?.usd ?? 0
  if (liquidityUsd < cfg.minLiquidityUsd) {
    return [`Liquidity $${liquidityUsd.toFixed(0)} below minimum $${cfg.minLiquidityUsd}`]
  }
  return []
}

function checkTxnActivity(pair: DexScreenerPair | null, cfg: TokenSecurityConfig): string[] {
  const reasons: string[] = []
  const buys = pair?.txns?.h1?.buys ?? 0
  const sells = pair?.txns?.h1?.sells ?? 0

  if (cfg.minBuyTxns1h != null && buys < cfg.minBuyTxns1h) {
    reasons.push(`Insufficient buy activity in the last hour: ${buys} buys < ${cfg.minBuyTxns1h}`)
  }
  if (cfg.maxSellBuyRatio1h != null) {
    // buys=0 with sells>0 is maximally sell-heavy (fail-safe), not a
    // divide-by-zero pass; buys=0 with sells=0 has no signal either way.
    const ratio = buys > 0 ? sells / buys : (sells > 0 ? Infinity : 0)
    if (ratio > cfg.maxSellBuyRatio1h) {
      const ratioStr = Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'
      reasons.push(`Heavy sell pressure in the last hour: ${sells} sells vs ${buys} buys (ratio ${ratioStr} > ${cfg.maxSellBuyRatio1h})`)
    }
  }
  return reasons
}

/** Negative-momentum reject on DexScreener's `priceChange.m5`/`h1`. Missing data on either window is skipped, not rejected — a fresh pair sometimes hasn't got both windows populated yet. */
function checkMomentum(pair: DexScreenerPair | null, cfg: TokenSecurityConfig): string[] {
  if (!cfg.requirePositiveMomentum) return []
  const reasons: string[] = []
  const m5 = pair?.priceChange?.m5
  const h1 = pair?.priceChange?.h1
  const min5 = cfg.minPriceChangePct5m ?? 0
  const min1h = cfg.minPriceChangePct1h ?? 0
  if (m5 != null && m5 < min5) reasons.push(`Negative 5min momentum: ${m5.toFixed(1)}% < ${min5}%`)
  if (h1 != null && h1 < min1h) reasons.push(`Negative 1h momentum: ${h1.toFixed(1)}% < ${min1h}%`)
  return reasons
}

/**
 * Reject on a severe recent price collapse (DexScreener `priceChange.m5`/
 * `h1`) — catches a token crashing faster than the scan interval can react
 * to (confirmed live: a position fell -92% between two 30s-interval
 * checkExits cycles, well past the -20% stop-loss threshold, because the
 * crash happened between polls, not gradually across several of them). No
 * config flag: this is a baseline safety check applied unconditionally for
 * every strategy, not opt-in like `requirePositiveMomentum`. Missing data
 * on either window is skipped, not rejected.
 *
 * Known limitation, confirmed live 2026-07-02 (brokn, cat — both crashed
 * -50%+ within under 90 SECONDS of a passing buy): this check can only see
 * `h1`/`m5` as of THIS candidate's own `fetchPairSnapshot` call inside
 * `checkTokenSecurity` — a fetch entirely independent from (and not reused
 * from) the pair `runCycle` already fetched moments earlier for scan-log's
 * `rawData`, and independent again from the other 1-2 strategies' own
 * `checkTokenSecurity` calls on the same candidate this same cycle. For a
 * token whose price is collapsing THIS fast, none of that staggering is the
 * actual bug — a poll-based check fundamentally cannot reject a crash that
 * hasn't happened yet at evaluation time. The `console.log` below exists to
 * make that "what did this check actually see" moment traceable after the
 * fact, rather than requiring a rawData post-mortem like this one every time.
 */
function checkCrashGap(pair: DexScreenerPair | null): string[] {
  const reasons: string[] = []
  const m5 = pair?.priceChange?.m5
  const h1 = pair?.priceChange?.h1
  console.log(`TokenSecurityGuard: Anti-gap check — h1: ${h1 != null ? h1.toFixed(1) + '%' : 'n/a'}, m5: ${m5 != null ? m5.toFixed(1) + '%' : 'n/a'} (token: ${pair?.baseToken?.symbol ?? 'unknown'})`)
  if (m5 != null && m5 < -30) reasons.push(`Crash detected — token down >30% in last 5min (${m5.toFixed(1)}%)`)
  if (h1 != null && h1 < -50) reasons.push(`Token in freefall — down >50% in last hour (${h1.toFixed(1)}%)`)
  return reasons
}

/**
 * Reject if the token is already up more than `maxPriceChangePct1h` in the
 * last hour — see that config field's docstring. Missing data ⇒ skipped,
 * not rejected.
 *
 * Bypassed when `bootstrappedSignalCount >= 2` — 2+ wallets with real,
 * independently-measured win rate (see `wallet-bootstrapper.ts`, as opposed
 * to `checkWalletSignal`'s `tracked.json`, which measures OUR trade outcome
 * broadcast to co-buyers, not theirs) already bought this token. Adopted
 * 2026-07-02: trusts a proven wallet's own judgment over raw momentum in
 * that specific case, rather than blocking every high-h1 candidate
 * uniformly. In practice this only affects EARLY_STRICT today — plain
 * EARLY doesn't set `maxPriceChangePct1h`, so this check (and its bypass)
 * is a no-op for it either way.
 */
function checkOverextension(pair: DexScreenerPair | null, cfg: TokenSecurityConfig, bootstrappedSignalCount: number): string[] {
  if (cfg.maxPriceChangePct1h == null) return []
  if (bootstrappedSignalCount >= 2) return []
  const h1 = pair?.priceChange?.h1
  if (h1 == null) return []
  if (h1 > cfg.maxPriceChangePct1h) {
    return [`Token likely already topped out — up ${h1.toFixed(1)}% in the last hour (> ${cfg.maxPriceChangePct1h}%)`]
  }
  return []
}

/** Volume/liquidity ratio — too low means little real activity, too high is a wash-trading proxy. Missing volume/liquidity data is skipped, not rejected. */
function checkVolumeLiquidityRatio(pair: DexScreenerPair | null, cfg: TokenSecurityConfig): string[] {
  if (cfg.minVolumeLiquidityRatio1h == null && cfg.maxVolumeLiquidityRatio1h == null) return []
  const volume1h = pair?.volume?.h1
  const liquidityUsd = pair?.liquidity?.usd
  if (volume1h == null || !liquidityUsd) return []

  const ratio = volume1h / liquidityUsd
  const reasons: string[] = []
  if (cfg.minVolumeLiquidityRatio1h != null && ratio < cfg.minVolumeLiquidityRatio1h) {
    reasons.push(`Volume/liquidity ratio too low: ${ratio.toFixed(2)} < ${cfg.minVolumeLiquidityRatio1h} (little real activity)`)
  }
  if (cfg.maxVolumeLiquidityRatio1h != null && ratio > cfg.maxVolumeLiquidityRatio1h) {
    reasons.push(`Volume/liquidity ratio too high: ${ratio.toFixed(2)} > ${cfg.maxVolumeLiquidityRatio1h} (possible wash trading)`)
  }
  return reasons
}

/** Heuristic symbol/name scam-pattern reject (see dex-name-filter.ts). No pair/symbol data ⇒ skipped, not rejected. */
function checkNameFilter(pair: DexScreenerPair | null, cfg: TokenSecurityConfig): string[] {
  if (cfg.maxNameRiskScore == null) return []
  const symbol = pair?.baseToken?.symbol
  if (!symbol) return []
  const result = checkTokenName(symbol, pair?.baseToken?.name ?? symbol)
  if (result.riskScore > cfg.maxNameRiskScore) {
    return [`Suspicious token name/symbol (risk ${result.riskScore} > ${cfg.maxNameRiskScore}): ${result.flags.join(', ')}`]
  }
  return []
}

/**
 * Count of `wallet-bootstrapper.ts` qualified wallets (real, independently-
 * measured win rate — see that file's header) among this token's recent
 * buyers. Only queried when a consumer actually wants it (`maxPriceChangePct1h`'s
 * bypass or `minBootstrappedSignals`'s gate) — avoids a `getRecentBuyers`
 * RPC call for every candidate under strategies that use neither. Solana-only;
 * never throws (`getBootstrappedSignals` already fails safe to `[]`).
 */
async function countBootstrappedSignals(chain: string, tokenAddress: string, cfg: TokenSecurityConfig): Promise<number> {
  if (chain !== 'solana') return 0
  if (cfg.maxPriceChangePct1h == null && cfg.minBootstrappedSignals == null) return 0
  const signals = await getBootstrappedSignals(tokenAddress)
  return signals.length
}

/**
 * COPY_WALLET's core gate: reject unless at least `minBootstrappedSignals`
 * qualified wallets (see `countBootstrappedSignals`) bought this token.
 * Fails closed on "no signal", same rationale as `checkWalletSignal` — the
 * whole point is "wallets with a real track record are buying," so no
 * signal is indistinguishable from "they aren't." Unset ⇒ skipped entirely,
 * so this has zero effect on every strategy except COPY_WALLET.
 */
function checkBootstrappedSignalRequirement(cfg: TokenSecurityConfig, bootstrappedSignalCount: number): string[] {
  if (cfg.minBootstrappedSignals == null) return []
  if (bootstrappedSignalCount < cfg.minBootstrappedSignals) {
    return [`Insufficient qualified-wallet signal — ${bootstrappedSignalCount}/${cfg.minBootstrappedSignals} required (see wallet-bootstrapper.ts)`]
  }
  return []
}

/**
 * Requires at least one tracked high-win-rate wallet among this token's
 * recent buyers (see `wallet-watcher.ts`). Solana-only. Unlike the RPC
 * mint-authority check, this one fails closed on "no signal" — see the
 * `useWalletWatcher` docstring for why.
 */
async function checkWalletSignal(chain: string, tokenAddress: string, cfg: TokenSecurityConfig): Promise<string[]> {
  if (!cfg.useWalletWatcher) return []
  if (chain !== 'solana') return []

  const signals = await getWalletSignals(tokenAddress, {
    minWinRate: cfg.minWalletWinRate ?? 0.6,
    minTrades: cfg.minWalletTrades ?? 5,
  })
  if (signals.length === 0) {
    return ['No tracked high-conviction wallet activity detected']
  }
  return []
}

/**
 * Mint/freeze authority via direct Solana RPC — supplementary to GoPlus, not
 * a replacement: RPC unavailability logs a warning and returns no reasons
 * (doesn't block), unlike every other check in this file which fails safe
 * to reject. This is the one check in `checkTokenSecurity` that behaves
 * this way, by design (see `useSolanaRpc`'s docstring).
 */
async function checkSolanaMintAuthorityViaRpc(tokenAddress: string, cfg: TokenSecurityConfig): Promise<string[]> {
  if (!cfg.useSolanaRpc) return []

  const endpoint = cfg.solanaRpcEndpoint ?? defaultSolanaRpcEndpoint()
  const result = await checkMintAuthority(tokenAddress, { endpoint })

  if (!result.rpcAvailable) {
    console.warn(`TokenSecurityGuard: Solana RPC unavailable — mint/freeze authority check skipped for ${tokenAddress}`)
    return []
  }

  const reasons: string[] = []
  if (result.hasMintAuthority) reasons.push('Mint authority active — token supply not fixed')
  if (result.hasFreezeAuthority) reasons.push('Freeze authority active — wallets can be frozen')
  return reasons
}

/**
 * Evaluate locally-recorded liquidity/sell-pressure history (see
 * `liquidity-tracker.ts`). Read-only — never calls `recordSnapshot`; a
 * separate live scanner owns writing that history. `pairAddress` may be
 * undefined if the pair snapshot fetch itself failed — treated the same as
 * "not enough history yet" rather than a distinct error path.
 */
async function checkLiquidityGrowthSignal(pairAddress: string | undefined, cfg: TokenSecurityConfig): Promise<string[]> {
  if (!cfg.useLiquidityTracker) return []

  const growth = pairAddress ? await getLiquidityGrowth(pairAddress) : null
  if (!growth || !growth.hasEnoughSnapshots) {
    if (cfg.requireEnoughSnapshots) {
      return ['Insufficient tracking data — token not yet monitored long enough']
    }
    console.warn(`TokenSecurityGuard: not enough liquidity-growth history for ${pairAddress ?? '(unresolved pair)'} (${growth?.snapshotCount ?? 0} snapshot(s)) — skipping`)
    return []
  }

  const reasons: string[] = []
  const minGrowthPct = cfg.minLiquidityGrowthPct ?? -20
  if (growth.liquidityGrowthPct < minGrowthPct) {
    reasons.push(`Liquidity draining ${growth.liquidityGrowthPct.toFixed(1)}% — possible rug in progress`)
  }

  const maxSellPressure = cfg.maxSellPressure ?? 0.7
  if (growth.buyPressure < (1 - maxSellPressure)) {
    const sellPct = (1 - growth.buyPressure) * 100
    reasons.push(`Sell pressure dominant (${sellPct.toFixed(1)}% sells in last hour)`)
  }

  return reasons
}

/**
 * Check a token via GoPlus Security (honeypot/mint/freeze/tax/holders) plus
 * DexScreener-sourced signals (liquidity floor, buy activity, sell
 * pressure), a locally-recorded liquidity-growth history, and, optionally,
 * a direct Solana RPC mint/freeze check, against the configured
 * thresholds. Every DexScreener/RPC/tracker-sourced check here is gated
 * purely by config presence, not by token age — an account that wants
 * these applied only to fresh tokens configures a dedicated preset/guard
 * for that age band (see `dex-early`-style presets) rather than this
 * function inferring freshness itself, since nothing here currently has
 * reliable access to a token's age.
 * Fail-safe: any GoPlus API/network error or unknown token → `passed: false`.
 * The Solana RPC check, the liquidity-tracker "not enough data" case (when
 * `requireEnoughSnapshots` is unset), and GoPlus unavailability itself (when
 * `requireGoPlus: false`) are the exceptions — see their own docstrings.
 */
export async function checkTokenSecurity(
  chain: string,
  tokenAddress: string,
  config: TokenSecurityConfig,
  existingPair?: DexScreenerPair,
): Promise<TokenSecurityResult> {
  const reasons: string[] = []

  // Always needed — checkCrashGap below has no config flag and runs
  // unconditionally for every candidate. Skip the fetch entirely when a
  // caller already has a fresh pair in hand (e.g. live-scan.ts's scan loop
  // just fetched this exact pair moments ago) rather than re-requesting the
  // same DexScreener data.
  const pair = existingPair ?? await fetchPairSnapshot(chain, tokenAddress)

  const bootstrappedSignalCount = await countBootstrappedSignals(chain, tokenAddress, config)

  reasons.push(...checkLiquidity(pair, config))
  reasons.push(...checkTxnActivity(pair, config))
  reasons.push(...await checkLiquidityGrowthSignal(pair?.pairAddress, config))
  reasons.push(...checkMomentum(pair, config))
  reasons.push(...checkCrashGap(pair))
  reasons.push(...checkOverextension(pair, config, bootstrappedSignalCount))
  reasons.push(...checkVolumeLiquidityRatio(pair, config))
  reasons.push(...checkNameFilter(pair, config))
  reasons.push(...await checkWalletSignal(chain, tokenAddress, config))
  reasons.push(...checkBootstrappedSignalRequirement(config, bootstrappedSignalCount))

  if (chain === 'solana') {
    reasons.push(...await checkSolanaMintAuthorityViaRpc(tokenAddress, config))
  }

  // GoPlus is always attempted, regardless of requireGoPlus — that flag
  // only changes what happens if it FAILS to answer, never whether it's
  // called. When it does answer, its checks apply unconditionally below.
  const data = await fetchGoPlusData(chain, tokenAddress)
  if (!data) {
    if (config.requireGoPlus === false) {
      console.warn(`TokenSecurityGuard: GoPlus unavailable for ${chain}:${tokenAddress} — skipped (requireGoPlus: false), relying on RPC+liquidity+txns signals`)
      return { passed: reasons.length === 0, reasons }
    }
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

const CACHE_PURGE_INTERVAL_MS = 5 * 60_000
// Same rationale as solana-rpc.ts's cache cap — a long-running scanner
// checks hundreds of distinct tokens a day, most only ever once, so an
// unbounded per-instance cache grows for the life of the process.
const MAX_CACHE_SIZE = 500

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
  private readonly purgeTimer: ReturnType<typeof setInterval>

  constructor(options: Record<string, unknown>) {
    this.config = options as TokenSecurityConfig
    this.purgeTimer = setInterval(() => this.purgeExpiredCacheEntries(), CACHE_PURGE_INTERVAL_MS)
    this.purgeTimer.unref?.()
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

    this.setCached(cacheKey, result)

    return result.passed ? null : `Token security check failed: ${result.reasons.join('; ')}`
  }

  private purgeExpiredCacheEntries(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < now) this.cache.delete(key)
    }
  }

  /** Map preserves insertion order and every entry shares the same TTL, so the first key iterated is also the oldest — no separate last-accessed timestamp needed. */
  private setCached(cacheKey: string, result: TokenSecurityResult): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      this.purgeExpiredCacheEntries()
      while (this.cache.size >= MAX_CACHE_SIZE) {
        const oldestKey = this.cache.keys().next().value
        if (oldestKey === undefined) break
        this.cache.delete(oldestKey)
      }
    }
    this.cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS })
  }
}
