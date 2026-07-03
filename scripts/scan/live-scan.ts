/**
 * live-scan — continuous scanner replacing retro:today's one-shot snapshot
 * with a real polling daemon: every `--interval` seconds, pull DexScreener's
 * latest token profiles, record a liquidity snapshot for each (feeding
 * `liquidity-tracker.ts`'s history for later cycles), evaluate every
 * candidate against three independent paper-mode strategies, and manage
 * exits for whatever's already open (see `checkExits`, run first every
 * cycle — Phase E: without exits there's no way to measure real results).
 *
 * Broker config vs. guard config vs. age-band selection deliberately don't
 * live in `preset-catalog.ts` yet — that file's `BrokerPresetDef` shape
 * configures a broker engine, not a `TokenSecurityConfig` guard bundle, and
 * there was no real consumer for `minAgeMinutes`/`maxAgeMinutes` before this
 * scanner existed. This file is that consumer: it owns the age-band
 * filtering itself (deciding which candidates even get submitted to which
 * guard config) rather than teaching `TokenSecurityGuard` about freshness.
 *
 * Known limitation, stated plainly: `fetchDexScreenerTokenPairs`/
 * `fetchLatestTokenProfiles` collapse every failure mode (429, timeout,
 * 5xx, malformed body) into the same empty result — the module has no way
 * to distinguish "rate limited" from "legitimately no data." A per-token
 * empty pair list is normal (many fresh tokens have no indexed pool yet),
 * so backoff here keys off `fetchLatestTokenProfiles()` returning empty —
 * that endpoint is essentially never legitimately empty, so an empty
 * result from it specifically is a much stronger signal of an actual API
 * problem than a per-token empty result would be.
 *
 * Second known limitation, Phase E addition: `walletSignals` is computed
 * for every scanned candidate every cycle (per spec, for JSONL
 * observability), and each call chains a `getSignaturesForAddress` plus up
 * to 20 `getTransaction` RPC calls (see wallet-watcher.ts). That's a lot of
 * raw Solana RPC traffic per cycle with no dedicated throttling of its own
 * — acceptable for now since every failure mode there is fail-safe (empty
 * result, never a thrown error), but it's the first thing to revisit if a
 * live run shows this dominating cycle time.
 */
import { appendFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { dataPath } from '@/core/paths.js'
import {
  fetchLatestTokenProfiles,
  fetchDexScreenerTokenPairs,
  fetchDexScreenerTokensBatch,
  fetchPairForMint,
  bestPair,
  type DexScreenerPair,
} from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { recordSnapshot } from '../../services/uta/src/domain/trading/brokers/dex/liquidity-tracker.js'
import { checkMintAuthority, defaultSolanaRpcEndpoint } from '../../services/uta/src/domain/trading/brokers/dex/solana-rpc.js'
import { GraduatedTokensTracker, type GraduatedToken } from '../../services/uta/src/domain/trading/brokers/dex/graduated-tokens-tracker.js'
import { recordVelocitySnapshot, getMarketVelocity, type MarketVelocity } from '../../services/uta/src/domain/trading/brokers/dex/market-velocity.js'
import { checkTokenName } from '../../services/uta/src/domain/trading/brokers/dex/dex-name-filter.js'
import {
  getRecentBuyers,
  getWalletSignals,
  updateWalletResult,
  getTrackedWalletSummary,
  type WalletSignal,
} from '../../services/uta/src/domain/trading/brokers/dex/wallet-watcher.js'
import {
  openPosition,
  closePosition,
  getOpenPositions,
  updatePeakPrice,
  getClosedToday,
  getDailyStats,
  clearStaleLockIfPresent,
  type OpenPosition,
  type ExitReason,
  type StrategyLabel,
  type PositionExitConfig,
} from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'
import { checkTokenSecurity, type TokenSecurityConfig } from '../../services/uta/src/domain/trading/guards/TokenSecurityGuard.js'
import { DexBroker, type DexChain } from '../../services/uta/src/domain/trading/brokers/dex/DexBroker.js'
import { priceFeed } from '../../services/uta/src/domain/trading/brokers/dex/dex-price-feed.js'
import { PumpFunFeed, type PumpFunToken } from '../../services/uta/src/domain/trading/brokers/dex/pump-fun-feed.js'
import { HeliusPoolFeed, type DiscoveredPool, type GraduationEvent } from '../../services/uta/src/domain/trading/brokers/dex/helius-pool-feed.js'

// ==================== Strategy configs ====================
// Local to this file, not preset-catalog.ts — see file header.

export interface StrategyConfig extends TokenSecurityConfig {
  label: StrategyLabel
  minAgeMinutes: number
  /** undefined = no upper bound. */
  maxAgeMinutes?: number
  /** Captured onto the position at open time — see PositionExitConfig's docstring for why this isn't re-derived from the live config at close time. */
  exitConfig: PositionExitConfig
}

// ==================== Exit-rule configs ====================
// "ConfigD" — adopted 2026-07-01 from scripts/retro/exit-sim.ts (see
// evaluateExitRules's docstring for the empirical justification). Used by
// every strategy except SCALP_MOMENTUM.
export const EARLY_EXIT_CONFIG: PositionExitConfig = {
  stopLoss: -20,
  takeProfit: 40, // lowered from 200, 2026-07-02 — walk-forward validated on 491 EARLY trades (avgReturn -4.07%→-2.57%, replicates in both chronological halves); saves 0 rugs beyond what EARLY_STRICT already blocks, trims big winners (Barney 209%→65%, BongoCat 281%→55%)
  trailingStopActivationPct: 12,
  trailingStopPct: -15,
  momentumThreshold: -10,
  timeExitMinutes: 180,
}

// Adopted 2026-07-02 for SCALP_MOMENTUM: a defined 1:2 risk/reward (-8%/+16%)
// sized off the real maxReturn distribution measured on that day's scan-log
// (7.7% of bought tokens ever cleared +50%, ~15% cleared +24%, 65% never
// cleared +5%) — see the exit-sim ConfigE comparison in that day's retro
// report for the reasoning.
export const SCALP_EXIT_CONFIG: PositionExitConfig = {
  stopLoss: -8,
  takeProfit: 16,
  trailingStopActivationPct: 8,
  trailingStopPct: -6,
  momentumThreshold: -6,
  timeExitMinutes: 90,
}

export const CONSERVATIVE_CONFIG: StrategyConfig = {
  label: 'conservative',
  minAgeMinutes: 360,
  minLiquidityUsd: 8000,
  requireGoPlus: true,
  rejectIfHoneypot: true,
  rejectIfMintable: true,
  rejectIfOwnerCanBlacklist: true,
  rejectIfHighTax: true,
  minHolderCount: 20,
  maxTop10HolderPercent: 70,
  rejectIfLiquidityUnlocked: true,
  useSolanaRpc: false,
  useLiquidityTracker: false,
  exitConfig: EARLY_EXIT_CONFIG,
}

export const EARLY_CONFIG: StrategyConfig = {
  label: 'early',
  minAgeMinutes: 30,
  maxAgeMinutes: 360,
  // Live data (2026-07-01 run) showed 76 rejections on liquidity alone at
  // the old $12k floor for tokens this fresh — lowered to match
  // conservative's $8k rather than being stricter for a strategy that's
  // supposed to accept more risk in exchange for earlier entries.
  minLiquidityUsd: 8000,
  requireGoPlus: false,
  useSolanaRpc: true,
  // No literal endpoint here — TokenSecurityGuard/wallet-watcher each
  // resolve HELIUS_API_KEY vs. public mainnet-beta at call time (see
  // solana-rpc.ts's defaultSolanaRpcEndpoint).
  useLiquidityTracker: true,
  requireEnoughSnapshots: false,
  minBuyTxns1h: 15,
  maxSellBuyRatio1h: 3.0,
  minLiquidityGrowthPct: -20,
  maxSellPressure: 0.7,
  exitConfig: EARLY_EXIT_CONFIG,
}

// Adopted 2026-07-02 — replaces SCALP_MOMENTUM_CONFIG in the active strategy
// set (see runLiveScan): SCALP_MOMENTUM's filters stayed at 0/120 passes
// even after relaxing minLiquidityUsd/minPriceChangePct1h, meaning the
// current pump.fun token flow structurally can't support that strategy, not
// that its thresholds needed a small tweak. EARLY_STRICT is EARLY plus two
// filters sized off the real 2026-07-01/02 dataset: minLiquidityUsd raised
// to match winners' $28.8k average entry liquidity, and a new
// maxPriceChangePct1h cap since crashes' average entry-time h1 (+183.8%)
// ran higher than winners' (+104.4%) — see checkOverextension's docstring.
// Run alongside EARLY (not replacing it) specifically to compare the two on
// live data rather than assume the filter helps.
export const EARLY_STRICT_CONFIG: StrategyConfig = {
  ...EARLY_CONFIG,
  label: 'early_strict',
  minLiquidityUsd: 15000,
  maxPriceChangePct1h: 150,
}

/**
 * Adopted 2026-07-03 — EARLY plus exactly ONE additional filter
 * (`requireWebsite`), deliberately built on `EARLY_CONFIG` rather than
 * `EARLY_STRICT_CONFIG` so this strategy isolates the `hasWebsite` variable
 * on its own. Stacking it onto EARLY_STRICT's liquidity/overextension
 * filters would have reproduced the exact confusion this session already
 * hit once (GRAD_IMMEDIATE's liquidity-floor test) and corrected for: with
 * two filters changing at once, a live result couldn't be attributed to
 * either one specifically.
 *
 * Retrospective evidence (n=620 EARLY+EARLY_STRICT trades with `hasWebsite`
 * resolvable via scan-log, 2026-07-02/03): rejecting `hasWebsite=false`
 * candidates would have cut the retained set's average return from -1.21pp
 * to +0.11pp (EARLY alone: -1.00pp -> +0.44pp; EARLY_STRICT alone: -1.56pp
 * -> -0.43pp, stays negative even filtered) — at the cost of rejecting
 * ~49% of volume that already passes EARLY/EARLY_STRICT's own filters.
 *
 * Evidence is NOT clean enough to apply directly to EARLY/EARLY_STRICT,
 * which is why this is a separate parallel strategy instead. A 2-half
 * chronological walk-forward looked solid, but a finer QUARTILE split (4
 * windows instead of 2) revealed real instability the coarser split
 * masked:
 *   - hasWebsite=true's own base rate swung 30.4% -> 61.9% -> 46.4% -> 61.8%
 *     across the 4 quartiles — not stable, and not explained away yet
 *     (could be a real signal drifting with the creator population, or
 *     just noise at ~168 trades/quartile — not distinguished here).
 *   - Outcome direction reversed locally twice: Q1's rug rate favored
 *     hasWebsite=FALSE (4.3% vs 9.8%), and Q2's avg return favored
 *     hasWebsite=FALSE (-2.95pp vs -5.63pp) — both opposite the overall
 *     trend. 3 of 4 quartiles still favored hasWebsite=true on avg return,
 *     so the effect isn't dead, but it's noisier than the clean 2-half
 *     split suggested.
 *   - Methodological note for future signal validation in this project:
 *     ALWAYS check a finer split (quartiles, not just halves) before
 *     trusting a 2-half walk-forward — see data/notes/session-summary.md's
 *     methodology section, added alongside this decision.
 *
 * Field coverage confirmed 100% on live scans as of 2026-07-03 (1987/1987
 * same-day scan-log entries, last 200 real-time scans) — not a data-
 * availability concern, purely a signal-robustness one.
 *
 * Reopen threshold to promote this into an actual EARLY/EARLY_STRICT
 * filter: n>=30 trades under THIS strategy in real conditions (not the
 * retrospective join), AND a quartile split (not just a 2-half one) on
 * that live sample showing no direction reversal — the bar this decision
 * itself was held to.
 */
export const EARLY_WEB_FILTERED_CONFIG: StrategyConfig = {
  ...EARLY_CONFIG,
  label: 'early_web_filtered',
  requireWebsite: true,
}

// COPY_WALLET exit config, adopted 2026-07-02 alongside the preset below —
// tighter and faster than EARLY_EXIT_CONFIG on the premise that a wallet
// with a real, independently-measured track record (wallet-bootstrapper.ts)
// already timed its own entry, so this strategy doesn't need to wait out a
// long hold for the trade to develop the way EARLY does; timeExitMinutes:60
// mirrors the "winning wallets exit fast" assumption behind the preset, not
// a validated exit-timing measurement of its own.
export const COPY_WALLET_EXIT_CONFIG: PositionExitConfig = {
  stopLoss: -15,
  takeProfit: 40,
  trailingStopActivationPct: 10,
  trailingStopPct: -10,
  momentumThreshold: -10,
  timeExitMinutes: 60,
}

// COPY_WALLET — buys the moment 2+ wallets with a real, independently-
// measured win rate (wallet-bootstrapper.ts's bootstrapped.json, NOT
// wallet-watcher.ts's tracked.json — see that file's header for why the
// distinction matters) are seen buying the same token, trusting the wallet
// signal over the usual age/momentum/txn-activity filters (minAgeMinutes:0,
// minBuyTxns1h:0 — see checkBootstrappedSignalRequirement's docstring for
// the fail-closed rationale). NOT YET VALIDATED: the 2026-07-02 bootstrap
// run's seed was only 80 wallets from 5 winning trades (see
// wallet-bootstrapper.ts's header) — nowhere near enough qualified wallets
// yet to trust this gate live. Defined here, fully wired into
// checkTokenSecurity via minBootstrappedSignals, but deliberately excluded
// from the active `strategies` array below (see the TODO there) until the
// bootstrap's qualified-wallet count is large enough to backtest this
// preset against real closed trades first.
export const COPY_WALLET_CONFIG: StrategyConfig = {
  label: 'copy_wallet',
  minAgeMinutes: 0,
  maxAgeMinutes: 120,
  minLiquidityUsd: 10000,
  requireGoPlus: false,
  useSolanaRpc: true,
  minBuyTxns1h: 0,
  minBootstrappedSignals: 2,
  exitConfig: COPY_WALLET_EXIT_CONFIG,
}

// GRAD_IMMEDIATE/GRAD_DIP are event/dip-driven, not age-window-driven — they
// have no StrategyConfig (no minAgeMinutes/checkTokenSecurity-config
// pipeline to run per DexScreener candidate) and are therefore never added
// to the `strategies: StrategyRuntime[]` array runScanPhase iterates (see
// runLiveScan's gradStrategies — kept separate specifically so they're never
// evaluated against the generic candidate loop). They still need a
// PositionExitConfig (openPosition requires one) and still participate in
// runExitsPhase/restoreOpenPositions via their own broker.
export const GRAD_IMMEDIATE_EXIT_CONFIG: PositionExitConfig = {
  stopLoss: -20,
  takeProfit: 80,
  trailingStopActivationPct: 25,
  trailingStopPct: -12,
  momentumThreshold: -10,
  timeExitMinutes: 120,
}

export const GRAD_DIP_EXIT_CONFIG: PositionExitConfig = {
  stopLoss: -15,
  takeProfit: 40,
  trailingStopActivationPct: 15,
  trailingStopPct: -10,
  momentumThreshold: -8,
  timeExitMinutes: 240,
}

/** Only `label`/`exitConfig` are ever read for these two (restoreOpenPositions/runExitsPhase) — minAgeMinutes/etc. are structurally unused since neither strategy goes through evaluateStrategy(). Kept minimal rather than omitted so StrategyRuntime's type still holds. */
export const GRAD_IMMEDIATE_CONFIG: StrategyConfig = {
  label: 'grad_immediate',
  minAgeMinutes: 0,
  exitConfig: GRAD_IMMEDIATE_EXIT_CONFIG,
}

/**
 * Suspended 2026-07-02 — entry only, not the strategy itself. Full-history
 * expectancy at n=31 is -6.64pp (win rate 29.0%, avgWin +69.08pp, avgLoss
 * -37.62pp), and TWO independent chronological walk-forwards on this
 * strategy both reversed sign between halves:
 *   - the proposed $15k liquidity-floor tweak: 1st half +17.61pp / 2nd half -1.14pp
 *   - the strategy's own raw halves: 1st +19.66pp / 2nd -31.31pp
 * A strategy whose own walk-forward flips sign is degrading over time, not
 * suffering from a mistunable threshold — no single-parameter fix (liquidity
 * floor, delay, stopLoss) survived validation. Diagnosis: the entry itself is
 * a 90s-post-graduation "blind buy" (liquidity + momentum + mint/freeze RPC
 * only — see handleGradImmediate's docstring) with no equivalent of EARLY's
 * checkTokenSecurity()/GoPlus/h1-overextension gate. Root-caused as a missing
 * entry-quality gate, not a threshold to retune.
 *
 * `handleGradImmediate` itself is left fully intact and unit-tested — only
 * its live trigger (the onGraduation callback in runLiveScan, see
 * GRAD_IMMEDIATE_ENTRY_SUSPENDED's usage there) is gated off, so the
 * strategy stays backtestable/re-runnable once a real entry-quality
 * criterion replaces the blind-buy check set. GRAD_DIP was suspended
 * separately on 2026-07-03 for a different reason — see
 * GRAD_DIP_ENTRY_SUSPENDED's own docstring, the two must not be conflated:
 * this one is a walk-forward SIGN REVERSAL (degrading over time), GRAD_DIP's
 * is a flat absence of any positive signal (no reversal, no degradation).
 */
export const GRAD_IMMEDIATE_ENTRY_SUSPENDED = true

export const GRAD_DIP_CONFIG: StrategyConfig = {
  label: 'grad_dip',
  minAgeMinutes: 0,
  exitConfig: GRAD_DIP_EXIT_CONFIG,
}

/**
 * Suspended 2026-07-03 — entry only, not the strategy itself, same pattern
 * as GRAD_IMMEDIATE_ENTRY_SUSPENDED but a DIFFERENT diagnosis, documented
 * precisely so the two aren't conflated:
 *
 * Raw trade history showed n=50 across only 12 unique tokens (~4.2
 * trades/token) — investigation found `handleGradDip()` never checked
 * `hasOpenPosition()` before buying (unlike evaluateStrategy()'s buy path),
 * so a token sitting in the -25%/-60% dip band across consecutive 30s
 * cycles got bought repeatedly, stacking concurrent positions on the same
 * mint (confirmed: up to 4 simultaneous open positions on one mint, Anthar,
 * 2026-07-02 20:25-23:37). Fixed by adding the missing `hasOpenPosition()`
 * guard (see handleGradDip below) — 17 of the 50 trades (34%) were
 * duplicate buys this guard would have blocked.
 *
 * Re-diagnosed on the CLEAN n=33 (guard simulated retroactively, still 12
 * independent tokens): -12.55pp average, walk-forward split by token (not
 * by trade — a token is assigned entirely to one half by its first-seen
 * date, so it can't straddle both) gives 1st half -11.77pp (6 tokens, n=20)
 * and 2nd half -13.75pp (6 tokens, n=13). Unlike GRAD_IMMEDIATE, THIS
 * WALK-FORWARD DOES NOT REVERSE SIGN and shows no meaningful degradation —
 * it's flat and negative across the whole observed period. The diagnosis
 * here is a plain absence of positive signal on the available sample, not a
 * strategy that's actively getting worse. Also unlike GRAD_IMMEDIATE, the
 * dedup bug materially inflated the raw trade count (34% of trades were
 * spurious duplicates) — fixing it changed the trade count and rug rate,
 * but not the sign or rough magnitude of the average return (-12.09pp raw
 * vs -12.55pp clean).
 *
 * Reopen threshold: either a materially larger independent-token sample
 * (12 is still thin — most of that n=33 comes from just a few tokens with
 * multiple sequential, mostly uncorrelated re-entries, see
 * data/notes/token-registry.json's per-token consistency finding: only
 * 1.5% of repeat-buy tokens win twice in a row), or a redesigned entry
 * criterion (separate design work, not a threshold retune — GRAD_DIP's
 * checks are already closer to EARLY's than GRAD_IMMEDIATE's blind buy was,
 * so the fix here isn't "add a missing guard" the way GRAD_IMMEDIATE's
 * would be).
 *
 * `handleGradDip` itself is left fully intact and unit-tested (including
 * the hasOpenPosition() dedup fix) — only its live trigger (the call site
 * in runLiveScan's main loop) is gated off, so the strategy stays
 * backtestable/re-runnable.
 */
export const GRAD_DIP_ENTRY_SUSPENDED = true

export const MOMENTUM_CONFIG: StrategyConfig = {
  label: 'momentum',
  minAgeMinutes: 60,
  maxAgeMinutes: 480,
  minLiquidityUsd: 15000,
  requireGoPlus: false,
  useSolanaRpc: true,
  useLiquidityTracker: true,
  requireEnoughSnapshots: true,
  minLiquidityGrowthPct: 10,
  requirePositiveMomentum: true,
  minPriceChangePct5m: 2,
  minPriceChangePct1h: 10,
  minVolumeLiquidityRatio1h: 0.5,
  maxVolumeLiquidityRatio1h: 20,
  minBuyTxns1h: 30,
  maxSellBuyRatio1h: 2.0,
  maxNameRiskScore: 30,
  useWalletWatcher: true,
  minWalletWinRate: 0.6,
  minWalletTrades: 5,
  exitConfig: EARLY_EXIT_CONFIG,
}

// Adopted 2026-07-02 — replaces MOMENTUM_CONFIG in the active strategy set
// (see runLiveScan): MOMENTUM_CONFIG never passed a single candidate across
// the full 2026-07-01 session (0/529 evaluations, dominated by its age
// window never matching the pump.fun token population). Tighter entry
// filters, sized off the same day's real data, paired with a defined 1:2
// exit (SCALP_EXIT_CONFIG). Expected to pass very few candidates — that's
// intentional, not a bug to fix.
export const SCALP_MOMENTUM_CONFIG: StrategyConfig = {
  label: 'scalp_momentum',
  minAgeMinutes: 45,
  maxAgeMinutes: 180,
  minLiquidityUsd: 20000,
  requireGoPlus: false,
  useSolanaRpc: true,
  minBuyTxns1h: 25,
  maxSellBuyRatio1h: 1.5,
  requirePositiveMomentum: true,
  minPriceChangePct5m: 1,
  minPriceChangePct1h: 15,
  minVolumeLiquidityRatio1h: 0.3,
  maxVolumeLiquidityRatio1h: 15,
  maxNameRiskScore: 20,
  useLiquidityTracker: true,
  requireEnoughSnapshots: false,
  minLiquidityGrowthPct: 0,
  exitConfig: SCALP_EXIT_CONFIG,
}

const MAX_OPEN_POSITIONS_PER_STRATEGY = 5
// Fixed trade size for every buy. Also used by restoreOpenPositions() below to
// infer a restored position's quantity (quantity = TRADE_AMOUNT_USD / entryPrice)
// since position-tracker.ts's OpenPosition doesn't persist quantity/amountUsd —
// valid only as long as every buy uses this same fixed amount.
const TRADE_AMOUNT_USD = 50

// ==================== Rate limiting ====================

const MIN_GAP_MS = 2000
const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000]

