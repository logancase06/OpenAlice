import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { dataPath } from '@/core/paths.js'

vi.mock('../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js')>()
  return {
    ...actual,
    fetchLatestTokenProfiles: vi.fn(),
    fetchDexScreenerTokenPairs: vi.fn(),
    fetchDexScreenerTokensBatch: vi.fn(),
    fetchPairForMint: vi.fn(),
  }
})

// Default mirrors what every existing test already implicitly gets today
// (no real Helius key in the sandbox -> network unreachable -> rpcAvailable:
// false) — checkSolanaMintAuthorityViaRpc only warns+skips on that, never
// rejects, so this preserves every pre-existing EARLY_CONFIG (useSolanaRpc:
// true) test's behavior. Only the GRAD_IMMEDIATE mint-authority test below
// overrides this per-call.
vi.mock('../../services/uta/src/domain/trading/brokers/dex/solana-rpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/uta/src/domain/trading/brokers/dex/solana-rpc.js')>()
  return { ...actual, checkMintAuthority: vi.fn() }
})

// PumpFunFeed opens a real WebSocket to a third-party service in its
// constructor's eventual .start() — every test that exercises runLiveScan
// must not let that happen. start/stop are shared vi.fn()s (reset in
// beforeEach) so tests can assert on them without reaching into the mocked
// instance.
const pumpFeedStartMock = vi.fn()
const pumpFeedStopMock = vi.fn()
vi.mock('../../services/uta/src/domain/trading/brokers/dex/pump-fun-feed.js', () => ({
  // A regular function, not an arrow — `new PumpFunFeed(...)` in live-scan.ts
  // needs an actually-constructible function; an arrow function has no
  // [[Construct]] and vi.fn() doesn't synthesize one around it.
  PumpFunFeed: vi.fn().mockImplementation(function (this: { start: () => void; stop: () => void }) {
    this.start = pumpFeedStartMock
    this.stop = pumpFeedStopMock
  }),
}))

// Same rationale/pattern as PumpFunFeed above — HeliusPoolFeed opens a real
// WebSocket in .start(), and its constructor must remain a regular function
// so `new HeliusPoolFeed(...)` works under vi.fn().mockImplementation.
const heliusFeedStartMock = vi.fn()
const heliusFeedStopMock = vi.fn()
const heliusFeedGetTransactionCallsMadeMock = vi.fn(() => 0)
// Captured so the "runLiveScan wires onGraduation to handleGradImmediate"
// test can invoke the real callback runLiveScan constructed, rather than
// re-implementing the wiring assertion by calling handleGradImmediate directly.
let capturedHeliusFeedConfig: { onGraduation?: (event: unknown) => void } | null = null
vi.mock('../../services/uta/src/domain/trading/brokers/dex/helius-pool-feed.js', () => ({
  HeliusPoolFeed: vi.fn().mockImplementation(function (this: { start: () => void; stop: () => void; getTransactionCallsMade: () => number }, config: { onGraduation?: (event: unknown) => void }) {
    capturedHeliusFeedConfig = config
    this.start = heliusFeedStartMock
    this.stop = heliusFeedStopMock
    this.getTransactionCallsMade = heliusFeedGetTransactionCallsMadeMock
  }),
}))

import {
  runCycle,
  runExitsPhase,
  runScanPhase,
  checkExits,
  getStopLossOvershootCount,
  __resetStopLossOvershootCountForTests,
  evaluateStrategy,
  evaluateExitRules,
  logSummary,
  scanLogPath,
  RateLimiter,
  CONSERVATIVE_CONFIG,
  EARLY_CONFIG,
  EARLY_STRICT_CONFIG,
  EARLY_WEB_FILTERED_CONFIG,
  EARLY_WEB_FILTERED_ENTRY_SUSPENDED,
  silentDistributionLogPath,
  positionTrajectoryLogPath,
  EARLY_EXIT_CONFIG,
  SCALP_EXIT_CONFIG,
  runLiveScan,
  parseArgs,
  freshStats,
  restoreOpenPositions,
  handleNewPumpToken,
  checkPumpWatchlist,
  pumpWatchlist,
  handleNewHeliusPool,
  checkHeliusPoolWatchlist,
  heliusPoolWatchlist,
  handleGradImmediate,
  handleGradDip,
  GRAD_IMMEDIATE_EXIT_CONFIG,
  GRAD_DIP_EXIT_CONFIG,
  GRAD_DIP_CONFIG,
  GRAD_IMMEDIATE_ENTRY_SUSPENDED,
  GRAD_DIP_ENTRY_SUSPENDED,
  type StrategyRuntime,
} from './live-scan.js'
import type { PumpFunToken } from '../../services/uta/src/domain/trading/brokers/dex/pump-fun-feed.js'
import type { DiscoveredPool, GraduationEvent } from '../../services/uta/src/domain/trading/brokers/dex/helius-pool-feed.js'
import type { OpenPosition } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'
import { GraduatedTokensTracker } from '../../services/uta/src/domain/trading/brokers/dex/graduated-tokens-tracker.js'
import { checkMintAuthority } from '../../services/uta/src/domain/trading/brokers/dex/solana-rpc.js'
import {
  fetchLatestTokenProfiles,
  fetchDexScreenerTokenPairs,
  fetchDexScreenerTokensBatch,
  fetchPairForMint,
  type DexScreenerPair,
} from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { DexBroker } from '../../services/uta/src/domain/trading/brokers/dex/DexBroker.js'
import { openPosition, getOpenPositions } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'
import { priceFeed } from '../../services/uta/src/domain/trading/brokers/dex/dex-price-feed.js'

const profilesMock = vi.mocked(fetchLatestTokenProfiles)
const pairsMock = vi.mocked(fetchDexScreenerTokenPairs)
const tokensBatchMock = vi.mocked(fetchDexScreenerTokensBatch)
const pairForMintMock = vi.mocked(fetchPairForMint)
const mintAuthorityMock = vi.mocked(checkMintAuthority)

function pair(overrides: Partial<DexScreenerPair> & { address: string; ageMinutes: number }): DexScreenerPair {
  return {
    chainId: 'solana',
    pairAddress: `pair-${overrides.address}`,
    baseToken: { address: overrides.address, symbol: overrides.address.toUpperCase(), name: 'Test Coin' },
    quoteToken: { address: 'sol', symbol: 'SOL', name: 'Wrapped SOL' },
    priceUsd: '0.10',
    liquidity: { usd: 50_000 },
    txns: { h1: { buys: 30, sells: 5 } },
    pairCreatedAt: Date.now() - overrides.ageMinutes * 60_000,
    ...overrides,
  }
}