export class RateLimiter {
  private lastCallAt = 0
  private consecutiveFailures = 0

  async throttle(signal?: AbortSignal): Promise<void> {
    const elapsed = Date.now() - this.lastCallAt
    if (elapsed < MIN_GAP_MS) await sleep(MIN_GAP_MS - elapsed, signal)
    this.lastCallAt = Date.now()
  }

  /** Call after fetchLatestTokenProfiles() with whether it came back empty. */
  async recordAndMaybeBackoff(cameBackEmpty: boolean, signal?: AbortSignal): Promise<void> {
    if (!cameBackEmpty) {
      this.consecutiveFailures = 0
      return
    }
    const delay = BACKOFF_DELAYS_MS[Math.min(this.consecutiveFailures, BACKOFF_DELAYS_MS.length - 1)]!
    this.consecutiveFailures++
    console.warn(`live-scan: token-profiles feed came back empty ${this.consecutiveFailures} time(s) in a row — possible rate limit, backing off ${delay / 1000}s`)
    await sleep(delay, signal)
  }
}

/**
 * Abortable sleep — every wait in this file (throttle gap, backoff, the
 * main interval) takes an optional shutdown signal so a SIGINT/SIGTERM
 * request interrupts immediately instead of potentially blocking for up to
 * `BACKOFF_DELAYS_MS`'s longest entry (2 minutes) before the process
 * notices it should stop.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

// ==================== Scan log ====================

export interface StrategyDecision {
  pass: boolean
  reason: string
  tradeSimulated?: boolean
  orderId?: string
}

/**
 * The raw DexScreener/derived signals that fed the strategy decisions on
 * this line — everything TokenSecurityGuard's checks already had in memory
 * for this candidate, persisted here too so a later replay tool (see
 * scripts/retro/exit-sim.ts) doesn't have to re-fetch live (and therefore
 * stale/wrong-moment) data to reconstruct what the guard saw at scan time.
 * No extra network call — these values already exist in `pair`/`nameFilter`/
 * `walletSignals` by the time this line is built.
 */
export interface ScanLogRawData {
  priceChange?: { m5?: number; h1?: number; h6?: number }
  volume?: { m5?: number; h1?: number; h6?: number }
  txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number } }
  liquidityUsd: number
  ageMinutes: number
  pairCreatedAt?: number
  nameFilter?: { riskScore: number; flags: string[] }
  walletSignals?: WalletSignal[]
  /**
   * Social/website presence + paid-promotion status, captured for sample
   * accumulation only — not used in any filter. Adopted 2026-07-02: was
   * already present in DexScreener's raw pair response but silently
   * discarded here before this change; presence alone showed only a weak
   * split on the small sample checked that day (rugs 72.7% had socials,
   * winners 92.9% — not clean enough to filter on). Persisted so a larger
   * sample can be judged later, once enough scan-log history accumulates.
   */
  hasSocials?: boolean
  hasWebsite?: boolean
  boostsActive?: number
}

export interface ScanLogEntry {
  type: 'scan'
  timestamp: string
  pairAddress: string
  symbol: string
  tokenAddress: string
  ageMinutes: number
  liquidityUsd: number
  priceAtScan: number
  conservative: StrategyDecision
  early: StrategyDecision
  momentum: StrategyDecision
  scalp_momentum: StrategyDecision
  early_strict: StrategyDecision
  early_web_filtered: StrategyDecision
  velocityContext: { tokensPerHour: number; trend: MarketVelocity['trend'] }
  walletSignals: WalletSignal[]
  nameFilter: { riskScore: number; flags: string[] }
  rawData: ScanLogRawData
}