async function readScanLog(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(scanLogPath(), 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

async function readSilentDistributionLog(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(silentDistributionLogPath(), 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

async function readPositionTrajectoryLog(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(positionTrajectoryLogPath(), 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

beforeEach(() => {
  profilesMock.mockReset()
  pairsMock.mockReset()
  tokensBatchMock.mockReset()
  tokensBatchMock.mockResolvedValue(new Map())
  pumpFeedStartMock.mockReset()
  pumpFeedStopMock.mockReset()
  heliusFeedStartMock.mockReset()
  heliusFeedStopMock.mockReset()
  heliusFeedGetTransactionCallsMadeMock.mockReset()
  heliusFeedGetTransactionCallsMadeMock.mockReturnValue(0)
  capturedHeliusFeedConfig = null
  pairForMintMock.mockReset()
  mintAuthorityMock.mockReset()
  // Default matches every pre-existing test's implicit real-network outcome
  // (sandbox has no reachable RPC) — see the solana-rpc.js mock comment above.
  mintAuthorityMock.mockResolvedValue({ hasMintAuthority: false, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'unused', fromCache: false, rpcAvailable: false })
  priceFeed.closeAll()
  __resetStopLossOvershootCountForTests()
})

afterEach(async () => {
  await rm(dataPath('scan-log'), { recursive: true, force: true })
  await rm(dataPath('silent-distribution'), { recursive: true, force: true })
  await rm(dataPath('position-trajectory'), { recursive: true, force: true })
  await rm(dataPath('snapshots'), { recursive: true, force: true })
  await rm(dataPath('positions'), { recursive: true, force: true })
  await rm(dataPath('wallets'), { recursive: true, force: true })
  await rm(dataPath('graduated'), { recursive: true, force: true })
  priceFeed.closeAll()
  pumpWatchlist.clear()
  heliusPoolWatchlist.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('evaluateStrategy — age window filtering', () => {
  it('rejects a token younger than minAgeMinutes for both strategies (filtered in the scanner, not the guard)', async () => {
    const broker = new DexBroker({ id: 'test-conservative', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()

    const decision = await evaluateStrategy(CONSERVATIVE_CONFIG, 'solana', 'freshTok', 5, broker, pair({ address: 'freshTok', ageMinutes: 5 }))

    expect(decision.pass).toBe(false)
    expect(decision.reason).toMatch(/age 5m outside \[360, ∞\] window for conservative/)
  })

  it('rejects a token older than maxAgeMinutes for the early strategy', async () => {
    const broker = new DexBroker({ id: 'test-early', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()

    const decision = await evaluateStrategy(EARLY_CONFIG, 'solana', 'oldTok', 400, broker, pair({ address: 'oldTok', ageMinutes: 400 }))

    expect(decision.pass).toBe(false)
    expect(decision.reason).toMatch(/age 400m outside \[30, 360\] window for early/)
  })
})

describe('runCycle', () => {
  it('records a snapshot and writes one JSONL line per candidate, updating stats', async () => {
    profilesMock.mockResolvedValue([
      { chainId: 'solana', tokenAddress: 'tokA' },
      { chainId: 'ethereum', tokenAddress: 'tokWrongChain' }, // filtered out by chain
    ])
    pairsMock.mockImplementation(async (_chain: string, tokenAddress: string) => {
      if (tokenAddress === 'tokA') {
        return [pair({ address: 'tokA', ageMinutes: 400, liquidity: { usd: 15_000 } })]
      }
      return []
    })

    const conservativeBroker = new DexBroker({ id: 'cycle-conservative', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const earlyBroker = new DexBroker({ id: 'cycle-early', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await conservativeBroker.init()
    await earlyBroker.init()
    const strategies: StrategyRuntime[] = [
      { config: CONSERVATIVE_CONFIG, broker: conservativeBroker },
      { config: EARLY_CONFIG, broker: earlyBroker },
    ]
    const stats = freshStats()

    await runCycle('solana', strategies, new RateLimiter(), stats)

    expect(stats.scanned).toBe(1) // only tokA — the ethereum candidate is filtered by chain before any pair fetch
    expect(await readScanLog()).toHaveLength(1)

    const snapshotRaw = await readFile(dataPath('snapshots', 'pair-tokA.json'), 'utf-8')
    expect(JSON.parse(snapshotRaw)).toHaveLength(1)
  })

  it('writes well-formed JSONL with both strategy verdicts on each line', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'tokB' }])
    pairsMock.mockResolvedValue([pair({ address: 'tokB', ageMinutes: 400, liquidity: { usd: 15_000 } })])

    const conservativeBroker = new DexBroker({ id: 'jsonl-conservative', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const earlyBroker = new DexBroker({ id: 'jsonl-early', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await conservativeBroker.init()
    await earlyBroker.init()
    const strategies: StrategyRuntime[] = [
      { config: CONSERVATIVE_CONFIG, broker: conservativeBroker },
      { config: EARLY_CONFIG, broker: earlyBroker },
    ]

    await runCycle('solana', strategies, new RateLimiter(), freshStats())

    const [entry] = await readScanLog()
    expect(entry).toBeDefined()
    expect(entry!.symbol).toBe('TOKB')
    expect(entry!.pairAddress).toBe('pair-tokB')
    expect(entry!.conservative).toHaveProperty('pass')
    expect(entry!.conservative).toHaveProperty('reason')
    expect(entry!.early).toHaveProperty('pass')
    expect(entry!.early).toHaveProperty('reason')
    expect(entry!.momentum).toHaveProperty('pass') // not run this cycle (no momentum runtime) — still present, per live-scan.ts's fallback
    expect(entry).toHaveProperty('velocityContext')
    expect(entry).toHaveProperty('walletSignals')
    expect(entry).toHaveProperty('nameFilter')
  })

  // Adopted 2026-07-02: DexScreener's real API response already includes
  // info.socials/info.websites/boosts.active, confirmed live, but this
  // scanner silently discarded them before this change. Captured here for
  // sample accumulation only — not wired into any filter (see
  // ScanLogRawData's docstring for why: a same-day check showed only a weak
  // split between rugs and winners, not clean enough to act on yet).
  it('captures hasSocials/hasWebsite/boostsActive from the DexScreener pair into rawData', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'tokSocial' }])
    pairsMock.mockResolvedValue([pair({
      address: 'tokSocial',
      ageMinutes: 400,
      liquidity: { usd: 15_000 },
      info: { socials: [{ url: 'https://x.com/example', type: 'twitter' }], websites: [{ url: 'https://example.com' }] },
      boosts: { active: 12 },
    })])

    const conservativeBroker = new DexBroker({ id: 'social-conservative', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const earlyBroker = new DexBroker({ id: 'social-early', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await conservativeBroker.init()
    await earlyBroker.init()
    const strategies: StrategyRuntime[] = [
      { config: CONSERVATIVE_CONFIG, broker: conservativeBroker },
      { config: EARLY_CONFIG, broker: earlyBroker },
    ]

    await runCycle('solana', strategies, new RateLimiter(), freshStats())

    const [entry] = await readScanLog()
    const rawData = entry!.rawData as Record<string, unknown>
    expect(rawData.hasSocials).toBe(true)
    expect(rawData.hasWebsite).toBe(true)
    expect(rawData.boostsActive).toBe(12)
  })

  it('records hasSocials/hasWebsite as false and boostsActive as undefined when the pair has no info/boosts at all', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'tokNoSocial' }])
    pairsMock.mockResolvedValue([pair({ address: 'tokNoSocial', ageMinutes: 400, liquidity: { usd: 15_000 } })]) // no info/boosts override

    const conservativeBroker = new DexBroker({ id: 'nosocial-conservative', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const earlyBroker = new DexBroker({ id: 'nosocial-early', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await conservativeBroker.init()
    await earlyBroker.init()
    const strategies: StrategyRuntime[] = [
      { config: CONSERVATIVE_CONFIG, broker: conservativeBroker },
      { config: EARLY_CONFIG, broker: earlyBroker },
    ]

    await runCycle('solana', strategies, new RateLimiter(), freshStats())

    const [entry] = await readScanLog()
    const rawData = entry!.rawData as Record<string, unknown>
    expect(rawData.hasSocials).toBe(false)
    expect(rawData.hasWebsite).toBe(false)
    expect(rawData.boostsActive).toBeUndefined()
  })
})

// Named buildOpenPosition, not openPosition — this file also imports the
// real `openPosition` from position-tracker.js (used by the
// restoreOpenPositions tests below); a same-named local helper would shadow
// that import silently instead of erroring, and every `openPosition(...)`
// call meant for position-tracker would quietly call this fixture instead.
function buildOpenPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    id: 'pos-1',
    pairAddress: 'pair-1',
    tokenAddress: 'tok1',
    symbol: 'TEST',
    strategy: 'early',
    entryPrice: 1.0,
    entryLiquidityUsd: 10_000,
    entryTimestamp: Date.now(),
    entryAgeMinutes: 60,
    peakPrice: 1.0,
    lastCheckedAt: Date.now(),
    buyerWallets: [],
    exitConfig: EARLY_EXIT_CONFIG,
    ...overrides,
  }
}

// Thresholds adopted 2026-07-01 from scripts/retro/exit-sim.ts's "ConfigD" —
// see evaluateExitRules's own docstring in live-scan.ts for the empirical
// justification. No test existed for this function before; these are new.
describe('runExitsPhase / runScanPhase decoupling', () => {
  it('runExitsPhase never touches fetchLatestTokenProfiles — it has no dependency on the rate-limited discovery endpoint', async () => {
    const broker = new DexBroker({ id: 'decouple-exits', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const strategies: StrategyRuntime[] = [{ config: EARLY_CONFIG, broker }]

    await runExitsPhase('solana', strategies)

    expect(profilesMock).not.toHaveBeenCalled()
  })

  it('runScanPhase does call fetchLatestTokenProfiles', async () => {
    // Non-empty (chain-filtered-out) response — an empty array would hit
    // RateLimiter's 30s backoff sleep, which this test isn't set up to abort.
    profilesMock.mockResolvedValue([{ chainId: 'ethereum', tokenAddress: 'irrelevant' }])
    const broker = new DexBroker({ id: 'decouple-scan', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const strategies: StrategyRuntime[] = [{ config: EARLY_CONFIG, broker }]

    await runScanPhase('solana', strategies, new RateLimiter(), freshStats())

    expect(profilesMock).toHaveBeenCalled()
  })
})

describe('evaluateExitRules', () => {
  it('triggers stop_loss at returnPct <= -20, ahead of trailing_stop even though its own threshold would also match', () => {
    // -10%: above both stop_loss(-20) and trailing_stop(-15, since peak==entry here) -> null
    expect(evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0 }), 0.90, 10_000, undefined)).toBeNull()
    // -20.1%: stop_loss is checked first in priority order and wins, even though
    // dropFromPeak is also well past trailingStop's -15 here.
    expect(evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0 }), 0.799, 10_000, undefined)).toBe('stop_loss')
  })

  it('triggers trailing_stop at a single -15% drop-from-peak threshold, regardless of returnPct', () => {
    // peak 2.0 (+100%), current 1.7 -> drop = (1.7-2.0)/2.0 = -15% exactly
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 2.0 }), 1.7, 10_000, undefined)
    expect(result).toBe('trailing_stop')
  })

  it('does not trigger trailing_stop just above the threshold', () => {
    // peak 1.20 (+20%, past the +12% activation), current 1.03 -> drop = (1.03-1.20)/1.20 = -14.17% -> above -15%, no trigger
    // returnPct=3%, kept well under takeProfit(40) so this isolates the trailing_stop boundary only.
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.20 }), 1.03, 10_000, undefined)
    expect(result).toBeNull()
  })

  it('triggers take_profit at returnPct >= 40', () => {
    expect(evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.39 }), 1.39, 10_000, undefined)).toBeNull()
    expect(evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.41 }), 1.41, 10_000, undefined)).toBe('take_profit')
  })

  it('triggers time_exit at holdingMinutes >= 180 with no other rule firing', () => {
    const entryTimestamp = Date.now() - 181 * 60_000
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0, entryTimestamp }), 1.0, 10_000, undefined)
    expect(result).toBe('time_exit')
  })

  it('triggers momentum_reversal at priceChange5m <= -10 that also accelerated past the prior reading', () => {
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0, lastPriceChange5m: -8 }), 0.95, 10_000, -10)
    expect(result).toBe('momentum_reversal')
  })

  it('does not trigger momentum_reversal on a one-off dip with no prior reading to compare against (e.g. first cycle after entry)', () => {
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0, lastPriceChange5m: undefined }), 0.95, 10_000, -10)
    expect(result).toBeNull()
  })

  it('does not trigger momentum_reversal when the dip has NOT accelerated versus the prior reading', () => {
    // -10 clears the threshold on its own, but it's not more negative than
    // the prior -12 — the drop already happened, it isn't accelerating now.
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0, lastPriceChange5m: -12 }), 0.95, 10_000, -10)
    expect(result).toBeNull()
  })

  it('does not trigger momentum_reversal on a winning position, even with accelerating negative momentum', () => {
    // peak == current (no drop) so trailing_stop can't fire either — isolates momentum_reversal itself.
    // Note: unlike the pre-2026-07-02 rule, there is no explicit returnPct<0
    // guard anymore — a winning position with accelerating negative m5 CAN
    // trigger momentum_reversal now. This test documents that intentional
    // change rather than asserting the old guard still exists.
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.2, lastPriceChange5m: -5 }), 1.2, 10_000, -20)
    expect(result).toBe('momentum_reversal')
  })

  it('triggers liquidity_drain when current liquidity falls below 40% of entry liquidity (unchanged from before)', () => {
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0, entryLiquidityUsd: 10_000 }), 1.0, 3_999, undefined)
    expect(result).toBe('liquidity_drain')
  })

  it('returns null when no rule fires', () => {
    const result = evaluateExitRules(buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0, entryLiquidityUsd: 10_000 }), 1.02, 9_000, undefined)
    expect(result).toBeNull()
  })

  it('per-position exitConfig: a SCALP_MOMENTUM position takes profit at +16%, not EARLY\'s +200%', () => {
    const scalpPosition = buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.0, exitConfig: SCALP_EXIT_CONFIG })
    expect(evaluateExitRules(scalpPosition, 1.15, 10_000, undefined)).toBeNull() // +15%, below SCALP's +16
    expect(evaluateExitRules(scalpPosition, 1.17, 10_000, undefined)).toBe('take_profit') // unambiguously past +16
  })

  it('per-position exitConfig: an EARLY position at the same +16% return does not take profit (its threshold is +200%)', () => {
    const earlyPosition = buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.16, exitConfig: EARLY_EXIT_CONFIG })
    expect(evaluateExitRules(earlyPosition, 1.16, 10_000, undefined)).toBeNull()
  })

  it('SCALP_MOMENTUM trailing stop arms at +8% (not EARLY\'s +12%) and uses a -6% (not -15%) drop threshold', () => {
    const scalpPosition = buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.10, exitConfig: SCALP_EXIT_CONFIG }) // peak +10% clears the +8% activation
    expect(evaluateExitRules(scalpPosition, 1.035, 10_000, undefined)).toBeNull() // drop = (1.035-1.10)/1.10 = -5.9% -> above -6%, no trigger
    expect(evaluateExitRules(scalpPosition, 1.03, 10_000, undefined)).toBe('trailing_stop') // drop = (1.03-1.10)/1.10 = -6.4% <= -6%
  })

  it('trailing stop stays disarmed below its activation threshold, even on a drop that would otherwise qualify', () => {
    // peak +10% is below EARLY's +12% activation -> trailing_stop must not fire here even
    // though dropFromPeak (-18.2%) would clear its -15% threshold if it were armed.
    const earlyPosition = buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.10, exitConfig: EARLY_EXIT_CONFIG })
    const result = evaluateExitRules(earlyPosition, 0.90, 10_000, undefined) // returnPct -10%, dropFromPeak -18.2%
    expect(result).toBeNull()
  })

  it('two positions at the identical current price but different exitConfig can produce different exit decisions', () => {
    const scalpPosition = buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.20, exitConfig: SCALP_EXIT_CONFIG }) // peak +20%, well past SCALP's +8% activation
    const earlyPosition = buildOpenPosition({ entryPrice: 1.0, peakPrice: 1.20, exitConfig: EARLY_EXIT_CONFIG }) // peak +20%, past EARLY's +12% activation too

    // Same current price for both: +12% return, drop from peak (1.12-1.20)/1.20 = -6.67%
    const scalpResult = evaluateExitRules(scalpPosition, 1.12, 10_000, undefined)
    const earlyResult = evaluateExitRules(earlyPosition, 1.12, 10_000, undefined)

    expect(scalpResult).toBe('trailing_stop') // -6.67% <= SCALP's -6% trailing threshold
    expect(earlyResult).toBeNull() // -6.67% is above EARLY's -15% trailing threshold — no rule fires
  })
})