export interface ExitLogEntry {
  type: 'exit'
  positionId: string
  symbol: string
  strategy: StrategyLabel
  entryPrice: number
  exitPrice: number
  returnPct: number
  holdingMinutes: number
  exitReason: ExitReason
  timestamp: string
}

export type LogEntry = ScanLogEntry | ExitLogEntry

export function scanLogPath(date: string = new Date().toISOString().slice(0, 10)): string {
  return dataPath('scan-log', `${date}.jsonl`)
}

export async function appendScanLog(entry: LogEntry): Promise<void> {
  const filePath = scanLogPath()
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
}

// ==================== Silent-distribution observability (2026-07-03) ====================
// Hypothesis sourced from public memecoin market-making writeups (informally
// called "Drizzle"/"Burst" patterns in some of them) — NOT an academically
// validated signal, flagged here as exactly that. Claim: a token can show a
// large buy-transaction count with no proportional price response because a
// seller (dev/whale) is quietly absorbing that buy pressure by distributing
// into it, rather than the buy pressure itself being weak.
// `checkTxnActivity`'s existing `maxSellBuyRatio1h` (TokenSecurityGuard.ts)
// can't catch this: it counts sell TRANSACTIONS, and one large sell can
// offset many small buys in dollar terms while still registering as a
// single, unremarkable sell count — the same blind spot this instrumentation
// targets.
//
// Retroactive test (2026-07-03, n=1392 EARLY/EARLY_STRICT/EARLY_WEB_FILTERED
// trades with a resolvable pre-entry scan snapshot — see
// data/notes/session-summary.md): flagging `txns.h1.buys >= 3770` (top
// quartile of this population) AND `priceChange.h1 <= -7.64%` (bottom
// quartile) gave n=51 (3.7%) with a BETTER average return (+4.04pp vs
// -2.18pp) and 0% rug rate than the rest — the OPPOSITE direction from the
// hypothesis. A quartile split on that n=51 was highly unstable (+2.76pp,
// -10.44pp, +25.91pp, -0.85pp across the 4 quartiles, no consistent sign) —
// no reliable retroactive signal either way. Age/entry-liquidity confounds
// checked and ruled out (both groups near-identical: ~84min age, ~$25-27k
// liquidity).
//
// This instrumentation exists BECAUSE that retroactive test's proxy
// (transaction COUNT, not $ volume or whale-specific detection) is a weak
// operationalization of the actual hypothesis, and because a backtest can
// only see trades that were actually bought — it has no comparison group of
// candidates that matched the pattern and were passed over. Logging fires
// for EVERY candidate `runScanPhase` evaluates regardless of buy outcome,
// building the comparative sample the backtest couldn't assemble on its own.
// Thresholds below are the same ones the retroactive quartile analysis used
// — provisional, not re-derived dynamically from the live sample as it
// accumulates (same "fixed constant, not adaptive" convention as
// STOP_LOSS_OVERSHOOT_ALERT_PP).
//
// Zero effect on trading decisions — logging only, same convention as
// stopLossOvershootCount. Written to its own file (dataPath, i.e. the real
// `~/.openalice/data` root), NOT the repo's `data/notes/` — that directory
// holds hand-authored session documentation, not scanner telemetry.
const SILENT_DISTRIBUTION_MIN_BUYS_H1 = 3770
const SILENT_DISTRIBUTION_MAX_PRICE_CHANGE_H1 = -7.64

interface SilentDistributionMatch {
  buysH1: number
  sellsH1?: number
  priceChangeH1: number
  priceChangeM5?: number
}

/** Returns the triggering metrics when the pattern matches, `null` otherwise (including when the underlying DexScreener fields are missing — no data is never treated as a match). */
function detectSilentDistributionPattern(pair: DexScreenerPair): SilentDistributionMatch | null {
  const buysH1 = pair.txns?.h1?.buys
  const priceChangeH1 = pair.priceChange?.h1
  if (buysH1 == null || priceChangeH1 == null) return null
  if (buysH1 < SILENT_DISTRIBUTION_MIN_BUYS_H1 || priceChangeH1 > SILENT_DISTRIBUTION_MAX_PRICE_CHANGE_H1) return null
  return { buysH1, sellsH1: pair.txns?.h1?.sells, priceChangeH1, priceChangeM5: pair.priceChange?.m5 }
}

interface SilentDistributionLogEntry extends SilentDistributionMatch {
  timestamp: string
  tokenAddress: string
  symbol: string
  liquidityUsd: number
  ageMinutes: number
  /** Which strategies' evaluateStrategy() call passed for this candidate this same cycle — [] means detected but not bought by anything running today. */
  passedStrategies: StrategyLabel[]
}

export function silentDistributionLogPath(date: string = new Date().toISOString().slice(0, 10)): string {
  return dataPath('silent-distribution', `${date}.jsonl`)
}

export async function appendSilentDistributionLog(entry: SilentDistributionLogEntry): Promise<void> {
  const filePath = silentDistributionLogPath()
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
}

// ==================== Strategy evaluation ====================

async function hasOpenPosition(broker: DexBroker, tokenAddress: string): Promise<boolean> {
  const positions = await broker.getPositions()
  return positions.some(p => (p.contract.localSymbol || p.contract.symbol) === tokenAddress)
}

export async function evaluateStrategy(
  cfg: StrategyConfig,
  chain: string,
  tokenAddress: string,
  ageMinutes: number,
  broker: DexBroker,
  pair: DexScreenerPair,
): Promise<StrategyDecision> {
  const inWindow = ageMinutes >= cfg.minAgeMinutes && (cfg.maxAgeMinutes == null || ageMinutes <= cfg.maxAgeMinutes)
  if (!inWindow) {
    const upper = cfg.maxAgeMinutes ?? Infinity
    return { pass: false, reason: `age ${ageMinutes.toFixed(0)}m outside [${cfg.minAgeMinutes}, ${upper === Infinity ? '∞' : upper}] window for ${cfg.label}` }
  }

  const security = await checkTokenSecurity(chain, tokenAddress, cfg, pair)
  if (!security.passed) {
    return { pass: false, reason: security.reasons.join('; ') }
  }

  if (await hasOpenPosition(broker, tokenAddress)) {
    return { pass: true, reason: 'passed all checks (already holding — no additional buy)', tradeSimulated: false }
  }
  const openCount = (await broker.getPositions()).length
  if (openCount >= MAX_OPEN_POSITIONS_PER_STRATEGY) {
    return { pass: true, reason: `passed all checks (max ${MAX_OPEN_POSITIONS_PER_STRATEGY} open positions reached — no additional buy)`, tradeSimulated: false }
  }

  const contract = broker.resolveNativeKey(tokenAddress)
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.cashQty = new Decimal(TRADE_AMOUNT_USD)
  const result = await broker.placeOrder(contract, order, undefined, pair)

  if (result.success) {
    const entryPrice = Number(pair.priceUsd ?? 0)
    if (Number.isFinite(entryPrice) && entryPrice > 0) {
      // Best-effort — [] on EVM chains or if the RPC is unavailable, never blocks the buy.
      const buyerWallets = chain === 'solana' ? await getRecentBuyers(tokenAddress) : []
      const fastExitRegime = isFastExitRegimeStrategy(cfg.label) ? true : undefined
      await openPosition(pair, cfg.label, entryPrice, ageMinutes, cfg.exitConfig, buyerWallets, fastExitRegime)
      priceFeed.subscribe(pair.pairAddress)
    } else {
      console.warn(`live-scan: buy filled for ${tokenAddress} but pair.priceUsd was unusable — position not recorded in position-tracker`)
    }
  }

  return {
    pass: true,
    reason: 'passed all checks',
    tradeSimulated: result.success,
    orderId: result.orderId,
  }
}

// ==================== Exit rules (Bloc 2b) ====================

/**
 * Evaluated in a fixed priority order — the first matching rule wins for a
 * given cycle. `dropFromPeak` is computed against `max(position.peakPrice,
 * currentPrice)` so a position hitting a fresh all-time high this exact
 * cycle is never immediately flagged as having dropped from its own peak.
 *
 * Thresholds come from `position.exitConfig` — captured at open time, not
 * looked up from the currently running strategy config, so a config change
 * between restarts can never retroactively change a position's own rules
 * (see PositionExitConfig's docstring). `trailingStopPct` only arms once
 * the position's peak return has cleared `trailingStopActivationPct`
 * (measured off the peak, not the live returnPct — once armed, it stays
 * armed even if price pulls back below the activation line before
 * triggering). `liquidity_drain` (0.4x ratio) is the one rule with no
 * per-position config knob — unchanged across every strategy.
 *
 * `momentum_reversal` — changed 2026-07-02 from a one-off dip check
 * (`priceChange5m <= momentumThreshold && returnPct < 0`) to requiring
 * ACCELERATION: the new reading must clear the threshold AND be more
 * negative than `position.lastPriceChange5m` (the prior cycle's reading,
 * set by `updatePeakPrice`). The old `returnPct < 0` guard is dropped, not
 * kept alongside acceleration.
 *
 * Evidence, stated with the actual confidence it supports (corrected after
 * a first pass overstated it — see session transcript 2026-07-02):
 *   - vs. the OLD rule ("actuel"): a chronological walk-forward split of the
 *     2026-07-01/02 dataset (245 trades / 245 trades, second half strictly
 *     after the first) shows the acceleration rule beating the old rule on
 *     both win rate (+10.7pp then +8.6pp) and avg return, independently in
 *     BOTH halves. This part replicates out-of-sample and is the actual
 *     basis for adopting acceleration over a plain threshold-dip check.
 *   - vs. a simpler "just tighten the threshold to -15%" alternative: this
 *     was NOT a clean win as first reported. Avg return favors acceleration
 *     in both halves (replicates), but win rate does NOT replicate — the
 *     simpler threshold alone had a HIGHER win rate in the second half. The
 *     original "-15% threshold" alternative was tested and rejected mainly
 *     because it doesn't generalize as an idea (an arbitrary tightened
 *     number, no structural reason to prefer -15 over -12 or -18), not
 *     because it's clearly worse on every metric. Avg return replicating
 *     independently while win rate doesn't is itself the tie-breaker in
 *     acceleration's favor — a metric stable across an out-of-sample split
 *     is more trustworthy than one that inverts between halves.
 *   - Noise-sensitivity check: acceleration compares exactly two
 *     consecutive m5 readings, which is more exposed to a single noisy
 *     reading than a fixed threshold. Checked directly: median acceleration
 *     magnitude at trigger was 10.9pp (only 7/225 triggers had <1pp
 *     separation between the two readings), and bucketing triggers by
 *     magnitude (cutoffs 1/2/3/5pp) shows the smallest-margin triggers do
 *     NOT underperform the large-margin ones — if noise-driven false
 *     accelerations were propping up the edge, that bucket should look
 *     worse, and it doesn't. Caveat: those marginal buckets are tiny
 *     (n=7-42), so this doesn't rule out noise sensitivity with confidence,
 *     it just found no evidence of the specific failure mode.
 *   - The original write-up also cited "caught one more of 13 real crashes"
 *     as supporting evidence — a delta of 1 event out of 13 is noise, not a
 *     result; that point should never have been presented as an argument.
 *   - This was a 3-way variant comparison scored on the same dataset before
 *     the walk-forward check existed — multiple-comparison selection bias
 *     is real here, and the confidence in "acceleration is better than
 *     every alternative" is weaker than a single clean A/B result would be.
 *     What DOES hold under out-of-sample validation is narrower and more
 *     defensible: acceleration beats the old unconditional-dip rule.
 *
 * No comparison possible on the first cycle after entry or for a position
 * restored without this field yet recorded — momentum_reversal simply
 * cannot fire that cycle, same fail-safe-by-omission convention as every
 * other optional signal in this file.
 */
export function evaluateExitRules(
  position: OpenPosition,
  currentPrice: number,
  currentLiquidityUsd: number,
  priceChange5m: number | undefined,
): ExitReason | null {
  const { stopLoss, takeProfit, trailingStopActivationPct, trailingStopPct, momentumThreshold, timeExitMinutes } = position.exitConfig
  const returnPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100
  const peak = Math.max(position.peakPrice, currentPrice)
  const dropFromPeak = ((currentPrice - peak) / peak) * 100
  const peakReturnPct = ((peak - position.entryPrice) / position.entryPrice) * 100
  const holdingMinutes = (Date.now() - position.entryTimestamp) / 60_000

  if (returnPct <= stopLoss) return 'stop_loss'

  if (peakReturnPct >= trailingStopActivationPct && dropFromPeak <= trailingStopPct) return 'trailing_stop'

  if (returnPct >= takeProfit) return 'take_profit'

  if (holdingMinutes >= timeExitMinutes) return 'time_exit'

  if (
    priceChange5m != null
    && priceChange5m <= momentumThreshold
    && position.lastPriceChange5m != null
    && priceChange5m < position.lastPriceChange5m
  ) return 'momentum_reversal'

  if (currentLiquidityUsd < position.entryLiquidityUsd * 0.4) return 'liquidity_drain'

  return null
}

/**
 * Simulates the sell via the strategy's own DexBroker (best-effort — if the
 * venue price is genuinely unavailable, the paper ledger position may go
 * stale, but the tracked position below is still closed either way so it
 * stops counting against MAX_OPEN_POSITIONS_PER_STRATEGY), closes the
 * tracked position, feeds the outcome to every wallet seen buying around
 * entry time, and logs an exit JSONL line.
 */
async function executeExit(broker: DexBroker, position: OpenPosition, reason: ExitReason, exitPrice: number): Promise<void> {
  const contract = broker.resolveNativeKey(position.tokenAddress)
  try {
    await broker.closePosition(contract)
  } catch (err) {
    console.warn(`live-scan: failed to simulate sell for ${position.symbol} (${position.tokenAddress}) — ${err instanceof Error ? err.message : String(err)}`)
  }

  const closed = await closePosition(position.id, exitPrice, reason)
  if (!closed) return
  priceFeed.unsubscribe(closed.pairAddress)

  console.log(`live-scan: EXIT ${closed.symbol} (${closed.strategy}) ${reason} — return ${closed.returnPct.toFixed(1)}% after ${closed.holdingMinutes.toFixed(0)}min`)

  for (const wallet of closed.buyerWallets) {
    await updateWalletResult(wallet, closed.returnPct > 0, closed.returnPct)
  }

  await appendScanLog({
    type: 'exit',
    positionId: closed.id,
    symbol: closed.symbol,
    strategy: closed.strategy,
    entryPrice: closed.entryPrice,
    exitPrice: closed.exitPrice,
    returnPct: closed.returnPct,
    holdingMinutes: closed.holdingMinutes,
    exitReason: closed.exitReason,
    timestamp: new Date(closed.exitTimestamp).toISOString(),
  })
}

/**
 * How many percentage points past a position's own configured `stopLoss`
 * counts as a "significant" overshoot worth logging — not every position
 * that closes a point or two past its threshold (normal slippage between
 * checks), only the kind of catastrophic miss that motivated the
 * 2026-07-02 fast-exit-regime fix in the first place (Guy -78.5% vs
 * configured -20%, empire -91.5% vs -20%, etc. — all 25pp+ past threshold).
 */
const STOP_LOSS_OVERSHOOT_ALERT_PP = 10

/**
 * Pure observability counter — incremented by `checkExits` whenever it logs
 * a significant stop_loss overshoot (see STOP_LOSS_OVERSHOOT_ALERT_PP),
 * surfaced in `logSummary` and reset alongside the rest of `stats` each
 * hour. No alerting, no change to trading behavior — the whole point is
 * catching prospectively, without digging through a future session, whether
 * this keeps happening under the fast (5s) exit-check regime. If the count
 * stays near zero going forward, the 5s cadence is doing its job; if it
 * doesn't, that's the evidence needed to justify going to 1s (see
 * FAST_EXIT_CHECK_INTERVAL_MS's docstring — the 2026-07-02 analysis
 * concluded 1s would be safe API-budget-wise but had no evidence either way
 * that it would help, for lack of exactly this kind of data).
 */
let stopLossOvershootCount = 0

/** Test-only — resets the module-level overshoot counter between specs. */
export function __resetStopLossOvershootCountForTests(): void {
  stopLossOvershootCount = 0
}

/** Test-only — reads the module-level overshoot counter. */
export function getStopLossOvershootCount(): number {
  return stopLossOvershootCount
}

/**
 * Runs exit evaluation for every open position of one strategy. Returns how
 * many closed this call.
 *
 * Reads exclusively from `priceFeed`'s cache (see dex-price-feed.ts) — no
 * per-position network call, which is what makes running this every few
 * seconds affordable. A position whose pairAddress has no cache entry yet
 * (subscribed less than one batch interval ago) is skipped for this cycle,
 * not treated as an error; a cached price older than 10s is used anyway but
 * logged as stale, since a slightly-stale price still beats no price at all
 * for exit-rule purposes. Unlike the old per-call `getQuote()` path, a
 * missing price here is never itself grounds for an immediate
 * `liquidity_drain` exit — that would misfire for every position in the
 * first few seconds after opening, before the feed's first tick lands.
 */
export async function checkExits(chain: DexChain, broker: DexBroker, strategy: StrategyLabel, signal?: AbortSignal): Promise<number> {
  const positions = (await getOpenPositions()).filter(p => p.strategy === strategy)
  let closedCount = 0

  for (const position of positions) {
    if (signal?.aborted) break

    const price = priceFeed.getLatestPrice(position.pairAddress)
    if (!price) continue

    if (Date.now() - price.timestamp > 10_000) {
      console.warn(`live-scan: ${position.symbol} — prix stale (>10s, dernier update il y a ${((Date.now() - price.timestamp) / 1000).toFixed(1)}s)`)
    }

    const reason = evaluateExitRules(position, price.priceUsd, price.liquidityUsd, price.priceChange.m5)
    if (reason) {
      if (reason === 'stop_loss') {
        const returnPct = ((price.priceUsd - position.entryPrice) / position.entryPrice) * 100
        const overshootPp = position.exitConfig.stopLoss - returnPct // positive = worse than configured threshold
        if (overshootPp > STOP_LOSS_OVERSHOOT_ALERT_PP) {
          stopLossOvershootCount++
          const elapsedSec = (Date.now() - position.lastCheckedAt) / 1000
          const prevReturnPct = position.lastCheckedPrice != null
            ? ((position.lastCheckedPrice - position.entryPrice) / position.entryPrice) * 100
            : null
          console.warn(
            `live-scan: ⚠ stop_loss overshoot — ${position.symbol} (${position.strategy}) return=${returnPct.toFixed(1)}% vs configured stopLoss=${position.exitConfig.stopLoss}% (${overshootPp.toFixed(1)}pp beyond threshold). `
            + `Previous check ${elapsedSec.toFixed(1)}s ago: ${prevReturnPct != null ? `${prevReturnPct.toFixed(1)}%` : 'n/a (first check)'}.`,
          )
        }
      }
      await executeExit(broker, position, reason, price.priceUsd)
      closedCount++
    } else {
      await updatePeakPrice(position.id, price.priceUsd, price.priceChange.m5)
    }
  }

  return closedCount
}

// ==================== Main cycle ====================

export interface StrategyRuntime {
  config: StrategyConfig
  broker: DexBroker
}

export interface ScanStats {
  cycles: number
  scanned: number
  passed: Record<StrategyLabel, number>
}

export function freshStats(): ScanStats {
  return { cycles: 0, scanned: 0, passed: { conservative: 0, early: 0, momentum: 0, scalp_momentum: 0, early_strict: 0, early_web_filtered: 0, copy_wallet: 0, grad_immediate: 0, grad_dip: 0 } }
}

/**
 * Re-injects any positions position-tracker.ts persisted from a previous
 * process into each strategy's DexBroker in-memory ledger. That ledger is
 * purely in-memory and starts empty on every restart — without this,
 * `evaluateStrategy`'s `hasOpenPosition` check misses already-held
 * positions and re-buys the same token (confirmed live: a duplicate
 * "empire" position opened after a restart during testing). Called once at
 * startup, before the first cycle.
 */
export async function restoreOpenPositions(strategies: StrategyRuntime[]): Promise<void> {
  const existingPositions = await getOpenPositions()
  if (existingPositions.length === 0) return

  console.log(`Restoring ${existingPositions.length} open positions from previous session...`)
  for (const pos of existingPositions) {
    const runtime = strategies.find(s => s.config.label === pos.strategy)
    if (!runtime) {
      console.warn(`live-scan: no active strategy runtime for restored position ${pos.symbol} (strategy=${pos.strategy}) — skipped`)
      continue
    }
    runtime.broker.restorePosition(pos.tokenAddress, pos.entryPrice, TRADE_AMOUNT_USD / pos.entryPrice)
    priceFeed.subscribe(pos.pairAddress)
    const heldMinutes = Math.round((Date.now() - pos.entryTimestamp) / 60_000)
    console.log(`  ↻ ${pos.symbol} @ $${pos.entryPrice} (${pos.strategy}, tenu depuis ${heldMinutes}min)`)

    // Best-effort liveness check, not a closure decision — a token that's
    // temporarily unquotable (indexer hiccup, momentary rate limit) isn't
    // necessarily dead, so this only logs; checkExits' own price-feed cache
    // decides if/when to actually exit.
    const contract = runtime.broker.resolveNativeKey(pos.tokenAddress)
    const quote = await runtime.broker.getQuote(contract).catch(() => null)
    if (!quote) {
      console.warn(`live-scan: position ${pos.symbol} may be orphaned — token not found on DexScreener at restore time. Will retry on next exit check.`)
    }
  }
}

/**
 * Exit-checking only — no new-token scan, no DexScreener "latest profiles"
 * fetch. Split out from the scan phase (see `runScanPhase`) so the main
 * loop can run this at a much faster cadence than the new-token scan: a
 * position can crash well past its stop-loss between two 30s-spaced polls
 * (confirmed live: -92% in under 90 seconds), and checking exits doesn't
 * carry the same DexScreener "latest profiles" rate-limit cost that
 * scanning for new candidates does.
 */
export async function runExitsPhase(
  chain: DexChain,
  strategies: StrategyRuntime[],
  signal?: AbortSignal,
): Promise<void> {
  for (const { config, broker } of strategies) {
    if (signal?.aborted) break
    await checkExits(chain, broker, config.label, signal)
  }
}

/** New-token scan only — see `runExitsPhase` for why this is split out and run on its own, slower cadence. */
export async function runScanPhase(
  chain: DexChain,
  strategies: StrategyRuntime[],
  rateLimiter: RateLimiter,
  stats: ScanStats,
  signal?: AbortSignal,
): Promise<void> {
  await rateLimiter.throttle(signal)
  const profiles = await fetchLatestTokenProfiles()
  await rateLimiter.recordAndMaybeBackoff(profiles.length === 0, signal)

  const scoped = profiles.filter(p => p.chainId === chain)
  await recordVelocitySnapshot(scoped.length)
  const velocity = await getMarketVelocity()

  const now = Date.now()

  for (const profile of scoped) {
    if (signal?.aborted) break
    await rateLimiter.throttle(signal)
    const pairs = await fetchDexScreenerTokenPairs(profile.chainId, profile.tokenAddress)
    const pair: DexScreenerPair | null = bestPair(pairs)
    if (!pair || !pair.pairCreatedAt) continue

    // Purely additive observability — does not affect what follows. If this
    // exact token was already discovered earlier via HeliusPoolFeed, log
    // how much later the OLD (fetchLatestTokenProfiles-driven) pipeline
    // caught up to it — the production-measured counterpart to
    // heliusPoolWatchlist's own DexScreener-pair-resolution latency log.
    const heliusEntry = heliusPoolWatchlist.get(profile.tokenAddress)
    if (heliusEntry && !heliusEntry.oldPipelineSightingLoggedAt) {
      const elapsedSec = (now - heliusEntry.discoveredAt) / 1000
      console.log(`⚡ Helius pool-feed: ${profile.tokenAddress} — old DexScreener-profiles pipeline caught up ${elapsedSec.toFixed(1)}s after Helius discovery`)
      heliusEntry.oldPipelineSightingLoggedAt = now
    }

    await recordSnapshot(pair)

    const ageMinutes = (now - pair.pairCreatedAt) / 60_000
    stats.scanned++

    const decisions = {} as Record<StrategyLabel, StrategyDecision>
    for (const { config, broker } of strategies) {
      const decision = await evaluateStrategy(config, chain, profile.tokenAddress, ageMinutes, broker, pair)
      decisions[config.label] = decision
      if (decision.pass) stats.passed[config.label]++
    }

    // Observability only — see the section header above detectSilentDistributionPattern
    // for the hypothesis, its retroactive test result, and why this logs
    // every candidate regardless of buy outcome.
    const silentDistMatch = detectSilentDistributionPattern(pair)
    if (silentDistMatch) {
      const passedStrategies = (Object.keys(decisions) as StrategyLabel[]).filter(label => decisions[label]?.pass)
      await appendSilentDistributionLog({
        timestamp: new Date(now).toISOString(),
        tokenAddress: profile.tokenAddress,
        symbol: pair.baseToken.symbol,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        ageMinutes,
        passedStrategies,
        ...silentDistMatch,
      })
    }

    const nameFilter = checkTokenName(pair.baseToken.symbol, pair.baseToken.name)
    const walletSignals = chain === 'solana' ? await getWalletSignals(profile.tokenAddress) : []

    await appendScanLog({
      type: 'scan',
      timestamp: new Date(now).toISOString(),
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken.symbol,
      tokenAddress: profile.tokenAddress,
      ageMinutes,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      priceAtScan: Number(pair.priceUsd ?? 0),
      conservative: decisions.conservative ?? { pass: false, reason: 'not evaluated' },
      early: decisions.early ?? { pass: false, reason: 'not evaluated' },
      momentum: decisions.momentum ?? { pass: false, reason: 'not evaluated' },
      scalp_momentum: decisions.scalp_momentum ?? { pass: false, reason: 'not evaluated' },
      early_strict: decisions.early_strict ?? { pass: false, reason: 'not evaluated' },
      early_web_filtered: decisions.early_web_filtered ?? { pass: false, reason: 'not evaluated' },
      velocityContext: { tokensPerHour: velocity.tokensPerHour, trend: velocity.trend },
      walletSignals,
      nameFilter: { riskScore: nameFilter.riskScore, flags: nameFilter.flags },
      rawData: {
        priceChange: { m5: pair.priceChange?.m5, h1: pair.priceChange?.h1, h6: pair.priceChange?.h6 },
        volume: { m5: pair.volume?.m5, h1: pair.volume?.h1, h6: pair.volume?.h6 },
        txns: { m5: pair.txns?.m5, h1: pair.txns?.h1 },
        liquidityUsd: pair.liquidity?.usd ?? 0,
        ageMinutes,
        pairCreatedAt: pair.pairCreatedAt,
        nameFilter: { riskScore: nameFilter.riskScore, flags: nameFilter.flags },
        walletSignals,
        hasSocials: (pair.info?.socials?.length ?? 0) > 0,
        hasWebsite: (pair.info?.websites?.length ?? 0) > 0,
        boostsActive: pair.boosts?.active,
      },
    })
  }
}