describe('restoreOpenPositions', () => {
  it('does nothing and does not throw when open.json is empty', async () => {
    const broker = new DexBroker({ id: 'restore-empty', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const strategies: StrategyRuntime[] = [{ config: EARLY_CONFIG, broker }]

    await expect(restoreOpenPositions(strategies)).resolves.toBeUndefined()
    expect(await broker.getPositions()).toHaveLength(0)
  })

  it('calls restorePosition for each persisted position, into the matching strategy broker', async () => {
    await openPosition(pair({ address: 'restoredTok', ageMinutes: 60, priceUsd: '0.02' }), 'early', 0.02, 60, EARLY_EXIT_CONFIG)

    const earlyBroker = new DexBroker({ id: 'restore-early', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const conservativeBroker = new DexBroker({ id: 'restore-conservative', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await earlyBroker.init()
    await conservativeBroker.init()
    const strategies: StrategyRuntime[] = [
      { config: CONSERVATIVE_CONFIG, broker: conservativeBroker },
      { config: EARLY_CONFIG, broker: earlyBroker },
    ]

    await restoreOpenPositions(strategies)

    const earlyPositions = await earlyBroker.getPositions()
    expect(earlyPositions).toHaveLength(1)
    expect(earlyPositions[0].avgCost).toBe('0.02')
    expect(await conservativeBroker.getPositions()).toHaveLength(0) // wrong strategy — untouched
  })

  it('prevents a duplicate buy on a token restored from a previous session', async () => {
    // Age must fall inside EARLY_CONFIG's [30, 360] window, otherwise the age
    // filter itself would reject before ever reaching hasOpenPosition.
    await openPosition(pair({ address: 'restoredTok', ageMinutes: 100, priceUsd: '0.02' }), 'early', 0.02, 100, EARLY_EXIT_CONFIG)

    const earlyBroker = new DexBroker({ id: 'restore-nodupe', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await earlyBroker.init()
    const strategies: StrategyRuntime[] = [{ config: EARLY_CONFIG, broker: earlyBroker }]
    await restoreOpenPositions(strategies)

    pairsMock.mockResolvedValue([pair({ address: 'restoredTok', ageMinutes: 100, priceUsd: '0.02', liquidity: { usd: 50_000 } })])
    // useSolanaRpc:false here — 'restoredTok' isn't a real address, and the
    // real checkMintAuthority RPC call fails safe ("authority active") for
    // any non-mint account, which would reject before ever reaching the
    // hasOpenPosition check this test actually exercises.
    const decision = await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'restoredTok', 100, earlyBroker, pair({ address: 'restoredTok', ageMinutes: 100 }))

    expect(decision.pass).toBe(true)
    expect(decision.tradeSimulated).toBe(false)
    expect(decision.reason).toMatch(/already holding/)
    expect(await earlyBroker.getPositions()).toHaveLength(1) // still just the restored one, no second buy
  })
})

describe('logSummary', () => {
  it('prints cycle/scanned/passed counts and the positions/wallets sections', async () => {
    const conservativeBroker = new DexBroker({ id: 'summary-conservative', chain: 'solana', paper: true, paperCashUsd: 1000 })
    const earlyBroker = new DexBroker({ id: 'summary-early', chain: 'solana', paper: true, paperCashUsd: 500 })
    await conservativeBroker.init()
    await earlyBroker.init()
    const strategies: StrategyRuntime[] = [
      { config: CONSERVATIVE_CONFIG, broker: conservativeBroker },
      { config: EARLY_CONFIG, broker: earlyBroker },
    ]
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const stats = freshStats()
    stats.cycles = 2
    stats.scanned = 12
    stats.passed.conservative = 3
    stats.passed.early = 5

    await logSummary('hourly', strategies, stats)

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toMatch(/Cycles ce run\s*:\s*2\s*\|\s*Tokens évalués\s*:\s*12/)
    expect(output).toMatch(/Filtres CONSERVATIVE\s*:\s*3 passés \/ 12 évalués/)
    expect(output).toMatch(/Filtres EARLY\s*:\s*5 passés \/ 12 évalués/)
    expect(output).toMatch(/=== Positions ouvertes \(0\) ===/)
    expect(output).toMatch(/=== Fermées aujourd'hui \(0\) ===/)
    expect(output).toMatch(/Wallets trackés\s*:\s*0\s*\|\s*Avec signal/)
  })

  it('omits the Helius pool feed section entirely when no feed instance is passed (backward compatible)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await logSummary('hourly', [], freshStats())

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).not.toMatch(/Helius pool feed/)
  })

  it('reports the getTransaction call count when a Helius pool feed instance is passed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    heliusFeedGetTransactionCallsMadeMock.mockReturnValue(7)
    const { HeliusPoolFeed } = await import('../../services/uta/src/domain/trading/brokers/dex/helius-pool-feed.js')
    const feed = new HeliusPoolFeed({ onNewPool: vi.fn() })

    await logSummary('hourly', [], freshStats(), feed)

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toMatch(/Helius pool feed/)
    expect(output).toMatch(/getTransaction appelés depuis le démarrage\s*:\s*7/)
  })
})

describe('parseArgs', () => {
  it('defaults to chain=solana, interval=300, scanInterval=interval (decoupled default)', () => {
    expect(parseArgs([])).toEqual({ chain: 'solana', intervalSeconds: 300, scanIntervalSeconds: 300 })
  })

  it('parses --chain and --interval, defaulting scanIntervalSeconds to the same value', () => {
    expect(parseArgs(['--chain', 'ethereum', '--interval', '60'])).toEqual({ chain: 'ethereum', intervalSeconds: 60, scanIntervalSeconds: 60 })
  })

  it('parses --scan-interval independently of --interval', () => {
    expect(parseArgs(['--interval', '15', '--scan-interval', '30'])).toEqual({ chain: 'solana', intervalSeconds: 15, scanIntervalSeconds: 30 })
  })

  it('throws on an invalid --chain', () => {
    expect(() => parseArgs(['--chain', 'dogecoin'])).toThrow(/Invalid --chain/)
  })

  it('throws on an invalid --scan-interval', () => {
    expect(() => parseArgs(['--scan-interval', '0'])).toThrow(/Invalid --scan-interval/)
  })
})

describe('runLiveScan — clean shutdown', () => {
  it('exits promptly on SIGINT instead of waiting for the full interval', async () => {
    profilesMock.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    // Give the async setup (broker init, SIGINT listener registration) a moment to run.
    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGINT', 'SIGINT')

    await expect(promise).resolves.toBeUndefined()
  }, 10_000)
})

describe('runLiveScan — pump.fun feed lifecycle', () => {
  it('starts the pump.fun feed at startup and stops it on SIGINT', async () => {
    profilesMock.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(pumpFeedStartMock).toHaveBeenCalled()
    expect(pumpFeedStopMock).not.toHaveBeenCalled()

    process.emit('SIGINT', 'SIGINT')
    await promise

    expect(pumpFeedStopMock).toHaveBeenCalled()
  }, 10_000)
})

describe('runLiveScan — Helius pool feed lifecycle', () => {
  it('starts the Helius pool feed at startup and stops it on SIGINT, when HELIUS_API_KEY is set', async () => {
    vi.stubEnv('HELIUS_API_KEY', 'test-key')
    profilesMock.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(heliusFeedStartMock).toHaveBeenCalled()
    expect(heliusFeedStopMock).not.toHaveBeenCalled()

    process.emit('SIGINT', 'SIGINT')
    await promise

    expect(heliusFeedStopMock).toHaveBeenCalled()
  }, 10_000)

  it('never constructs/starts the Helius pool feed when HELIUS_API_KEY is unset', async () => {
    vi.stubEnv('HELIUS_API_KEY', '')
    profilesMock.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(heliusFeedStartMock).not.toHaveBeenCalled()

    process.emit('SIGINT', 'SIGINT')
    await promise

    // stop() is also never called on something that was never started — the
    // feed variable is null in this path, not an unstarted instance.
    expect(heliusFeedStopMock).not.toHaveBeenCalled()
  }, 10_000)
})

describe('priceFeed integration', () => {
  it('subscribes to priceFeed on a successful buy', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'subTok', ageMinutes: 100, priceUsd: '0.05', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'sub-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const subscribeSpy = vi.spyOn(priceFeed, 'subscribe')

    const decision = await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'subTok', 100, broker, pair({ address: 'subTok', ageMinutes: 100 }))

    expect(decision.tradeSimulated).toBe(true)
    expect(subscribeSpy).toHaveBeenCalledWith('pair-subTok')
  })

  it('unsubscribes from priceFeed when a position closes via checkExits', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'unsubTok', ageMinutes: 100, priceUsd: '0.05', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'unsub-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'unsubTok', 100, broker, pair({ address: 'unsubTok', ageMinutes: 100 }))

    const unsubscribeSpy = vi.spyOn(priceFeed, 'unsubscribe')
    // Force a stop_loss on the next checkExits pass via a crashed cached price.
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-unsubTok',
      priceUsd: 0.01,
      priceChange: {},
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })

    await checkExits('solana', broker, 'early')

    expect(unsubscribeSpy).toHaveBeenCalledWith('pair-unsubTok')
  })
})