/** Convenience wrapper — runs both phases back to back, in the original single-cadence order. Kept for callers (and tests) that don't need the two phases decoupled. */
export async function runCycle(
  chain: DexChain,
  strategies: StrategyRuntime[],
  rateLimiter: RateLimiter,
  stats: ScanStats,
  signal?: AbortSignal,
): Promise<void> {
  await runExitsPhase(chain, strategies, signal)
  await runScanPhase(chain, strategies, rateLimiter, stats, signal)
}

// ==================== Pump.fun watchlist (Phase 2, surveillance mode) ====================
// See pump-fun-feed.ts's file header for why this is pumpportal.fun, not
// pump.fun's own API. Surveillance only: tokens are logged and evaluated
// for observability, never bought here — see the commented-out "immediate
// buy" mode below for why that's deliberately not wired up yet.

export interface WatchlistEntry {
  detectedAt: number
  symbol: string
  mintAddress: string
}

const WATCHLIST_CHECK_INTERVAL_MS = 60_000
const MAX_WATCH_MINUTES = 20
const WATCHLIST_STALE_MS = MAX_WATCH_MINUTES * 60_000
const WATCHLIST_INDEXED_MIN_LIQUIDITY_USD = 8000
/** Hard cap — an unbounded watchlist means an unbounded number of DexScreener
 *  calls per check cycle (each entry got its own request before batching was
 *  added). FIFO eviction on overflow: the oldest, least-likely-still-relevant
 *  detection is dropped first. */
const MAX_WATCHLIST_SIZE = 50

export const pumpWatchlist = new Map<string, WatchlistEntry>()

/**
 * Called for every pump.fun token creation event. Logs it, records a
 * zero-liquidity opening snapshot (the token has no real pool yet — this
 * just seeds liquidity-tracker's history so a growth signal is available
 * once it does get one), and adds it to the in-memory watchlist for
 * `checkPumpWatchlist` to periodically follow up on. Never throws — a
 * snapshot failure is logged and swallowed, matching this feed's "never
 * crash the main scanner" contract (see pump-fun-feed.ts's file header).
 */
export async function handleNewPumpToken(token: PumpFunToken): Promise<void> {
  // Dedup against the Helius pool feed below — see its own handleNewHeliusPool
  // for the symmetric check. Both are independent pump.fun-origin detection
  // mechanisms; without this, a token caught by one moments before the
  // other would be tracked/logged twice as if it were two separate finds.
  if (heliusPoolWatchlist.has(token.mintAddress)) return
  console.log(`🆕 ${token.symbol} — mint: ${token.mintAddress}`)
  try {
    await recordSnapshot({
      chainId: 'solana',
      pairAddress: token.mintAddress,
      baseToken: { address: token.mintAddress, symbol: token.symbol, name: token.name },
      quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL' },
      liquidity: { usd: 0 },
    })
  } catch (err) {
    console.warn(`live-scan: failed to record initial pump.fun snapshot for ${token.symbol} — ${err instanceof Error ? err.message : String(err)}`)
  }
  while (pumpWatchlist.size >= MAX_WATCHLIST_SIZE) {
    const oldestMint = pumpWatchlist.keys().next().value
    if (oldestMint === undefined) break
    const evicted = pumpWatchlist.get(oldestMint)
    pumpWatchlist.delete(oldestMint)
    console.log(`live-scan: pump.fun watchlist full (${MAX_WATCHLIST_SIZE}) — evicting oldest: ${evicted?.symbol ?? oldestMint}`)
  }
  pumpWatchlist.set(token.mintAddress, { detectedAt: token.createdAt, symbol: token.symbol, mintAddress: token.mintAddress })
}

/**
 * Runs on its own ~60s cadence (see runLiveScan's main loop) — checks every
 * watchlist entry against DexScreener in ONE batched call (see
 * `fetchDexScreenerTokensBatch`) rather than one request per entry, which is
 * what made this scale linearly with watchlist size and drive real 429s
 * once the list passed a few hundred entries. Indexed + liquid enough →
 * evaluated via `checkTokenSecurity` for observability (logged, never
 * bought — surveillance mode) and removed either way (one evaluation is
 * enough; it's not re-checked every cycle after that). Still unindexed past
 * WATCHLIST_STALE_MS → removed as stillborn. Any exception removes the
 * entry rather than risk it wedging the watchlist forever or crashing the
 * scanner — see file header.
 */