describe('checkExits — stop_loss overshoot observability (2026-07-02)', () => {
  // pair()'s own default priceUsd is '0.10' (see the helper above) — the
  // direct 6th-arg pair passed to evaluateStrategy below has no priceUsd
  // override, so entryPrice for every position in this block is 0.10.
  const ENTRY_PRICE = 0.10

  it('logs and counts a significant overshoot (>10pp past configured stopLoss), including the previous tick price', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'overshootTok', ageMinutes: 100, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'overshoot-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'overshootTok', 100, broker, pair({ address: 'overshootTok', ageMinutes: 100 }))

    // First cycle: a safe price, to record lastCheckedPrice for the diff shown in the overshoot log.
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-overshootTok',
      priceUsd: ENTRY_PRICE * 1.04, // +4%, well above stopLoss
      priceChange: {},
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')
    expect(getStopLossOvershootCount()).toBe(0) // no exit yet — nothing to log

    // Second cycle: catastrophic crash, 35pp past EARLY_EXIT_CONFIG's -20% stopLoss (returnPct=-55%).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-overshootTok',
      priceUsd: ENTRY_PRICE * 0.45, // -55%
      priceChange: {},
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')

    expect(getStopLossOvershootCount()).toBe(1)
    const overshootLog = warnSpy.mock.calls.map(c => c.join(' ')).find(l => l.includes('stop_loss overshoot'))
    expect(overshootLog).toBeDefined()
    expect(overshootLog).toMatch(/return=-55\.0%/)
    expect(overshootLog).toMatch(/Previous check .*: 4\.0%/) // the safe price recorded on the first cycle
  })

  it('does NOT log or count a small/normal stop_loss (within 10pp of the configured threshold)', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'normalStopTok', ageMinutes: 100, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'normal-stop-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'normalStopTok', 100, broker, pair({ address: 'normalStopTok', ageMinutes: 100 }))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-normalStopTok',
      priceUsd: ENTRY_PRICE * 0.78, // -22% — past stopLoss(-20) but only 2pp beyond, not a significant overshoot
      priceChange: {},
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')

    expect(getStopLossOvershootCount()).toBe(0)
    expect(warnSpy.mock.calls.some(c => c.join(' ').includes('stop_loss overshoot'))).toBe(false)
  })

  it('does not log for a non-stop_loss exit reason, even a large move (e.g. take_profit)', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'takeProfitTok', ageMinutes: 100, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'take-profit-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'takeProfitTok', 100, broker, pair({ address: 'takeProfitTok', ageMinutes: 100 }))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-takeProfitTok',
      priceUsd: ENTRY_PRICE * 4.0, // +300%, past EARLY_EXIT_CONFIG's takeProfit
      priceChange: {},
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')

    expect(getStopLossOvershootCount()).toBe(0)
    expect(warnSpy.mock.calls.some(c => c.join(' ').includes('stop_loss overshoot'))).toBe(false)
  })
})

describe('checkExits — position-trajectory observability (2026-07-04)', () => {
  const ENTRY_PRICE = 0.10

  it('logs a trajectory tick for a fast-regime strategy (early) on a normal, non-exiting check', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'trajTok', ageMinutes: 100, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'traj-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'trajTok', 100, broker, pair({ address: 'trajTok', ageMinutes: 100 }))
    const [position] = await getOpenPositions()

    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-trajTok',
      priceUsd: ENTRY_PRICE * 1.08, // +8% — well inside every exit rule, nothing should fire
      priceChange: { m5: 3 },
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')

    const entries = await readPositionTrajectoryLog()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      positionId: position!.id,
      tokenAddress: 'trajTok',
      strategy: 'early',
      priceChangeM5: 3,
    })
    expect(entries[0]!['returnPct']).toBeCloseTo(8, 5)
  })

  it('still logs the final tick on a cycle that DOES trigger an exit — trajectory includes the last observed price, not just the ones before exit', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'trajExitTok', ageMinutes: 100, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'traj-exit-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'trajExitTok', 100, broker, pair({ address: 'trajExitTok', ageMinutes: 100 }))

    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-trajExitTok',
      priceUsd: ENTRY_PRICE * 0.70, // -30%, past the -20% stopLoss — triggers an exit this same cycle
      priceChange: { m5: -25 },
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')

    const entries = await readPositionTrajectoryLog()
    expect(entries).toHaveLength(1)
    expect(entries[0]!['returnPct']).toBeCloseTo(-30, 5)
  })

  it('accumulates one line per tick, keyed by positionId — reconstructing a trajectory is a groupBy + sort, not a lookup by mutable state', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'trajMultiTok', ageMinutes: 100, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'traj-multi-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'trajMultiTok', 100, broker, pair({ address: 'trajMultiTok', ageMinutes: 100 }))
    const [position] = await getOpenPositions()

    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-trajMultiTok', priceUsd: ENTRY_PRICE * 1.02, priceChange: { m5: 1 }, liquidityUsd: 50_000, timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-trajMultiTok', priceUsd: ENTRY_PRICE * 1.05, priceChange: { m5: 2 }, liquidityUsd: 50_000, timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'early')

    const entries = await readPositionTrajectoryLog()
    expect(entries).toHaveLength(2)
    expect(entries.every(e => e['positionId'] === position!.id)).toBe(true)
    expect(entries[0]!['returnPct']).toBeCloseTo(2, 5)
    expect(entries[1]!['returnPct']).toBeCloseTo(5, 5)
  })

  it('does NOT log for a main-loop (slow-cadence) strategy — conservative is not in the fast regime', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'trajSlowTok', ageMinutes: 400, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'traj-slow-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...CONSERVATIVE_CONFIG, requireGoPlus: false }, 'solana', 'trajSlowTok', 400, broker, pair({ address: 'trajSlowTok', ageMinutes: 400 }))

    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-trajSlowTok', priceUsd: ENTRY_PRICE * 1.05, priceChange: { m5: 2 }, liquidityUsd: 50_000, timestamp: Date.now(),
    })
    await checkExits('solana', broker, 'conservative')

    expect(await readPositionTrajectoryLog()).toHaveLength(0)
  })

  it('does not affect trading behavior — same exit decision and closedCount with or without the log', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'trajNoopTok', ageMinutes: 100, priceUsd: '0.10', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'traj-noop-test', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'trajNoopTok', 100, broker, pair({ address: 'trajNoopTok', ageMinutes: 100 }))

    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-trajNoopTok', priceUsd: ENTRY_PRICE * 0.70, priceChange: { m5: -25 }, liquidityUsd: 50_000, timestamp: Date.now(),
    })
    const closedCount = await checkExits('solana', broker, 'early')

    expect(closedCount).toBe(1)
    expect(await broker.getPositions()).toHaveLength(0)
  })
})

describe('evaluateStrategy — fastExitRegime stamping', () => {
  it('stamps fastExitRegime: true on an EARLY buy', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'fastRegimeEarlyTok', ageMinutes: 100, priceUsd: '0.05', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'fast-regime-early', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()

    await evaluateStrategy({ ...EARLY_CONFIG, useSolanaRpc: false }, 'solana', 'fastRegimeEarlyTok', 100, broker, pair({ address: 'fastRegimeEarlyTok', ageMinutes: 100 }))

    const positions = await getOpenPositions()
    expect(positions.find(p => p.tokenAddress === 'fastRegimeEarlyTok')?.fastExitRegime).toBe(true)
  })

  it('stamps fastExitRegime: true on an EARLY_STRICT buy', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'fastRegimeStrictTok', ageMinutes: 100, priceUsd: '0.05', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'fast-regime-strict', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()

    await evaluateStrategy({ ...EARLY_STRICT_CONFIG, useSolanaRpc: false }, 'solana', 'fastRegimeStrictTok', 100, broker, pair({ address: 'fastRegimeStrictTok', ageMinutes: 100 }))

    const positions = await getOpenPositions()
    expect(positions.find(p => p.tokenAddress === 'fastRegimeStrictTok')?.fastExitRegime).toBe(true)
  })

  // EARLY_WEB_FILTERED's own fastExitRegime stamp can no longer be observed
  // via a real buy now that EARLY_WEB_FILTERED_ENTRY_SUSPENDED gates it off
  // (see that flag's docstring) — the stamping logic itself isn't specific
  // to this label and stays covered by the EARLY/EARLY_STRICT cases above.

  it('leaves fastExitRegime undefined on a CONSERVATIVE buy — not in the fast regime', async () => {
    pairsMock.mockResolvedValue([pair({ address: 'slowRegimeTok', ageMinutes: 400, priceUsd: '0.05', liquidity: { usd: 50_000 } })])
    const broker = new DexBroker({ id: 'slow-regime', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()

    await evaluateStrategy({ ...CONSERVATIVE_CONFIG, requireGoPlus: false }, 'solana', 'slowRegimeTok', 400, broker, pair({ address: 'slowRegimeTok', ageMinutes: 400 }))

    const positions = await getOpenPositions()
    expect(positions.find(p => p.tokenAddress === 'slowRegimeTok')?.fastExitRegime).toBeUndefined()
  })
})