export async function checkPumpWatchlist(chain: DexChain): Promise<void> {
  const now = Date.now()
  const mints = [...pumpWatchlist.keys()]
  if (mints.length === 0) return

  // A batch failure isn't specific to any one token — unlike a per-entry
  // exception below, it says nothing about whether any given token deserves
  // eviction. Same "log + skip cycle + retry next" contract as the rest of
  // this scanner's DexScreener error handling: leave the watchlist untouched.
  let batch: Map<string, DexScreenerPair[]>
  try {
    batch = await fetchDexScreenerTokensBatch(chain, mints)
  } catch (err) {
    console.warn(`live-scan: pump.fun watchlist batch check failed — ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  for (const [mint, entry] of pumpWatchlist) {
    try {
      const pair = bestPair(batch.get(mint) ?? [])
      const liquidityUsd = pair?.liquidity?.usd ?? 0

      if (pair && liquidityUsd > WATCHLIST_INDEXED_MIN_LIQUIDITY_USD) {
        const security = await checkTokenSecurity(chain, mint, EARLY_CONFIG, pair)
        console.log(`live-scan: pump.fun watchlist — ${entry.symbol} indexed, liquidity=$${liquidityUsd.toFixed(0)}, security=${security.passed ? 'PASS' : `REJECT: ${security.reasons.join('; ')}`}`)
        pumpWatchlist.delete(mint)
      } else if (now - entry.detectedAt > WATCHLIST_STALE_MS) {
        console.log(`live-scan: pump.fun watchlist — ${entry.symbol} never indexed after ${MAX_WATCH_MINUTES}min, removing (stillborn)`)
        pumpWatchlist.delete(mint)
      }
      // else: not yet indexed and not yet stale — leave it for the next cycle.
    } catch (err) {
      console.warn(`live-scan: pump.fun watchlist check failed for ${entry.symbol} — ${err instanceof Error ? err.message : String(err)}`)
      pumpWatchlist.delete(mint)
    }
  }
}

// Mode achat immédiat — TODO Phase suivante, pas actif.
// Nécessite : pattern de liquidité initiale > $20k ET vérification on-chain
// mint authority immédiate. Risque élevé — activer uniquement après
// validation du mode surveillance sur 7 jours de données réelles.
// async function buyImmediatelyOnPumpDetection(token: PumpFunToken): Promise<void> { ... }

// ==================== Helius pool-creation feed (surveillance mode, latency measurement) ====================
// Adopted 2026-07-02 — see helius-pool-feed.ts's file header for the live
// latency measurement that motivated this (2.9s on-chain->WebSocket vs the
// existing pipeline's 10.78min median). Surveillance only, same posture as
// the pump.fun watchlist above: never calls evaluateStrategy() or
// openPosition() — this section exists purely to log how much sooner a
// pool WOULD have been actionable through this channel, not to act on it.

export interface HeliusWatchlistEntry {
  discoveredAt: number
  mintAddress: string
  /** Set once the DexScreener-pair-resolution latency has been logged, so a later cycle doesn't log it again for the same entry. */
  pairResolutionLoggedAt?: number
  /** Set once this mint has also been seen through the existing fetchLatestTokenProfiles()-driven pipeline, so runScanPhase's cross-check only logs the comparison once. */
  oldPipelineSightingLoggedAt?: number
}

const HELIUS_WATCHLIST_CHECK_INTERVAL_MS = 60_000
const HELIUS_WATCHLIST_STALE_MS = MAX_WATCH_MINUTES * 60_000
/** Same rationale as MAX_WATCHLIST_SIZE above — bounds the batch DexScreener call size per check cycle. */
const MAX_HELIUS_WATCHLIST_SIZE = 50

export const heliusPoolWatchlist = new Map<string, HeliusWatchlistEntry>()

/**
 * Called for every pool creation detected via `HeliusPoolFeed`. Deduplicates
 * against the pump.fun (pumpportal.fun) watchlist above — both are
 * independent pump.fun-origin detection mechanisms, and a token caught by
 * one moments before the other would otherwise get logged/tracked twice as
 * if it were two separate discoveries.
 */
export function handleNewHeliusPool(pool: DiscoveredPool): void {
  if (pumpWatchlist.has(pool.mintAddress) || heliusPoolWatchlist.has(pool.mintAddress)) return
  console.log(`⚡ Helius pool-feed: new pool — mint: ${pool.mintAddress} (sig ${pool.signature.slice(0, 12)}...)`)
  while (heliusPoolWatchlist.size >= MAX_HELIUS_WATCHLIST_SIZE) {
    const oldestMint = heliusPoolWatchlist.keys().next().value
    if (oldestMint === undefined) break
    heliusPoolWatchlist.delete(oldestMint)
    console.log(`live-scan: Helius pool watchlist full (${MAX_HELIUS_WATCHLIST_SIZE}) — evicting oldest: ${oldestMint}`)
  }
  heliusPoolWatchlist.set(pool.mintAddress, { discoveredAt: pool.discoveredAt, mintAddress: pool.mintAddress })
}

/**
 * Runs on its own ~60s cadence (see runLiveScan's main loop) — batch-checks
 * every entry against DexScreener (same `fetchDexScreenerTokensBatch` used
 * by the pump.fun watchlist). The FIRST time a pair resolves, logs the real
 * discovery-to-queryable latency this feed achieved — this is the
 * production-measured counterpart to the one-off live test from
 * 2026-07-02's feasibility analysis. Entries are removed once both possible
 * comparisons (pair resolution here, old-pipeline sighting in
 * runScanPhase) have been logged, or after MAX_WATCH_MINUTES with neither —
 * same stillborn handling as the pump.fun watchlist.
 */
export async function checkHeliusPoolWatchlist(chain: DexChain): Promise<void> {
  const now = Date.now()
  const mints = [...heliusPoolWatchlist.keys()]
  if (mints.length === 0) return

  let batch: Map<string, DexScreenerPair[]>
  try {
    batch = await fetchDexScreenerTokensBatch(chain, mints)
  } catch (err) {
    console.warn(`live-scan: Helius pool watchlist batch check failed — ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  for (const [mint, entry] of heliusPoolWatchlist) {
    try {
      const pair = bestPair(batch.get(mint) ?? [])
      if (pair && !entry.pairResolutionLoggedAt) {
        const elapsedSec = (now - entry.discoveredAt) / 1000
        console.log(`⚡ Helius pool-feed: ${mint} — DexScreener pair resolved ${elapsedSec.toFixed(1)}s after Helius discovery`)
        entry.pairResolutionLoggedAt = now
      }
      const bothLogged = entry.pairResolutionLoggedAt != null && entry.oldPipelineSightingLoggedAt != null
      const stale = now - entry.discoveredAt > HELIUS_WATCHLIST_STALE_MS
      if (bothLogged || stale) {
        if (stale && !bothLogged) {
          console.log(`live-scan: Helius pool watchlist — ${mint} stale after ${MAX_WATCH_MINUTES}min (pairResolutionLogged=${!!entry.pairResolutionLoggedAt}, oldPipelineSightingLogged=${!!entry.oldPipelineSightingLoggedAt}), removing`)
        }
        heliusPoolWatchlist.delete(mint)
      }
    } catch (err) {
      console.warn(`live-scan: Helius pool watchlist check failed for ${mint} — ${err instanceof Error ? err.message : String(err)}`)
      heliusPoolWatchlist.delete(mint)
    }
  }
}

// ==================== Graduation strategies (GRAD_IMMEDIATE / GRAD_DIP) ====================
// Adopted 2026-07-02: `helius-pool-feed.ts`'s onGraduation callback (Migrate
// instruction, same subscription as CreateV2 — see that file's header) is
// the trigger for both strategies below. Neither goes through
// evaluateStrategy()/checkTokenSecurity()'s age-window candidate loop —
// GRAD_IMMEDIATE buys directly off the graduation event itself,
// GRAD_DIP polls graduatedTracker's already-graduated set on its own 30s
// cadence — so neither is added to the `strategies: StrategyRuntime[]`
// array runScanPhase iterates (see gradStrategies in runLiveScan).

const GRAD_IMMEDIATE_POST_GRAD_DELAY_MS = 90_000
const GRAD_DIP_CHECK_INTERVAL_MS = 30_000
const GRAD_DIP_GOPLUS_AGE_MS = 30 * 60_000
/**
 * Adopted 2026-07-02, urgent fix, originally scoped to GRAD_IMMEDIATE only:
 * the main loop's exit checks only run once per `intervalSeconds` (300s by
 * default) — file header claims exits run "every tick, fast," but the tick
 * rate itself IS `intervalSeconds`, so on a default run that's still only
 * every 300s. Live evidence forced the fix: 5 GRAD_IMMEDIATE positions in
 * one hour closed 25-74pp past the configured -20% stopLoss (Guy -78.5%,
 * CLAUDISH -83.6%, nope -88.5%, TRADE -49.2%, TRADE -93.8%) because nothing
 * looked at their price for up to 614s.
 *
 * Extended the same day to EARLY and EARLY_STRICT after cross-referencing
 * the session's own 14 previously-analyzed EARLY "rugs" (returnPct<-50%)
 * against real scan-log price ticks (not just holding-time inference): 7 of
 * those 14 have a DIRECTLY OBSERVED intermediate tick showing the position
 * was still safe (0% to +58%) shortly before crashing to -51%..-99% — e.g.
 * empire: +5.9% at 19:15:38 -> -91.5% by 19:17:27, a 109-SECOND collapse
 * that a 300s check window could not have caught mid-fall. Capping just
 * those 7 confirmed cases at exactly -20% (their configured stopLoss, had
 * it fired promptly) moves EARLY's full-history aggregate mean return from
 * -3.374% to -2.620% (n=572) — a modest but real +0.754pp aggregate gain,
 * with per-trade gains up to +78.8pp (ROBINSEM, -98.8% -> -20%). The
 * remaining 7 rugs are NOT covered by this evidence: 4 (brokn, Skimi, cat,
 * 黑牛模式) crashed in <1.3min with peakPrice==entryPrice — genuine
 * no-recoverable-window rugs where even instant detection changes nothing;
 * 3 (ANSEM, devwork, LOOT) have zero intermediate scan-log ticks at all —
 * genuinely undetermined, not evidence either way. Worth re-examining if
 * similar undetermined cases recur under this fast-regime fix (see
 * `fastExitRegime` on OpenPosition for how to isolate genuinely-new,
 * uncontaminated cases going forward).
 *
 * checkExits() itself does ZERO network calls — it only reads
 * dex-price-feed.ts's cache (refreshed every 3s independently, see that
 * file's DEFAULT_BATCH_INTERVAL_MS) — its own docstring already describes
 * it as "affordable to run every few seconds." 5s guarantees picking up
 * essentially every fresh price tick from that 3s cache with no added
 * network/RPC cost, for however many strategies share this one timer.
 *
 * CONSERVATIVE and GRAD_DIP deliberately still use the slow 300s cadence —
 * no equivalent stop_loss-overshoot evidence was found for either (see the
 * 2026-07-02 holding-time survey: CONSERVATIVE's fast closes are 100%
 * momentum_reversal, no stop_loss overshoot; GRAD_DIP had 0/18 trades close
 * under 5min at all). GRAD_DIP also already requires liquidity>=15k and
 * priceChange.m5>0 at buy time, a materially calmer entry profile than
 * GRAD_IMMEDIATE's 90s-post-graduation blind buy or EARLY's momentum-driven
 * one — not a strategy to fold in preemptively without its own evidence.
 */
const FAST_EXIT_CHECK_INTERVAL_MS = 5_000

/**
 * Strategies whose positions are checked on the fast independent timer
 * above rather than the main loop's slow `intervalSeconds` cadence — see
 * FAST_EXIT_CHECK_INTERVAL_MS's docstring for the per-strategy evidence.
 * Single source of truth for both `openPosition`'s `fastExitRegime` stamp
 * (evaluateStrategy's buy path and executeGradBuy) and runLiveScan's own
 * strategy-list split, so the two can never drift out of sync.
 * `early_web_filtered` included from its adoption (2026-07-03) — same
 * crash-speed risk applies regardless of its entry filter, see
 * EARLY_WEB_FILTERED_CONFIG's docstring.
 */
const FAST_EXIT_REGIME_LABELS: ReadonlySet<StrategyLabel> = new Set(['early', 'early_strict', 'early_web_filtered', 'grad_immediate'])

function isFastExitRegimeStrategy(label: StrategyLabel): boolean {
  return FAST_EXIT_REGIME_LABELS.has(label)
}

/** Shared buy execution — same pattern as evaluateStrategy's buy path (resolveNativeKey/Order/placeOrder/openPosition/priceFeed.subscribe), reused here since neither GRAD strategy goes through evaluateStrategy itself. `ageMinutes` here means time-since-graduation, not time-since-creation — see GRAD_DIP's docstring for why that distinction matters for this pair of strategies specifically. */
async function executeGradBuy(
  chain: DexChain,
  broker: DexBroker,
  pair: DexScreenerPair,
  strategyLabel: StrategyLabel,
  exitConfig: PositionExitConfig,
  ageMinutes: number,
): Promise<boolean> {
  const tokenAddress = pair.baseToken.address
  const contract = broker.resolveNativeKey(tokenAddress)
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.cashQty = new Decimal(TRADE_AMOUNT_USD)
  const result = await broker.placeOrder(contract, order, undefined, pair)
  if (!result.success) return false

  const entryPrice = Number(pair.priceUsd ?? 0)
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    console.warn(`live-scan: ${strategyLabel} buy filled for ${tokenAddress} but pair.priceUsd was unusable — position not recorded in position-tracker`)
    return true
  }
  const buyerWallets = chain === 'solana' ? await getRecentBuyers(tokenAddress) : []
  // grad_dip is NOT in FAST_EXIT_REGIME_LABELS (see that constant's
  // docstring) — this correctly stays undefined for it, not `true`. See
  // OpenPosition.fastExitRegime's docstring for why undefined (not `false`)
  // is the deliberate "not fast-regime" value.
  const fastExitRegime = isFastExitRegimeStrategy(strategyLabel) ? true : undefined
  await openPosition(pair, strategyLabel, entryPrice, ageMinutes, exitConfig, buyerWallets, fastExitRegime)
  priceFeed.subscribe(pair.pairAddress)
  return true
}

/**
 * Triggered directly from HeliusPoolFeed's onGraduation callback — waits
 * GRAD_IMMEDIATE_POST_GRAD_DELAY_MS for the new PumpSwap pool to settle and
 * become DexScreener-queryable (see the 2026-07-02 latency measurements in
 * helius-pool-feed.ts's header: DexScreener indexing was observed <=38s
 * after a CreateV2 event — 90s is a deliberate margin above that single
 * sample, not itself independently measured for Migrate specifically), then
 * runs a deliberately MINIMAL check set (no GoPlus — the token is seconds
 * old on this new pool, GoPlus has certainly not indexed it yet) before
 * buying. `abortSignal` lets a scanner shutdown cancel the 90s wait rather
 * than block it.
 */
export async function handleGradImmediate(
  chain: DexChain,
  event: GraduationEvent,
  broker: DexBroker,
  abortSignal?: AbortSignal,
): Promise<void> {
  await sleep(GRAD_IMMEDIATE_POST_GRAD_DELAY_MS, abortSignal)
  if (abortSignal?.aborted) return

  const pair = await fetchPairForMint(event.mintAddress, chain)
  if (!pair) {
    console.log(`GRAD_IMMEDIATE: ${event.mintAddress} not yet indexed on PumpSwap after ${GRAD_IMMEDIATE_POST_GRAD_DELAY_MS / 1000}s`)
    return
  }

  const liquidityUsd = pair.liquidity?.usd ?? 0
  if (liquidityUsd < 10_000) {
    console.log(`GRAD_IMMEDIATE: ${pair.baseToken.symbol} liquidity too low ($${liquidityUsd.toFixed(0)} < $10,000) — skip`)
    return
  }
  const m5 = pair.priceChange?.m5
  if (m5 != null && m5 < -25) {
    console.log(`GRAD_IMMEDIATE: ${pair.baseToken.symbol} already crashing (m5 ${m5.toFixed(1)}%) — skip`)
    return
  }

  const rpcCheck = await checkMintAuthority(event.mintAddress, { endpoint: defaultSolanaRpcEndpoint() })
  if (rpcCheck.rpcAvailable && (rpcCheck.hasMintAuthority || rpcCheck.hasFreezeAuthority)) {
    console.log(`GRAD_IMMEDIATE: ${pair.baseToken.symbol} mint/freeze authority active — skip`)
    return
  }

  const ageMinutes = (Date.now() - event.graduatedAt) / 60_000
  const bought = await executeGradBuy(chain, broker, pair, 'grad_immediate', GRAD_IMMEDIATE_EXIT_CONFIG, ageMinutes)
  if (bought) console.log(`GRAD_IMMEDIATE: bought ${pair.baseToken.symbol} (liq $${liquidityUsd.toFixed(0)})`)
}

/**
 * Runs on its own GRAD_DIP_CHECK_INTERVAL_MS (30s) cadence from the main
 * loop — first refreshes every currently-tracked graduated token's price
 * (so `getEligibleForDip()` reflects current data, not stale snapshots from
 * whenever each token last happened to be checked), then re-fetches a live
 * pair only for the dip-range subset to apply the deeper checks.
 *
 * `ageMinutes` passed to `checkTokenSecurity`/`openPosition` is time SINCE
 * GRADUATION, not time since the token's original pump.fun creation — the
 * bonding-curve age is irrelevant here (this strategy only cares how long
 * the token has existed as a PumpSwap-traded asset), and `requireGoPlus`
 * only turns on once 30min have passed since graduation (GoPlus needs time
 * to index a pool that's brand new from its perspective too, same
 * reasoning as GRAD_IMMEDIATE skipping it entirely for the first 90s).
 *
 * "Volume h1 croissant" from the original spec is simplified to "h1 volume
 * is present and positive" — this tracker doesn't retain a prior volume
 * reading per token, so an actual growth comparison isn't available;
 * documented here rather than fabricating a trend from a single sample.
 */
export async function handleGradDip(
  chain: DexChain,
  broker: DexBroker,
  tracker: GraduatedTokensTracker,
): Promise<{ watched: number; bought: number }> {
  await tracker.cleanup()

  for (const token of tracker.getAll()) {
    const pair = await fetchPairForMint(token.mintAddress, chain)
    if (!pair) continue
    const price = Number(pair.priceUsd ?? 0)
    if (Number.isFinite(price) && price > 0) {
      await tracker.updatePrice(token.mintAddress, price, pair.liquidity?.usd ?? 0, { pairAddress: pair.pairAddress })
    }
  }

  const candidates = tracker.getEligibleForDip()
  let boughtCount = 0

  for (const token of candidates) {
    // Fixed 2026-07-03: getEligibleForDip() is a pure price-range filter with
    // no memory of prior buys, and (unlike evaluateStrategy()'s buy path)
    // this loop never checked hasOpenPosition() before executeGradBuy() — so
    // a token sitting in the -25%/-60% dip band across consecutive 30s
    // cycles got bought again on every cycle, stacking concurrent positions
    // on the same mint instead of one buy followed by a real re-entry after
    // that position closed. Confirmed live: 8 tokens with overlapping
    // (not just repeated) entry/exit windows, up to 4 simultaneous open
    // positions on the same mint (Anthar, 2026-07-02 20:25-23:37).
    if (await hasOpenPosition(broker, token.mintAddress)) continue

    const pair = await fetchPairForMint(token.mintAddress, chain)
    if (!pair) continue

    const liquidityUsd = pair.liquidity?.usd ?? 0
    if (liquidityUsd < 15_000) continue

    const m5 = pair.priceChange?.m5
    if (m5 == null || m5 <= 0) continue // "rebondit maintenant" — must be positive right now, not just past the dip floor

    const h1Volume = pair.volume?.h1
    if (h1Volume == null || h1Volume <= 0) continue // see docstring — "volume croissant" simplified to "real volume present"

    const ageMinutesSinceGrad = (Date.now() - token.graduatedAt) / 60_000
    const gradDipSecurityConfig: TokenSecurityConfig = {
      minLiquidityUsd: 15_000,
      requireGoPlus: token.graduatedAt < Date.now() - GRAD_DIP_GOPLUS_AGE_MS,
      rejectIfHoneypot: true,
      rejectIfMintable: true,
      rejectIfOwnerCanBlacklist: true,
      rejectIfHighTax: true,
    }
    const security = await checkTokenSecurity(chain, token.mintAddress, gradDipSecurityConfig, pair)
    if (!security.passed) {
      console.log(`GRAD_DIP: ${pair.baseToken.symbol} failed security check — ${security.reasons.join('; ')}`)
      continue
    }

    const bought = await executeGradBuy(chain, broker, pair, 'grad_dip', GRAD_DIP_EXIT_CONFIG, ageMinutesSinceGrad)
    if (bought) {
      boughtCount++
      console.log(`GRAD_DIP: bought ${pair.baseToken.symbol} (dip from peak, liq $${liquidityUsd.toFixed(0)})`)
    }
  }

  return { watched: candidates.length, bought: boughtCount }
}

// ==================== Summary ====================

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}

const REASON_COUNT_LABELS: Array<[ExitReason, string]> = [
  ['stop_loss', 'stop_loss'],
  ['trailing_stop', 'trailing'],
  ['take_profit', 'profit'],
  ['time_exit', 'time'],
  ['momentum_reversal', 'reversal'],
  ['liquidity_drain', 'drain'],
]