describe('EARLY_WEB_FILTERED_CONFIG', () => {
  it('isolates requireWebsite as the ONLY difference from EARLY_CONFIG — guards against accidentally stacking EARLY_STRICT-style filters onto it', () => {
    expect(EARLY_WEB_FILTERED_CONFIG.label).toBe('early_web_filtered')
    expect(EARLY_WEB_FILTERED_CONFIG.requireWebsite).toBe(true)
    expect({ ...EARLY_WEB_FILTERED_CONFIG, label: EARLY_CONFIG.label, requireWebsite: undefined })
      .toEqual({ ...EARLY_CONFIG, requireWebsite: undefined })
  })

  it('rejects a candidate with no website listed', async () => {
    const broker = new DexBroker({ id: 'web-filtered-reject', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const candidate = pair({ address: 'noWebsiteTok', ageMinutes: 100, priceUsd: '0.05', liquidity: { usd: 50_000 } }) // no `info` at all

    const decision = await evaluateStrategy({ ...EARLY_WEB_FILTERED_CONFIG, useSolanaRpc: false }, 'solana', 'noWebsiteTok', 100, broker, candidate)

    expect(decision.pass).toBe(false)
    expect(decision.reason).toMatch(/no website listed/i)
    expect(await broker.getPositions()).toHaveLength(0)
  })

  it('passes a candidate with a website listed but does not buy — entry suspended (see EARLY_WEB_FILTERED_ENTRY_SUSPENDED)', async () => {
    expect(EARLY_WEB_FILTERED_ENTRY_SUSPENDED).toBe(true) // guards this test against silently going stale if the flag is ever flipped back
    const broker = new DexBroker({ id: 'web-filtered-buy', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const candidate = pair({ address: 'hasWebsiteTok', ageMinutes: 100, priceUsd: '0.05', liquidity: { usd: 50_000 }, info: { websites: [{ url: 'https://example.com' }] } })

    const decision = await evaluateStrategy({ ...EARLY_WEB_FILTERED_CONFIG, useSolanaRpc: false }, 'solana', 'hasWebsiteTok', 100, broker, candidate)

    expect(decision.pass).toBe(true)
    expect(decision.tradeSimulated).toBe(false)
    expect(decision.reason).toMatch(/entry suspended/i)
    expect(await broker.getPositions()).toHaveLength(0)
  })
})

describe('EARLY_WEB_FILTERED_ENTRY_SUSPENDED', () => {
  it('is true (2026-07-04, reopen bar cleared at n=34 tokens but token-weighted return -3.95pp with a Q3->Q4 sign reversal) — pinned so a silent flip back is caught here rather than discovered live', () => {
    expect(EARLY_WEB_FILTERED_ENTRY_SUSPENDED).toBe(true)
  })

  it('an already-open EARLY_WEB_FILTERED position (restored from a previous session) is left alone — suspension is entry-only, exits still evaluated normally', async () => {
    // Age must fall inside EARLY_WEB_FILTERED_CONFIG's age window, otherwise
    // the age filter itself would reject before ever reaching hasOpenPosition.
    await openPosition(pair({ address: 'existingWebFilteredTok', ageMinutes: 100, priceUsd: '0.05' }), 'early_web_filtered', 0.05, 100, EARLY_EXIT_CONFIG)

    const broker = new DexBroker({ id: 'web-filtered-existing-position', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    await restoreOpenPositions([{ config: EARLY_WEB_FILTERED_CONFIG, broker }])

    const candidate = pair({ address: 'existingWebFilteredTok', ageMinutes: 100, priceUsd: '0.05', liquidity: { usd: 50_000 }, info: { websites: [{ url: 'https://example.com' }] } })
    const decision = await evaluateStrategy({ ...EARLY_WEB_FILTERED_CONFIG, useSolanaRpc: false }, 'solana', 'existingWebFilteredTok', 100, broker, candidate)

    expect(decision.pass).toBe(true)
    expect(decision.reason).toMatch(/already holding/i)
    expect(await broker.getPositions()).toHaveLength(1)
  })
})

describe('pump.fun watchlist', () => {
  function pumpToken(overrides: Partial<PumpFunToken> = {}): PumpFunToken {
    return {
      mintAddress: 'mintDefault',
      symbol: 'FOO',
      name: 'Foo Coin',
      createdAt: Date.now(),
      ...overrides,
    }
  }

  it('adds a newly detected token to the watchlist and records an initial zero-liquidity snapshot', async () => {
    await handleNewPumpToken(pumpToken({ mintAddress: 'mintX', symbol: 'FOO' }))

    expect(pumpWatchlist.has('mintX')).toBe(true)
    expect(pumpWatchlist.get('mintX')?.symbol).toBe('FOO')

    const raw = await readFile(dataPath('snapshots', 'mintX.json'), 'utf-8')
    const snapshots = JSON.parse(raw)
    expect(snapshots[0].liquidityUsd).toBe(0)
  })

  it('evaluates and removes a watchlist token once DexScreener indexes it with enough liquidity', async () => {
    pumpWatchlist.set('mintY', { detectedAt: Date.now(), symbol: 'BAR', mintAddress: 'mintY' })
    tokensBatchMock.mockResolvedValue(new Map([
      ['mintY', [pair({ address: 'mintY', ageMinutes: 1, liquidity: { usd: 15_000 } })]],
    ]))

    await checkPumpWatchlist('solana')

    expect(pumpWatchlist.has('mintY')).toBe(false)
  }, 20_000) // real (unmocked) TokenSecurityGuard network calls — see checkPumpWatchlist's docstring

  it('checks the whole watchlist in a single batched call, not one request per entry', async () => {
    pumpWatchlist.set('mintA', { detectedAt: Date.now(), symbol: 'A', mintAddress: 'mintA' })
    pumpWatchlist.set('mintB', { detectedAt: Date.now(), symbol: 'B', mintAddress: 'mintB' })
    tokensBatchMock.mockResolvedValue(new Map())

    await checkPumpWatchlist('solana')

    expect(tokensBatchMock).toHaveBeenCalledTimes(1)
    expect(tokensBatchMock).toHaveBeenCalledWith('solana', expect.arrayContaining(['mintA', 'mintB']))
    expect(pairsMock).not.toHaveBeenCalled()
  })

  it('leaves a not-yet-indexed token in the watchlist before the 20min staleness cutoff', async () => {
    pumpWatchlist.set('mintZ', { detectedAt: Date.now(), symbol: 'BAZ', mintAddress: 'mintZ' })
    tokensBatchMock.mockResolvedValue(new Map())

    await checkPumpWatchlist('solana')

    expect(pumpWatchlist.has('mintZ')).toBe(true)
  })

  it('removes a token that has never been indexed after 20 minutes (stillborn)', async () => {
    pumpWatchlist.set('mintOld', { detectedAt: Date.now() - 21 * 60_000, symbol: 'OLD', mintAddress: 'mintOld' })
    tokensBatchMock.mockResolvedValue(new Map())

    await checkPumpWatchlist('solana')

    expect(pumpWatchlist.has('mintOld')).toBe(false)
  })

  it('does not crash and leaves the watchlist untouched (retry next cycle) if the batch call itself throws', async () => {
    pumpWatchlist.set('mintErr', { detectedAt: Date.now(), symbol: 'ERR', mintAddress: 'mintErr' })
    tokensBatchMock.mockImplementation(() => { throw new Error('boom') })

    await expect(checkPumpWatchlist('solana')).resolves.toBeUndefined()
    expect(pumpWatchlist.has('mintErr')).toBe(true)
  })

  it('evicts the oldest entry (FIFO) once the watchlist reaches its 50-token cap', async () => {
    for (let i = 0; i < 50; i++) {
      await handleNewPumpToken(pumpToken({ mintAddress: `mint${i}`, symbol: `T${i}` }))
    }
    expect(pumpWatchlist.has('mint0')).toBe(true)
    expect(pumpWatchlist.size).toBe(50)

    await handleNewPumpToken(pumpToken({ mintAddress: 'mintNew', symbol: 'NEW' }))

    expect(pumpWatchlist.size).toBe(50)
    expect(pumpWatchlist.has('mint0')).toBe(false) // oldest evicted
    expect(pumpWatchlist.has('mint1')).toBe(true) // second-oldest survives
    expect(pumpWatchlist.has('mintNew')).toBe(true)
  })
})

describe('Helius pool watchlist', () => {
  function discoveredPool(overrides: Partial<DiscoveredPool> = {}): DiscoveredPool {
    return {
      mintAddress: 'heliusMintDefault',
      discoveredAt: Date.now(),
      signature: 'sig1',
      ...overrides,
    }
  }

  it('adds a newly discovered pool to the watchlist', () => {
    handleNewHeliusPool(discoveredPool({ mintAddress: 'heliusMintX' }))

    expect(heliusPoolWatchlist.has('heliusMintX')).toBe(true)
    expect(heliusPoolWatchlist.get('heliusMintX')?.pairResolutionLoggedAt).toBeUndefined()
    expect(heliusPoolWatchlist.get('heliusMintX')?.oldPipelineSightingLoggedAt).toBeUndefined()
  })

  it('dedupes against an entry already present in the pump.fun (pumpportal.fun) watchlist', () => {
    pumpWatchlist.set('sharedMint', { detectedAt: Date.now(), symbol: 'SHARED', mintAddress: 'sharedMint' })

    handleNewHeliusPool(discoveredPool({ mintAddress: 'sharedMint' }))

    expect(heliusPoolWatchlist.has('sharedMint')).toBe(false)
  })

  it('dedupes the reverse direction — a pump.fun-feed detection is skipped if Helius already found the same mint', async () => {
    handleNewHeliusPool(discoveredPool({ mintAddress: 'sharedMint2' }))

    await handleNewPumpToken({ mintAddress: 'sharedMint2', symbol: 'SHARED2', name: 'Shared Two', createdAt: Date.now() })

    expect(pumpWatchlist.has('sharedMint2')).toBe(false)
    expect(heliusPoolWatchlist.has('sharedMint2')).toBe(true) // untouched — still only tracked once, by Helius
  })

  it('logs and marks pairResolutionLoggedAt the first time DexScreener resolves the pair', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    heliusPoolWatchlist.set('heliusMintY', { discoveredAt: Date.now() - 5000, mintAddress: 'heliusMintY' })
    tokensBatchMock.mockResolvedValue(new Map([
      ['heliusMintY', [pair({ address: 'heliusMintY', ageMinutes: 1, liquidity: { usd: 15_000 } })]],
    ]))

    await checkHeliusPoolWatchlist('solana')

    expect(heliusPoolWatchlist.get('heliusMintY')?.pairResolutionLoggedAt).toBeDefined()
    expect(logSpy.mock.calls.some(c => String(c[0]).includes('DexScreener pair resolved'))).toBe(true)
    logSpy.mockRestore()
  })

  it('does not re-log pair resolution on a later cycle once already logged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    heliusPoolWatchlist.set('heliusMintZ', { discoveredAt: Date.now() - 5000, mintAddress: 'heliusMintZ', pairResolutionLoggedAt: Date.now() - 1000 })
    tokensBatchMock.mockResolvedValue(new Map([
      ['heliusMintZ', [pair({ address: 'heliusMintZ', ageMinutes: 1, liquidity: { usd: 15_000 } })]],
    ]))

    await checkHeliusPoolWatchlist('solana')

    const resolutionLogs = logSpy.mock.calls.filter(c => String(c[0]).includes('DexScreener pair resolved'))
    expect(resolutionLogs).toHaveLength(0)
    logSpy.mockRestore()
  })

  it('leaves an entry with only one of the two comparisons logged in the watchlist (not stale yet)', async () => {
    heliusPoolWatchlist.set('heliusMintW', { discoveredAt: Date.now(), mintAddress: 'heliusMintW', pairResolutionLoggedAt: Date.now() })
    tokensBatchMock.mockResolvedValue(new Map())

    await checkHeliusPoolWatchlist('solana')

    expect(heliusPoolWatchlist.has('heliusMintW')).toBe(true)
  })

  it('removes an entry once BOTH comparisons have been logged', async () => {
    const now = Date.now()
    heliusPoolWatchlist.set('heliusMintDone', { discoveredAt: now, mintAddress: 'heliusMintDone', pairResolutionLoggedAt: now, oldPipelineSightingLoggedAt: now })
    tokensBatchMock.mockResolvedValue(new Map())

    await checkHeliusPoolWatchlist('solana')

    expect(heliusPoolWatchlist.has('heliusMintDone')).toBe(false)
  })

  it('removes a stale entry after 20 minutes even if neither comparison ever logged', async () => {
    heliusPoolWatchlist.set('heliusMintOld', { discoveredAt: Date.now() - 21 * 60_000, mintAddress: 'heliusMintOld' })
    tokensBatchMock.mockResolvedValue(new Map())

    await checkHeliusPoolWatchlist('solana')

    expect(heliusPoolWatchlist.has('heliusMintOld')).toBe(false)
  })

  it('does not crash and leaves the watchlist untouched if the batch call itself throws', async () => {
    heliusPoolWatchlist.set('heliusMintErr', { discoveredAt: Date.now(), mintAddress: 'heliusMintErr' })
    tokensBatchMock.mockImplementation(() => { throw new Error('boom') })

    await expect(checkHeliusPoolWatchlist('solana')).resolves.toBeUndefined()
    expect(heliusPoolWatchlist.has('heliusMintErr')).toBe(true)
  })

  it('evicts the oldest entry (FIFO) once the watchlist reaches its 50-token cap', () => {
    for (let i = 0; i < 50; i++) {
      handleNewHeliusPool(discoveredPool({ mintAddress: `heliusMint${i}`, signature: `sig${i}` }))
    }
    expect(heliusPoolWatchlist.has('heliusMint0')).toBe(true)
    expect(heliusPoolWatchlist.size).toBe(50)

    handleNewHeliusPool(discoveredPool({ mintAddress: 'heliusMintNew', signature: 'sigNew' }))

    expect(heliusPoolWatchlist.size).toBe(50)
    expect(heliusPoolWatchlist.has('heliusMint0')).toBe(false)
    expect(heliusPoolWatchlist.has('heliusMintNew')).toBe(true)
  })

  // Cross-check inside runScanPhase's own loop — this is the "old pipeline
  // caught up" half of the latency comparison; the "pair resolved" half is
  // covered by checkHeliusPoolWatchlist above.
  it('runScanPhase logs the old-pipeline-sighting comparison when it independently re-discovers a Helius-tracked mint', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    heliusPoolWatchlist.set('crossCheckMint', { discoveredAt: Date.now() - 10_000, mintAddress: 'crossCheckMint' })
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'crossCheckMint' }])
    pairsMock.mockResolvedValue([pair({ address: 'crossCheckMint', ageMinutes: 5, liquidity: { usd: 15_000 } })])

    await runScanPhase('solana', [], new RateLimiter(), freshStats())

    expect(logSpy.mock.calls.some(c => String(c[0]).includes('old DexScreener-profiles pipeline caught up'))).toBe(true)
    expect(heliusPoolWatchlist.get('crossCheckMint')?.oldPipelineSightingLoggedAt).toBeDefined()
    logSpy.mockRestore()
  })

  it('runScanPhase does not re-log the old-pipeline sighting on a later cycle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    heliusPoolWatchlist.set('crossCheckMint2', { discoveredAt: Date.now() - 10_000, mintAddress: 'crossCheckMint2', oldPipelineSightingLoggedAt: Date.now() - 5000 })
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'crossCheckMint2' }])
    pairsMock.mockResolvedValue([pair({ address: 'crossCheckMint2', ageMinutes: 5, liquidity: { usd: 15_000 } })])

    await runScanPhase('solana', [], new RateLimiter(), freshStats())

    const crossCheckLogs = logSpy.mock.calls.filter(c => String(c[0]).includes('old DexScreener-profiles pipeline caught up'))
    expect(crossCheckLogs).toHaveLength(0)
    logSpy.mockRestore()
  })
})

describe('silent-distribution observability (detectSilentDistributionPattern)', () => {
  it('logs a candidate matching the pattern — high h1 buys with a weak/negative h1 price response', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'silentDistTok' }])
    pairsMock.mockResolvedValue([pair({
      address: 'silentDistTok', ageMinutes: 60, liquidity: { usd: 20_000 },
      txns: { h1: { buys: 4000, sells: 50 } },
      priceChange: { h1: -10, m5: -1 },
    })])

    await runScanPhase('solana', [], new RateLimiter(), freshStats())

    const entries = await readSilentDistributionLog()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ tokenAddress: 'silentDistTok', buysH1: 4000, sellsH1: 50, priceChangeH1: -10, priceChangeM5: -1, passedStrategies: [] })
  })

  it('does not log a candidate with high buys but a strong positive price response', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'normalPumpTok' }])
    pairsMock.mockResolvedValue([pair({
      address: 'normalPumpTok', ageMinutes: 60, liquidity: { usd: 20_000 },
      txns: { h1: { buys: 4000, sells: 50 } },
      priceChange: { h1: 50, m5: 5 },
    })])

    await runScanPhase('solana', [], new RateLimiter(), freshStats())

    expect(await readSilentDistributionLog()).toHaveLength(0)
  })

  it('does not log a candidate with a weak price response but low buy count', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'lowActivityTok' }])
    pairsMock.mockResolvedValue([pair({
      address: 'lowActivityTok', ageMinutes: 60, liquidity: { usd: 20_000 },
      txns: { h1: { buys: 100, sells: 10 } },
      priceChange: { h1: -20, m5: -2 },
    })])

    await runScanPhase('solana', [], new RateLimiter(), freshStats())

    expect(await readSilentDistributionLog()).toHaveLength(0)
  })

  it('does not log when priceChange.h1 or txns.h1.buys is missing — no data is not treated as a match', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'noDataTok' }])
    pairsMock.mockResolvedValue([pair({ address: 'noDataTok', ageMinutes: 60, liquidity: { usd: 20_000 } })])

    await runScanPhase('solana', [], new RateLimiter(), freshStats())

    expect(await readSilentDistributionLog()).toHaveLength(0)
  })

  it('records which strategies passed for a matching candidate this same cycle', async () => {
    profilesMock.mockResolvedValue([{ chainId: 'solana', tokenAddress: 'silentDistBoughtTok' }])
    const candidate = pair({
      address: 'silentDistBoughtTok', ageMinutes: 100, liquidity: { usd: 50_000 },
      txns: { h1: { buys: 4000, sells: 50 }, m5: { buys: 20, sells: 2 } },
      priceChange: { h1: -10, m5: -1 },
    })
    pairsMock.mockResolvedValue([candidate])
    const broker = new DexBroker({ id: 'silent-dist-bought', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()

    await runScanPhase('solana', [{ config: { ...EARLY_CONFIG, useSolanaRpc: false }, broker }], new RateLimiter(), freshStats())

    const entries = await readSilentDistributionLog()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.passedStrategies).toEqual(['early'])
  })
})