/** Closed-today positions for one strategy label, with win rate/avg return — shared by the GRAD_IMMEDIATE/GRAD_DIP summary sections below. */
function summarizeClosedFor(closedToday: Awaited<ReturnType<typeof getClosedToday>>, label: StrategyLabel): { count: number; winRate: number | null; avgReturn: number | null } {
  const trades = closedToday.filter(t => t.strategy === label)
  if (trades.length === 0) return { count: 0, winRate: null, avgReturn: null }
  const wins = trades.filter(t => t.returnPct > 0).length
  const avgReturn = trades.reduce((a, t) => a + t.returnPct, 0) / trades.length
  return { count: trades.length, winRate: (wins / trades.length) * 100, avgReturn }
}

export async function logSummary(
  label: string,
  strategies: StrategyRuntime[],
  stats: ScanStats,
  heliusPoolFeed?: HeliusPoolFeed | null,
  gradStrategies: StrategyRuntime[] = [],
  graduatedTracker?: GraduatedTokensTracker,
): Promise<void> {
  const velocity = await getMarketVelocity()
  const openPositions = await getOpenPositions()
  const dailyStats = await getDailyStats()
  const walletSummary = await getTrackedWalletSummary()
  const allRuntimes = [...strategies, ...gradStrategies]

  console.log(`\n${'='.repeat(70)}`)
  console.log(`=== Scan summary — ${label} ===`)
  console.log(`Cycles ce run   : ${stats.cycles}  |  Tokens évalués : ${stats.scanned}  |  Vélocité : ~${velocity.tokensPerHour.toFixed(0)}/h (${velocity.trend})`)
  console.log(`Stop_loss overshoots significatifs (>${STOP_LOSS_OVERSHOOT_ALERT_PP}pp au-delà du seuil configuré) depuis le dernier résumé : ${stopLossOvershootCount}`)
  console.log('')
  for (const { config } of strategies) {
    console.log(`Filtres ${config.label.toUpperCase().padEnd(11)}: ${stats.passed[config.label]} passés / ${stats.scanned} évalués`)
  }

  console.log(`\n=== Positions ouvertes (${openPositions.length}) ===`)
  for (const position of openPositions) {
    const runtime = allRuntimes.find(s => s.config.label === position.strategy)
    let currentPrice = position.peakPrice
    if (runtime) {
      try {
        const quote = await runtime.broker.getQuote(runtime.broker.resolveNativeKey(position.tokenAddress))
        currentPrice = Number(quote.last)
      } catch {
        // keep peakPrice fallback for display purposes only
      }
    }
    const returnPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    const peakPct = ((position.peakPrice - position.entryPrice) / position.entryPrice) * 100
    const holdingMinutes = (Date.now() - position.entryTimestamp) / 60_000
    console.log(`${position.symbol}  ${position.strategy}  ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%  peak ${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(1)}%  tenu ${formatDuration(holdingMinutes)}`)
  }

  console.log(`\n=== Fermées aujourd'hui (${dailyStats.totalClosed}) ===`)
  if (dailyStats.totalClosed > 0) {
    const closedToday = await getClosedToday()
    const best = closedToday.reduce((a, b) => (b.returnPct > a.returnPct ? b : a))
    const worst = closedToday.reduce((a, b) => (b.returnPct < a.returnPct ? b : a))
    console.log(`Win rate   : ${(dailyStats.winRate * 100).toFixed(1)}%`)
    console.log(`Retour moy : ${dailyStats.avgReturn >= 0 ? '+' : ''}${dailyStats.avgReturn.toFixed(1)}%`)
    console.log(`Meilleur   : ${best.returnPct >= 0 ? '+' : ''}${best.returnPct.toFixed(1)}% ${best.symbol} ${best.holdingMinutes.toFixed(0)}min [${best.exitReason}]`)
    console.log(`Pire       : ${worst.returnPct >= 0 ? '+' : ''}${worst.returnPct.toFixed(1)}% ${worst.symbol} ${worst.holdingMinutes.toFixed(0)}min [${worst.exitReason}]`)
    const reasonsLine = REASON_COUNT_LABELS.map(([key, display]) => `${display} ${dailyStats.byReason[key]}`).join(' | ')
    console.log(`Raisons    : ${reasonsLine}`)
  }

  console.log(`\nWallets trackés : ${walletSummary.total}  |  Avec signal (≥5 trades, ≥60% WR) : ${walletSummary.withSignal}`)

  console.log(`\n=== Pump.fun watchlist (${pumpWatchlist.size} tokens) ===`)
  for (const entry of pumpWatchlist.values()) {
    const detectedMinAgo = (Date.now() - entry.detectedAt) / 60_000
    const pair = bestPair(await fetchDexScreenerTokenPairs('solana', entry.mintAddress))
    const liquidityUsd = pair?.liquidity?.usd ?? 0
    const status = pair ? 'indexé' : 'en attente'
    console.log(`${entry.symbol}  détecté il y a ${detectedMinAgo.toFixed(0)}min  liquidité: $${liquidityUsd.toFixed(0)}  [${status}]`)
  }

  if (heliusPoolFeed) {
    // Credit-consumption visibility (point 6 of the 2026-07-02 feasibility
    // analysis): getTransaction calls are this feed's real Helius-credit
    // cost, distinct from the always-on (free-to-receive) WebSocket
    // firehose — surfaced here rather than a live remaining-balance check
    // (no existing module in this codebase queries Helius's account/billing
    // API, and adding that is out of scope for this prototype).
    console.log(`\n=== Helius pool feed (${heliusPoolWatchlist.size} en surveillance) ===`)
    console.log(`getTransaction appelés depuis le démarrage : ${heliusPoolFeed.getTransactionCallsMade()}`)
  }

  if (graduatedTracker) {
    const graduated = graduatedTracker.getAll()
    const closedToday = await getClosedToday()
    const openTokens = new Set(openPositions.filter(p => p.strategy === 'grad_immediate' || p.strategy === 'grad_dip').map(p => p.tokenAddress))
    const closedTokens = new Set(closedToday.filter(t => t.strategy === 'grad_immediate' || t.strategy === 'grad_dip').map(t => t.tokenAddress))
    const dipCandidates = new Set(graduatedTracker.getEligibleForDip().map(t => t.mintAddress))

    console.log(`\n=== Graduations détectées (${graduated.length} aujourd'hui) ===`)
    for (const token of graduated) {
      const minAgo = (Date.now() - token.graduatedAt) / 60_000
      const bought = openTokens.has(token.mintAddress) || closedTokens.has(token.mintAddress)
      // "en attente" is a heuristic, not a persisted decision trail: still
      // within GRAD_IMMEDIATE's own delay window, or currently in GRAD_DIP's
      // dip range and therefore a live candidate on the next 30s check.
      const stillPending = !bought && (minAgo * 60_000 < GRAD_IMMEDIATE_POST_GRAD_DELAY_MS || dipCandidates.has(token.mintAddress))
      const status = bought ? 'acheté' : stillPending ? 'en attente' : 'skippé'
      const liquidityUsd = token.pairAddress ? (bestPair(await fetchDexScreenerTokenPairs('solana', token.mintAddress))?.liquidity?.usd ?? 0) : 0
      console.log(`${token.symbol ?? token.mintAddress.slice(0, 8)}  il y a ${minAgo.toFixed(0)}min  liq: $${liquidityUsd.toFixed(0)}  [${status}]`)
    }

    const gradImmediateSummary = summarizeClosedFor(closedToday, 'grad_immediate')
    console.log(`\n=== GRAD_IMMEDIATE — ${gradImmediateSummary.count} trades ===`)
    console.log(`Win rate: ${gradImmediateSummary.winRate != null ? gradImmediateSummary.winRate.toFixed(1) + '%' : 'n/a'}  Retour moy: ${gradImmediateSummary.avgReturn != null ? (gradImmediateSummary.avgReturn >= 0 ? '+' : '') + gradImmediateSummary.avgReturn.toFixed(1) + '%' : 'n/a'}`)

    const gradDipSummary = summarizeClosedFor(closedToday, 'grad_dip')
    console.log(`\n=== GRAD_DIP — ${gradDipSummary.count} trades ===`)
    console.log(`Win rate: ${gradDipSummary.winRate != null ? gradDipSummary.winRate.toFixed(1) + '%' : 'n/a'}  Retour moy: ${gradDipSummary.avgReturn != null ? (gradDipSummary.avgReturn >= 0 ? '+' : '') + gradDipSummary.avgReturn.toFixed(1) + '%' : 'n/a'}`)
    console.log(`Dips surveillés: ${dipCandidates.size}  Achetés: ${gradDipSummary.count}`)
  }

  console.log('='.repeat(70))
}

// ==================== Heartbeat ====================

function heartbeatPath(): string {
  return dataPath('scanner.heartbeat.json')
}

/**
 * Written every ~60s from the main loop so an external process can tell
 * "scanner is alive and cycling" from "scanner is hung in a blocked loop
 * without having crashed" — a crash is visible in the process list/logs,
 * a silently stuck loop is not. Best-effort: a failed write is logged and
 * swallowed, same convention as every other file write in this scanner —
 * a missed heartbeat tick must never be what takes the scanner down.
 */
export async function writeHeartbeat(cycleCount: number): Promise<void> {
  try {
    const openPositions = await getOpenPositions()
    const filePath = heartbeatPath()
    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.tmp`
    await writeFile(tmpPath, JSON.stringify({
      pid: process.pid,
      lastAliveAt: Date.now(),
      openPositions: openPositions.length,
      cycleCount,
      uptime: process.uptime(),
    }, null, 2), 'utf-8')
    await rename(tmpPath, filePath)
  } catch (err) {
    console.warn(`live-scan: failed to write heartbeat — ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ==================== CLI entry ====================

export function parseArgs(argv: string[]): { chain: DexChain; intervalSeconds: number; scanIntervalSeconds: number } {
  let chain: DexChain = 'solana'
  let intervalSeconds = 300
  // Default matches `intervalSeconds`'s old, pre-split meaning (new-token
  // scan and exit-check shared one cadence) — explicit --scan-interval
  // decouples them. See runExitsPhase/runScanPhase's docstrings for why.
  let scanIntervalSeconds: number | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--chain') {
      const v = argv[++i]
      if (v === 'solana' || v === 'ethereum' || v === 'base' || v === 'bsc') chain = v
      else throw new Error(`Invalid --chain "${v}"`)
    } else if (argv[i] === '--interval') {
      const v = Number(argv[++i])
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid --interval "${argv[i]}"`)
      intervalSeconds = v
    } else if (argv[i] === '--scan-interval') {
      const v = Number(argv[++i])
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid --scan-interval "${argv[i]}"`)
      scanIntervalSeconds = v
    }
  }
  return { chain, intervalSeconds, scanIntervalSeconds: scanIntervalSeconds ?? intervalSeconds }
}