describe('handleGradImmediate', () => {
  function gradEvent(overrides: Partial<GraduationEvent> = {}): GraduationEvent {
    return { mintAddress: 'gradTok', graduatedAt: Date.now(), signature: 'sig-grad', source: 'helius_logs', ...overrides }
  }

  it('skips when liquidity < $10,000 — no position opened', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const broker = new DexBroker({ id: 'test-grad-imm-liq', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    pairForMintMock.mockResolvedValue(pair({ address: 'gradTok', ageMinutes: 0, liquidity: { usd: 5000 } }))

    const promise = handleGradImmediate('solana', gradEvent(), broker)
    await vi.advanceTimersByTimeAsync(90_000)
    await promise

    expect(await broker.getPositions()).toHaveLength(0)
    vi.useRealTimers()
  })

  it('skips when mint or freeze authority is active on the RPC check', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const broker = new DexBroker({ id: 'test-grad-imm-auth', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    pairForMintMock.mockResolvedValue(pair({ address: 'gradTok', ageMinutes: 0, liquidity: { usd: 50_000 }, priceChange: { m5: 5 } }))
    mintAuthorityMock.mockResolvedValue({ hasMintAuthority: true, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'gradTok', fromCache: false, rpcAvailable: true })

    const promise = handleGradImmediate('solana', gradEvent(), broker)
    await vi.advanceTimersByTimeAsync(90_000)
    await promise

    expect(await broker.getPositions()).toHaveLength(0)
    vi.useRealTimers()
  })

  it('buys when liquidity/momentum/mint-authority checks all pass', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const broker = new DexBroker({ id: 'test-grad-imm-buy', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    pairForMintMock.mockResolvedValue(pair({ address: 'gradTok', ageMinutes: 0, liquidity: { usd: 50_000 }, priceChange: { m5: 5 } }))
    mintAuthorityMock.mockResolvedValue({ hasMintAuthority: false, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'gradTok', fromCache: false, rpcAvailable: true })

    const promise = handleGradImmediate('solana', gradEvent(), broker)
    await vi.advanceTimersByTimeAsync(90_000)
    await promise

    expect(await broker.getPositions()).toHaveLength(1)
    vi.useRealTimers()
  })

  it('marks the opened position with fastExitRegime: true, for the 2026-07-02 clean-baseline separation (see OpenPosition.fastExitRegime)', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const broker = new DexBroker({ id: 'test-grad-imm-regime', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    pairForMintMock.mockResolvedValue(pair({ address: 'gradTok', ageMinutes: 0, liquidity: { usd: 50_000 }, priceChange: { m5: 5 } }))
    mintAuthorityMock.mockResolvedValue({ hasMintAuthority: false, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'gradTok', fromCache: false, rpcAvailable: true })

    const promise = handleGradImmediate('solana', gradEvent(), broker)
    await vi.advanceTimersByTimeAsync(90_000)
    await promise

    const positions = await getOpenPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0]!.fastExitRegime).toBe(true)
    vi.useRealTimers()
  })
})

describe('handleGradDip', () => {
  it('no-op when there are no eligible dip candidates', async () => {
    const broker = new DexBroker({ id: 'test-grad-dip-empty', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const tracker = new GraduatedTokensTracker() // never seeded — getEligibleForDip() is always []

    const result = await handleGradDip('solana', broker, tracker)

    expect(result).toEqual({ watched: 0, bought: 0 })
    expect(pairForMintMock).not.toHaveBeenCalled()
  })

  async function seedDipCandidate(tracker: InstanceType<typeof GraduatedTokensTracker>, mint: string) {
    await tracker.add({ mintAddress: mint, graduatedAt: Date.now(), signature: 'sig-dip', source: 'helius_logs' })
    await tracker.updatePrice(mint, 1.0, 50_000) // sets peak at 1.0
    await tracker.updatePrice(mint, 0.6, 50_000) // -40% from peak — inside the -25%/-60% dip band
  }

  it('buys a fresh dip candidate when no position is already open on it', async () => {
    const broker = new DexBroker({ id: 'test-grad-dip-buy', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const tracker = new GraduatedTokensTracker()
    await seedDipCandidate(tracker, 'dipTok')
    pairForMintMock.mockResolvedValue(pair({ address: 'dipTok', ageMinutes: 30, priceUsd: '0.6', liquidity: { usd: 50_000 }, priceChange: { m5: 5 }, volume: { h1: 1000 } }))
    mintAuthorityMock.mockResolvedValue({ hasMintAuthority: false, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'dipTok', fromCache: false, rpcAvailable: true })

    const result = await handleGradDip('solana', broker, tracker)

    expect(result).toEqual({ watched: 1, bought: 1 })
    expect(await broker.getPositions()).toHaveLength(1)
  })

  it('fixed 2026-07-03: skips a dip candidate it already holds an open position on — no duplicate/overlapping buy', async () => {
    const broker = new DexBroker({ id: 'test-grad-dip-dedup', chain: 'solana', paper: true, paperCashUsd: 1000 })
    await broker.init()
    const tracker = new GraduatedTokensTracker()
    await seedDipCandidate(tracker, 'dipTok')
    pairForMintMock.mockResolvedValue(pair({ address: 'dipTok', ageMinutes: 30, priceUsd: '0.6', liquidity: { usd: 50_000 }, priceChange: { m5: 5 }, volume: { h1: 1000 } }))
    mintAuthorityMock.mockResolvedValue({ hasMintAuthority: false, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'dipTok', fromCache: false, rpcAvailable: true })

    // Pre-existing open position on the same mint — as if a prior handleGradDip
    // cycle already bought this dip and it hasn't exited yet. hasOpenPosition()
    // reads the BROKER's own state, not position-tracker.ts's file records
    // directly, so restoreOpenPositions() is needed to hydrate it — same
    // pattern as the "prevents a duplicate buy on a token restored from a
    // previous session" test above.
    await openPosition(pair({ address: 'dipTok', ageMinutes: 30, priceUsd: '0.6' }), 'grad_dip', 0.6, 30, GRAD_DIP_EXIT_CONFIG)
    await restoreOpenPositions([{ config: GRAD_DIP_CONFIG, broker }])

    const result = await handleGradDip('solana', broker, tracker)

    expect(result).toEqual({ watched: 1, bought: 0 })
    // Exactly 1 call: handleGradDip's own price-refresh pass over every
    // tracked token (unconditional, runs before the dip-candidate loop).
    // The hasOpenPosition() guard sits inside that later loop and must
    // fire BEFORE its own fetchPairForMint call — so still 1, not 2, proves
    // the guard is a genuine early skip rather than a later check failing.
    expect(pairForMintMock).toHaveBeenCalledTimes(1)
    expect(await broker.getPositions()).toHaveLength(1)
  })
})

describe('GRAD_DIP_ENTRY_SUSPENDED', () => {
  it('is true (2026-07-03, no positive signal on clean n=33/12 independent tokens) — pinned so a silent flip back is caught here rather than discovered live', () => {
    expect(GRAD_DIP_ENTRY_SUSPENDED).toBe(true)
  })
})

describe('runLiveScan — Helius pool feed wires onGraduation to handleGradImmediate', () => {
  it('a captured graduation event is added to the graduated tracker and (once 90s pass) attempted as a buy', async () => {
    vi.stubEnv('HELIUS_API_KEY', 'test-key')
    profilesMock.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    pairForMintMock.mockResolvedValue(pair({ address: 'wiredGradTok', ageMinutes: 0, liquidity: { usd: 50_000 }, priceChange: { m5: 5 } }))
    mintAuthorityMock.mockResolvedValue({ hasMintAuthority: false, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'wiredGradTok', fromCache: false, rpcAvailable: true })

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(capturedHeliusFeedConfig?.onGraduation).toBeTypeOf('function')
    capturedHeliusFeedConfig!.onGraduation!({ mintAddress: 'wiredGradTok', graduatedAt: Date.now(), signature: 'sig-wired', source: 'helius_logs' })
    // Persisted synchronously enough (graduatedTracker.add awaits its own
    // write) that a short real-time tick is enough to observe it on disk —
    // no fake timers needed for this part, only for the 90s buy delay below.
    await new Promise(resolve => setTimeout(resolve, 50))
    const graduatedFile = JSON.parse(await readFile(dataPath('graduated', 'active.json'), 'utf-8'))
    expect(graduatedFile.some((t: { mintAddress: string }) => t.mintAddress === 'wiredGradTok')).toBe(true)

    process.emit('SIGINT', 'SIGINT')
    await promise
  }, 10_000)

  it('a duplicate graduation event for an already-tracked mint never triggers a second handleGradImmediate attempt', async () => {
    vi.stubEnv('HELIUS_API_KEY', 'test-key')
    profilesMock.mockResolvedValue([])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    pairForMintMock.mockResolvedValue(pair({ address: 'dupGradTok', ageMinutes: 0, liquidity: { usd: 50_000 }, priceChange: { m5: 5 } }))

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100))

    const event = { mintAddress: 'dupGradTok', graduatedAt: Date.now(), signature: 'sig-dup-1', source: 'helius_logs' as const }
    capturedHeliusFeedConfig!.onGraduation!(event)
    capturedHeliusFeedConfig!.onGraduation!({ ...event, signature: 'sig-dup-2' }) // real live scenario: same mint, different signature
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(logSpy.mock.calls.some(c => c.join(' ').includes('already tracked — skipping duplicate GRAD_IMMEDIATE trigger'))).toBe(true)
    // handleGradImmediate's first action after its 90s sleep is fetchPairForMint —
    // it hasn't fired yet (sleep pending), so 0 calls here proves the SECOND
    // onGraduation never even started a handleGradImmediate run, not just
    // that it would have failed some later check.
    expect(pairForMintMock).not.toHaveBeenCalled()

    process.emit('SIGINT', 'SIGINT')
    await promise
  }, 10_000)

  it('with GRAD_IMMEDIATE_ENTRY_SUSPENDED true (2026-07-02, negative expectancy — see its docstring), a fresh graduation event is tracked but never reaches handleGradImmediate\'s buy path', async () => {
    expect(GRAD_IMMEDIATE_ENTRY_SUSPENDED).toBe(true) // guards this test against silently going stale if the flag is ever flipped back
    vi.stubEnv('HELIUS_API_KEY', 'test-key')
    profilesMock.mockResolvedValue([])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    pairForMintMock.mockResolvedValue(pair({ address: 'suspendedGradTok', ageMinutes: 0, liquidity: { usd: 50_000 }, priceChange: { m5: 5 } }))
    mintAuthorityMock.mockResolvedValue({ hasMintAuthority: false, hasFreezeAuthority: false, decimals: 6, supply: '0', mintAddress: 'suspendedGradTok', fromCache: false, rpcAvailable: true })

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100))

    capturedHeliusFeedConfig!.onGraduation!({ mintAddress: 'suspendedGradTok', graduatedAt: Date.now(), signature: 'sig-suspended', source: 'helius_logs' })
    await new Promise(resolve => setTimeout(resolve, 50))

    // Still tracked (GRAD_DIP relies on the same graduatedTracker entry) —
    // suspension is entry-only, not a graduation-detection cut.
    const graduatedFile = JSON.parse(await readFile(dataPath('graduated', 'active.json'), 'utf-8'))
    expect(graduatedFile.some((t: { mintAddress: string }) => t.mintAddress === 'suspendedGradTok')).toBe(true)
    expect(logSpy.mock.calls.some(c => c.join(' ').includes('GRAD_IMMEDIATE entry suspended'))).toBe(true)
    // No 90s advance needed: suspension short-circuits before handleGradImmediate's
    // own sleep, so fetchPairForMint is never reached even without waiting it out.
    expect(pairForMintMock).not.toHaveBeenCalled()

    process.emit('SIGINT', 'SIGINT')
    await promise
  }, 10_000)
})

describe('runLiveScan — shared fast exit-check timer (early / early_strict / grad_immediate)', () => {
  // Real timers throughout — fake timers interacted badly with the real
  // fs I/O in getOpenPositions()/checkExits() (position-tracker.ts reads/
  // writes real files), producing flaky false negatives and hangs. A short
  // real-time wait (well under this file's existing 10s test timeout
  // budget for other runLiveScan tests) is simpler and reliable here.
  it('closes a grad_immediate position on its own ~5s timer, without waiting for the (much longer) main loop --interval', async () => {
    profilesMock.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    // Pre-seed a grad_immediate position, exactly as restoreOpenPositions would find on a real restart.
    await openPosition(pair({ address: 'fastExitTok', ageMinutes: 0, priceUsd: '1.0' }), 'grad_immediate', 1.0, 0, GRAD_IMMEDIATE_EXIT_CONFIG)

    // Crashed price, past GRAD_IMMEDIATE_EXIT_CONFIG's stopLoss (-20).
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-fastExitTok',
      priceUsd: 0.7, // -30%
      priceChange: {},
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })

    // --interval far larger than the 5s fast timer — if the position closes
    // at all within this test, it can only be via the dedicated fast timer,
    // not the main loop's slow exit pass.
    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100)) // let async startup (broker init, restoreOpenPositions) settle

    let openPositions = await getOpenPositions()
    expect(openPositions.some(p => p.tokenAddress === 'fastExitTok')).toBe(true) // still open — fast timer hasn't fired yet

    await new Promise(resolve => setTimeout(resolve, 5_300)) // FAST_EXIT_CHECK_INTERVAL_MS (5000) + margin

    openPositions = await getOpenPositions()
    expect(openPositions.some(p => p.tokenAddress === 'fastExitTok')).toBe(false) // closed by the fast timer

    process.emit('SIGINT', 'SIGINT')
    await promise
  }, 15_000)

  it('closes an EARLY position on the same shared ~5s timer (extended 2026-07-02 from grad_immediate-only)', async () => {
    profilesMock.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await openPosition(pair({ address: 'fastExitEarlyTok', ageMinutes: 60, priceUsd: '1.0' }), 'early', 1.0, 60, EARLY_EXIT_CONFIG)
    vi.spyOn(priceFeed, 'getLatestPrice').mockReturnValue({
      pairAddress: 'pair-fastExitEarlyTok',
      priceUsd: 0.7, // -30% — past EARLY_EXIT_CONFIG's stopLoss
      priceChange: {},
      liquidityUsd: 50_000,
      timestamp: Date.now(),
    })

    const promise = runLiveScan(['--chain', 'solana', '--interval', '3600'])
    await new Promise(resolve => setTimeout(resolve, 100))

    let openPositions = await getOpenPositions()
    expect(openPositions.some(p => p.tokenAddress === 'fastExitEarlyTok')).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 5_300))

    openPositions = await getOpenPositions()
    expect(openPositions.some(p => p.tokenAddress === 'fastExitEarlyTok')).toBe(false)

    process.emit('SIGINT', 'SIGINT')
    await promise
  }, 15_000)

  // NOTE: a companion test asserting "non-fast-regime strategies are
  // untouched by the fast timer within 5s" was attempted and removed — its
  // premise didn't hold. runExitsPhase's very first call happens
  // unconditionally on the main loop's FIRST iteration (before that loop's
  // own sleep(intervalSeconds) ever runs), so a crashed position for ANY
  // strategy already closes near-instantly at startup regardless of
  // --interval — pre-existing behavior, unrelated to this fix, and not
  // something a 5s-window assertion can distinguish from "closed by the
  // fast timer." What actually matters for correctness (fast-regime
  // strategies excluded from mainLoopExitStrategies) doesn't need its own
  // test: checkExits is idempotent (a position already closed simply won't
  // reappear in getOpenPositions()), so even a hypothetical double-check
  // would be wasteful, never incorrect.
})