export async function runLiveScan(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { chain, intervalSeconds, scanIntervalSeconds } = parseArgs(argv)
  console.log(`live-scan: starting on chain=${chain}, exit-check interval=${intervalSeconds}s, new-token scan interval=${scanIntervalSeconds}s (paper mode, 4 strategies)`)
  console.log(process.env['HELIUS_API_KEY'] ? 'RPC: Helius (dedicated)' : 'RPC: Solana public (rate-limited — set HELIUS_API_KEY)')
  // process.pid is Node's own real OS PID — unlike a bash `$!` for a directly
  // exec'd native process on Windows/Git-Bash, this is always accurate.
  console.log(`Scanner PID: ${process.pid} (use this to stop cleanly)`)
  await clearStaleLockIfPresent()

  // WebSocket DexScreener is confirmed dead (Cloudflare bot-protection 403 —
  // see dex-price-feed.ts's file header) — batch HTTP is the only mode this
  // build supports, not a runtime fallback choice.
  priceFeed.setChain(chain)
  console.log('Price feed   : Batch HTTP toutes les 3s')
  console.log(`Exit checker : every ${intervalSeconds}s (lecture cache) — conservative, grad_dip`)
  console.log(`Exit checker (fast) : every ${FAST_EXIT_CHECK_INTERVAL_MS / 1000}s (lecture cache, coût réseau nul) — early, early_strict, early_web_filtered, grad_immediate`)
  console.log(`Token scanner: every ${scanIntervalSeconds}s`)
  console.log('Pump.fun feed : pumpportal.fun (third-party relay)')
  console.log('              ⚠ Not affiliated with pump.fun')
  console.log('              Fallback: DexScreener polling (existing token scanner)')
  console.log(`Pump.fun watchlist : max ${MAX_WATCHLIST_SIZE} tokens, ${MAX_WATCH_MINUTES}min TTL`)
  const heliusKeyPresent = !!process.env['HELIUS_API_KEY']
  console.log(heliusKeyPresent
    ? `Helius pool feed : wss://mainnet.helius-rpc.com (logsSubscribe, pump.fun CreateV2) — surveillance only, max ${MAX_HELIUS_WATCHLIST_SIZE} tokens, ${MAX_WATCH_MINUTES}min TTL`
    : 'Helius pool feed : disabled — no HELIUS_API_KEY (public RPC has no realistic WebSocket firehose budget for this)')
  console.log(heliusKeyPresent
    ? 'Graduation feed  : active (Migrate instruction on pump.fun flux)'
    : 'Graduation feed  : disabled — no HELIUS_API_KEY (same flux as Helius pool feed)')

  const conservativeBroker = new DexBroker({ id: `scan-conservative-${chain}`, chain, paper: true, paperCashUsd: 1000 })
  const earlyBroker = new DexBroker({ id: `scan-early-${chain}`, chain, paper: true, paperCashUsd: 1000 })
  const earlyStrictBroker = new DexBroker({ id: `scan-early-strict-${chain}`, chain, paper: true, paperCashUsd: 1000 })
  const earlyWebFilteredBroker = new DexBroker({ id: `scan-early-web-filtered-${chain}`, chain, paper: true, paperCashUsd: 1000 })
  const gradImmediateBroker = new DexBroker({ id: `scan-grad-immediate-${chain}`, chain, paper: true, paperCashUsd: 1000 })
  const gradDipBroker = new DexBroker({ id: `scan-grad-dip-${chain}`, chain, paper: true, paperCashUsd: 1000 })
  await conservativeBroker.init()
  await earlyBroker.init()
  await earlyStrictBroker.init()
  await earlyWebFilteredBroker.init()
  await gradImmediateBroker.init()
  await gradDipBroker.init()

  const graduatedTracker = new GraduatedTokensTracker()
  await graduatedTracker.load()
  console.log(`Graduated tracker: ${graduatedTracker.getAll().length} tokens (loaded from active.json)`)
  console.log(`GRAD_IMMEDIATE   : ${GRAD_IMMEDIATE_ENTRY_SUSPENDED ? 'entry SUSPENDED (2026-07-02, negative expectancy — see GRAD_IMMEDIATE_ENTRY_SUSPENDED docstring); exits for existing positions still active' : heliusKeyPresent ? `enabled (${GRAD_IMMEDIATE_POST_GRAD_DELAY_MS / 1000}s delay post-graduation)` : 'disabled — needs Graduation feed'}`)
  console.log(`GRAD_DIP         : ${GRAD_DIP_ENTRY_SUSPENDED ? 'entry SUSPENDED (2026-07-03, no positive signal on clean n=33/12 tokens — see GRAD_DIP_ENTRY_SUSPENDED docstring); exits for existing positions still active' : 'enabled (25-60% dip from peak)'}`)
  console.log('EARLY_WEB_FILTERED : enabled, parallel pilot (requireWebsite, EARLY otherwise unchanged) — see EARLY_WEB_FILTERED_CONFIG docstring for the quartile-instability caveat and n≥30+quartile reopen threshold')

  // EARLY_STRICT replaces SCALP_MOMENTUM_CONFIG here — see EARLY_STRICT_CONFIG's
  // docstring for why (SCALP stayed at 0/120 passes even after relaxing its
  // thresholds; EARLY_STRICT runs alongside EARLY to compare on live data).
  // TODO: activer COPY_WALLET après validation bootstrap (voir
  // COPY_WALLET_CONFIG's docstring — seed actuel: 80 wallets, pas encore
  // assez de wallets qualifiés pour faire confiance à ce gate en achat réel).
  // const ACTIVE_STRATEGIES = [CONSERVATIVE_CONFIG, EARLY_CONFIG, EARLY_STRICT_CONFIG, COPY_WALLET_CONFIG]
  // Pour l'instant : COPY_WALLET en observation uniquement (défini plus haut,
  // testable, mais volontairement absent de ce tableau).
  const strategies: StrategyRuntime[] = [
    { config: CONSERVATIVE_CONFIG, broker: conservativeBroker },
    { config: EARLY_CONFIG, broker: earlyBroker },
    { config: EARLY_STRICT_CONFIG, broker: earlyStrictBroker },
    { config: EARLY_WEB_FILTERED_CONFIG, broker: earlyWebFilteredBroker },
  ]
  // Kept separate from `strategies` — never passed to runScanPhase, so
  // GRAD_IMMEDIATE/GRAD_DIP are never evaluated against the generic
  // DexScreener-candidate loop (see the graduation-strategies section
  // header for why). Still needs restoreOpenPositions like any other
  // strategy, via the combined array below.
  const gradStrategies: StrategyRuntime[] = [
    { config: GRAD_IMMEDIATE_CONFIG, broker: gradImmediateBroker },
    { config: GRAD_DIP_CONFIG, broker: gradDipBroker },
  ]
  const allStrategies = [...strategies, ...gradStrategies]
  // Split by exit-check cadence, not by any other property — see
  // FAST_EXIT_REGIME_LABELS's docstring for the per-strategy evidence
  // behind this split. `fastExitStrategies` runs on its own fast
  // independent timer below; `mainLoopExitStrategies` is everything else,
  // still checked once per the main loop's (slow) `intervalSeconds`. Kept
  // as two disjoint lists so runExitsPhase never double-checks the same
  // strategy from both paths.
  const fastExitStrategies = allStrategies.filter(s => isFastExitRegimeStrategy(s.config.label))
  const mainLoopExitStrategies = allStrategies.filter(s => !isFastExitRegimeStrategy(s.config.label))

  await restoreOpenPositions(allStrategies)

  const pumpFeed = new PumpFunFeed({
    onNewToken: (token) => {
      void handleNewPumpToken(token)
    },
    onError: (err) => {
      console.error(`live-scan: Pump.fun feed error — ${err.message}`)
      console.warn('Pump.fun feed unavailable — falling back to DexScreener polling')
    },
  })
  pumpFeed.start()

  // Surveillance only — see the section header above handleNewHeliusPool
  // for why this never reaches evaluateStrategy(). Only constructed/started
  // when a Helius key is actually configured; the public RPC's WebSocket
  // has no realistic budget for the ~110msg/s pump.fun firehose this feed
  // subscribes to, so silently degrading to it would just mean constant
  // disconnects rather than a working fallback (unlike the pump.fun-feed
  // above, which does have a real fallback: DexScreener polling continues
  // regardless of this feed's state either way).
  const shutdownController = new AbortController()

  const heliusPoolFeed = heliusKeyPresent
    ? new HeliusPoolFeed({
      onNewPool: (pool) => {
        handleNewHeliusPool(pool)
      },
      onGraduation: (event) => {
        void (async () => {
          const isNew = await graduatedTracker.add(event)
          console.log(`live-scan: Graduation detected — ${event.mintAddress} (sig ${event.signature.slice(0, 12)}...)`)
          if (!isNew) {
            // Confirmed live 2026-07-02: pump.fun can emit more than one
            // genuine Instruction: Migrate log for the same mint. Without
            // this guard, GRAD_IMMEDIATE bought the same token 3 times in a
            // row from 3 duplicate events — see graduatedTracker.add()'s
            // docstring.
            console.log(`live-scan: ${event.mintAddress} already tracked — skipping duplicate GRAD_IMMEDIATE trigger`)
            return
          }
          if (GRAD_IMMEDIATE_ENTRY_SUSPENDED) {
            console.log(`live-scan: ${event.mintAddress} graduation noted, GRAD_IMMEDIATE entry suspended — skipping buy (see GRAD_IMMEDIATE_ENTRY_SUSPENDED docstring)`)
            return
          }
          await handleGradImmediate(chain, event, gradImmediateBroker, shutdownController.signal)
        })()
      },
      onError: (err) => {
        console.error(`live-scan: Helius pool feed error — ${err.message}`)
        console.warn('Helius pool feed unavailable — discovery continues via DexScreener polling and pump.fun watchlist, unaffected')
      },
    })
    : null
  heliusPoolFeed?.start()

  // Fast, independent of the main loop's `intervalSeconds` sleep — see
  // FAST_EXIT_CHECK_INTERVAL_MS's docstring. One shared timer for all of
  // `fastExitStrategies` (early/early_strict/grad_immediate) rather than one
  // timer per strategy: `runExitsPhase` already sequences multiple
  // strategies' `checkExits` calls safely (same pattern the main loop uses
  // today for conservative+grad_dip) — each `checkExits` call is scoped to
  // its own broker/strategy label, so there's no shared mutable state
  // between strategies to race on, only the same open.json file lock every
  // exit check already contends for regardless of which timer triggered it.
  // The one real trade-off: if EARLY's checkExits call is unusually slow
  // (large open-position count, disk contention), it delays EARLY_STRICT's
  // and GRAD_IMMEDIATE's checks within that same tick — acceptable since
  // `checkExits` is normally sub-millisecond (pure cache read, no network),
  // and this is the same sequencing cost the main loop already pays today
  // for its own multi-strategy passes.
  // `fastExitChecking` is a re-entrancy guard over the WHOLE batched call:
  // this skips an entire overlapping tick (never a partial one) rather than
  // let two concurrent batches race on open.json.
  let fastExitChecking = false
  const fastExitTimer = setInterval(() => {
    if (fastExitChecking) return
    fastExitChecking = true
    void runExitsPhase(chain, fastExitStrategies, shutdownController.signal)
      .catch(err => console.error(`live-scan: fast exit check failed — ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { fastExitChecking = false })
  }, FAST_EXIT_CHECK_INTERVAL_MS)

  const rateLimiter = new RateLimiter()
  const stats = freshStats()
  let lastHourlyLog = Date.now()
  // 0, not Date.now() — forces the very first loop iteration to run a scan
  // phase immediately rather than waiting a full scanIntervalSeconds first.
  let lastScanAt = 0
  let lastWatchlistCheck = 0
  let lastHeliusWatchlistCheck = 0
  let lastHeartbeatAt = 0
  let totalCycleCount = 0
  let lastGradDipCheck = 0
  let stopping = false
  // shutdownController is declared earlier in this function (before
  // heliusPoolFeed's onGraduation callback, which captures it) — aborts
  // every in-flight sleep (throttle gap, backoff, main interval, and
  // GRAD_IMMEDIATE's post-graduation wait) on shutdown, without which a
  // SIGINT could block for up to BACKOFF_DELAYS_MS's longest entry (2
  // minutes) or GRAD_IMMEDIATE_POST_GRAD_DELAY_MS (90s).

  const requestStop = (): void => {
    if (stopping) return
    stopping = true
    shutdownController.abort()
    clearInterval(fastExitTimer)
    pumpFeed.stop()
    heliusPoolFeed?.stop()
    priceFeed.closeAll()
    console.log('\nlive-scan: shutdown requested — finishing current cycle...')
  }
  process.on('SIGINT', requestStop)
  process.on('SIGTERM', requestStop)

  await writeHeartbeat(totalCycleCount)
  lastHeartbeatAt = Date.now()

  while (!stopping) {
    try {
      // Exits run every tick — i.e. every `intervalSeconds` (the tick rate IS
      // that sleep, see the bottom of this loop), NOT genuinely "fast" for
      // every strategy. early/early_strict/grad_immediate are excluded here
      // — they're checked on their own much faster shared independent timer
      // instead (see FAST_EXIT_CHECK_INTERVAL_MS's docstring for why this
      // distinction was added 2026-07-02, and extended the same day from
      // grad_immediate-only to include early/early_strict). The new-token
      // scan only runs once scanIntervalSeconds has actually elapsed,
      // decoupling "how fast we react to a crash" from "how often we hit
      // the rate-limited discovery endpoint." See runExitsPhase/runScanPhase.
      await runExitsPhase(chain, mainLoopExitStrategies, shutdownController.signal)
      if (Date.now() - lastScanAt >= scanIntervalSeconds * 1000) {
        await runScanPhase(chain, strategies, rateLimiter, stats, shutdownController.signal)
        lastScanAt = Date.now()
      }
      if (Date.now() - lastWatchlistCheck >= WATCHLIST_CHECK_INTERVAL_MS) {
        await checkPumpWatchlist(chain)
        lastWatchlistCheck = Date.now()
      }
      if (heliusPoolFeed && Date.now() - lastHeliusWatchlistCheck >= HELIUS_WATCHLIST_CHECK_INTERVAL_MS) {
        await checkHeliusPoolWatchlist(chain)
        lastHeliusWatchlistCheck = Date.now()
      }
      if (!GRAD_DIP_ENTRY_SUSPENDED && Date.now() - lastGradDipCheck >= GRAD_DIP_CHECK_INTERVAL_MS) {
        await handleGradDip(chain, gradDipBroker, graduatedTracker)
        lastGradDipCheck = Date.now()
      }
      stats.cycles++
      totalCycleCount++
    } catch (err) {
      console.error(`live-scan: cycle failed — ${err instanceof Error ? err.message : String(err)}`)
    }

    if (Date.now() - lastHeartbeatAt >= 60_000) {
      await writeHeartbeat(totalCycleCount)
      lastHeartbeatAt = Date.now()
    }

    if (Date.now() - lastHourlyLog >= 60 * 60_000) {
      await logSummary('hourly', strategies, stats, heliusPoolFeed, gradStrategies, graduatedTracker)
      stats.cycles = 0
      stats.scanned = 0
      stats.passed = { conservative: 0, early: 0, momentum: 0, scalp_momentum: 0, early_strict: 0, early_web_filtered: 0, copy_wallet: 0, grad_immediate: 0, grad_dip: 0 }
      stopLossOvershootCount = 0
      lastHourlyLog = Date.now()
    }

    if (stopping) break
    await sleep(intervalSeconds * 1000, shutdownController.signal)
  }

  await logSummary('final', strategies, stats, heliusPoolFeed, gradStrategies, graduatedTracker)
  console.log('live-scan: stopped cleanly.')
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
if (isMainModule) {
  runLiveScan().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
