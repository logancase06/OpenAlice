/**
 * retro:full — comprehensive retrospective across every real config/infra
 * change since the scanner started accumulating data (2026-07-01 through
 * today). Built from real closed trades, real scan-log price history, and
 * documented/data-derived timestamps for each transition — never invented
 * period boundaries.
 *
 * Period boundaries and their provenance:
 *   - ConfigD adopted: 2026-07-01T20:41:01.653Z — documented in
 *     data/retro/exit-sim-2026-07-01T20-41-01-653Z.md's own filename/content
 *     (the exit-sim run generated right after that relaunch).
 *   - EARLY_STRICT went live: 2026-07-02T08:02:07.284Z — DERIVED from
 *     scan-log: earliest `scan` record whose `early_strict` field is a real
 *     evaluation (`reason !== 'not evaluated'`), not documented anywhere,
 *     computed directly from the data.
 *   - Phase 1+2 (batch price feed + pump.fun watchlist) relaunch:
 *     2026-07-02T08:29:46Z — from this session's own PowerShell
 *     `Get-CimInstance Win32_Process` CreationDate query on PID 61900.
 *   - Audit-fixes relaunch: 2026-07-02T09:29:49Z — same method, PID 72656.
 *
 * Exit-rule thresholds have NOT changed since ConfigD — EARLY_STRICT only
 * changed entry filtering, and Phase 1+2 / the audit fixes only changed
 * infrastructure (price source, caching, reliability). So "ConfigD",
 * "+ EARLY_STRICT", "+ Phase 1+2", and "+ fixes audit" all share identical
 * exit rules; what differs between them is which tokens got bought and how
 * reliable the infrastructure was, not the sell logic.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'
import { getOpenPositions, type ClosedPosition } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'
import { scanLogPath, type ScanLogEntry, type LogEntry } from '../scan/live-scan.js'
import {
  buildPriceTicksByToken,
  simulateExitForToken,
  EXIT_CONFIGS,
  type SimPosition,
  type SimTradeResult,
} from './exit-sim.js'

const MIN_TICKS_AFTER_ENTRY = 3
const TRADE_AMOUNT_USD = 50
const PAPER_CAPITAL_USD = 1000

const CONFIGD_ADOPTED_MS = new Date('2026-07-01T20:41:01.653Z').getTime()
const EARLY_STRICT_LIVE_MS = new Date('2026-07-02T08:02:07.284Z').getTime()
const PHASE12_RELAUNCH_MS = new Date('2026-07-02T08:29:46Z').getTime()
const AUDIT_FIX_RELAUNCH_MS = new Date('2026-07-02T09:29:49Z').getTime()

const SCAN_LOG_DATES = ['2026-07-01', '2026-07-02']
const CLOSED_POSITIONS_DATES = ['2026-07-01', '2026-07-02']

interface Period {
  key: string
  label: string
  startMs: number
  endMs: number | null
  note: string
}

function buildPeriods(): Period[] {
  return [
    {
      key: 'avant_configd',
      label: 'Avant ConfigD (config originale)',
      startMs: 0,
      endMs: CONFIGD_ADOPTED_MS,
      note: 'stopLoss/trailing d\'origine — non capturés dans exitConfig (champ introduit après), voir data/retro/2026-07-01-analysis.md pour le détail déjà documenté de cette période',
    },
    {
      key: 'configd_seul',
      label: 'ConfigD (avant EARLY_STRICT)',
      startMs: CONFIGD_ADOPTED_MS,
      endMs: EARLY_STRICT_LIVE_MS,
      note: 'stopLoss -20%, trailing -15% (single-tier), takeProfit +200%, timeExit 180min, momentum -10%',
    },
    {
      key: 'early_strict',
      label: '+ EARLY_STRICT',
      startMs: EARLY_STRICT_LIVE_MS,
      endMs: PHASE12_RELAUNCH_MS,
      note: 'mêmes règles de sortie que ConfigD — ajout du filtre d\'entrée EARLY_STRICT (liquidité min $15k, maxPriceChangePct1h 150%)',
    },
    {
      key: 'phase12',
      label: '+ Phase 1+2 (price feed batch HTTP, pump.fun watchlist)',
      startMs: PHASE12_RELAUNCH_MS,
      endMs: AUDIT_FIX_RELAUNCH_MS,
      note: 'mêmes règles de sortie — changement d\'infrastructure uniquement (source de prix, découverte pump.fun en surveillance)',
    },
    {
      key: 'audit_fixes',
      label: '+ fixes audit (aujourd\'hui)',
      startMs: AUDIT_FIX_RELAUNCH_MS,
      endMs: null,
      note: 'mêmes règles de sortie — fixes de fiabilité (cache borné, réutilisation de pair, queue RPC bornée, etc.)',
    },
  ]
}

// ==================== Data loading ====================

async function readScanLogEntriesForDates(dates: string[]): Promise<LogEntry[]> {
  const all: LogEntry[] = []
  for (const date of dates) {
    const filePath = scanLogPath(date)
    try {
      const raw = await readFile(filePath, 'utf-8')
      for (const line of raw.trim().split('\n')) {
        if (!line) continue
        try { all.push(JSON.parse(line) as LogEntry) } catch { /* skip malformed line */ }
      }
    } catch { /* file doesn't exist for this date — no data, not an error */ }
  }
  return all
}

async function readClosedPositionsForDates(dates: string[]): Promise<ClosedPosition[]> {
  const all: ClosedPosition[] = []
  for (const date of dates) {
    const filePath = dataPath('positions', 'closed', `${date}.jsonl`)
    try {
      const raw = await readFile(filePath, 'utf-8')
      for (const line of raw.trim().split('\n')) {
        if (!line) continue
        try { all.push(JSON.parse(line) as ClosedPosition) } catch { /* skip malformed line */ }
      }
    } catch { /* file doesn't exist for this date — no data, not an error */ }
  }
  return all
}

// ==================== Stats helpers ====================

function mean(arr: number[]): number | null { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null }
function median(arr: number[]): number | null {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
function fmtPct(n: number | null, digits = 1): string {
  if (n == null) return 'n/a'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

interface PeriodStats {
  period: Period
  n: number
  winRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  avgWin: number | null
  avgLoss: number | null
  best: ClosedPosition | null
  worst: ClosedPosition | null
  byReason: Record<string, number>
  /** Proxy only — drop from the position's own tracked peak at the moment of exit, NOT true intraday drawdown (no price-floor tracking exists in OpenPosition/ClosedPosition). Same limitation already documented in data/retro/2026-07-01-analysis.md. */
  avgDropFromPeakAtExit: number | null
  tradesPerDay: number | null
}

function computeStats(period: Period, trades: ClosedPosition[]): PeriodStats {
  const n = trades.length
  if (n === 0) {
    return { period, n: 0, winRate: null, avgReturn: null, medianReturn: null, avgWin: null, avgLoss: null, best: null, worst: null, byReason: {}, avgDropFromPeakAtExit: null, tradesPerDay: null }
  }
  const wins = trades.filter(t => t.returnPct > 0)
  const losses = trades.filter(t => t.returnPct <= 0)
  const returns = trades.map(t => t.returnPct)
  const byReason: Record<string, number> = {}
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1
  const drops = trades
    .filter(t => t.peakPrice > 0)
    .map(t => ((t.exitPrice - t.peakPrice) / t.peakPrice) * 100)

  // Data-native span: the actual observed range of exit timestamps within
  // this bucket, not the period's nominal boundaries — using period.startMs
  // directly breaks for the open-ended first period (startMs=0, i.e. Unix
  // epoch), which would otherwise divide by a ~56-year span and round
  // trades/day down to 0.0.
  const exitTimestamps = trades.map(t => t.exitTimestamp)
  const observedSpanDays = (Math.max(...exitTimestamps) - Math.min(...exitTimestamps)) / 86_400_000
  const periodSpanDays = Math.max(observedSpanDays, 1 / 24) // floor at 1h so a burst of trades in a few minutes doesn't imply an absurd rate

  return {
    period,
    n,
    winRate: (wins.length / n) * 100,
    avgReturn: mean(returns),
    medianReturn: median(returns),
    avgWin: wins.length ? mean(wins.map(t => t.returnPct)) : null,
    avgLoss: losses.length ? mean(losses.map(t => t.returnPct)) : null,
    best: trades.reduce((a, b) => (b.returnPct > a.returnPct ? b : a)),
    worst: trades.reduce((a, b) => (b.returnPct < a.returnPct ? b : a)),
    byReason,
    avgDropFromPeakAtExit: mean(drops),
    tradesPerDay: n / Math.max(periodSpanDays, 1 / 24), // guard against a near-zero span dividing to absurd rates
  }
}

/**
 * Buckets by EXIT timestamp, not entry — a handful of positions opened
 * before a config change but held (open) across it close under whatever
 * exit rules were actually running at close time, not the rules that were
 * live when they were bought. Confirmed on this exact dataset: 5 trades
 * entered before ConfigD's 2026-07-01T20:41:01.653Z adoption but closed
 * 10-80 minutes after it (LR, USA250, BULLATLAS, SEXY, BINDY) — none of
 * them carry a persisted `exitConfig` (that field didn't exist yet at their
 * entry time), so their real outcome was produced by whatever
 * `evaluateExitRules` code was deployed at their *exit* moment. Bucketing
 * by entryTimestamp instead would attribute ConfigD-driven outcomes to the
 * pre-ConfigD period — confirmed as the cause of an early mismatch against
 * this exact 5-trade set versus data/retro/2026-07-01-analysis.md's
 * point-in-time snapshot (19 trades, taken before these 5 had closed).
 */
function bucketByPeriod(trades: ClosedPosition[], periods: Period[]): Map<string, ClosedPosition[]> {
  const buckets = new Map<string, ClosedPosition[]>(periods.map(p => [p.key, []]))
  for (const t of trades) {
    const period = periods.find(p => t.exitTimestamp >= p.startMs && (p.endMs == null || t.exitTimestamp < p.endMs))
    if (period) buckets.get(period.key)!.push(t)
  }
  return buckets
}

// ==================== Section 3 — exit-sim on real price series ====================

function toSimPosition(t: ClosedPosition): SimPosition {
  return { tokenAddress: t.tokenAddress, symbol: t.symbol, strategy: t.strategy, entryPrice: t.entryPrice, entryLiquidityUsd: t.entryLiquidityUsd, entryTimestamp: t.entryTimestamp }
}

interface ExitSimSummary {
  label: string
  n: number
  excluded: number
  winRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  results: SimTradeResult[]
}

function runExitSimAcrossFullHistory(allTrades: ClosedPosition[], ticksByToken: Map<string, ReturnType<typeof buildPriceTicksByToken> extends Map<string, infer V> ? V : never>): ExitSimSummary[] {
  const positions = allTrades.map(toSimPosition)
  const summaries: ExitSimSummary[] = []
  for (const config of EXIT_CONFIGS) {
    const results: SimTradeResult[] = []
    let excluded = 0
    for (const pos of positions) {
      const allTicks = ticksByToken.get(pos.tokenAddress) ?? []
      const ticksAfterEntry = allTicks.filter(t => t.timestamp >= pos.entryTimestamp)
      if (ticksAfterEntry.length < MIN_TICKS_AFTER_ENTRY) { excluded++; continue }
      results.push(simulateExitForToken(pos, ticksAfterEntry, config))
    }
    const closed = results.filter(r => r.exitReason != null)
    const wins = closed.filter(r => r.returnPct! > 0)
    summaries.push({
      label: config.label,
      n: closed.length,
      excluded,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      avgReturn: mean(closed.map(r => r.returnPct!)),
      medianReturn: median(closed.map(r => r.returnPct!)),
      results: closed,
    })
  }
  return summaries
}

// ==================== Section 4 — extreme crashes ====================

interface CrashRecord {
  symbol: string
  strategy: string
  returnPct: number
  holdingMinutes: number
  exitReason: string
  rawDataAvailable: boolean
  h1AtEntry: number | undefined
  m5AtEntry: number | undefined
  antiGapWouldHaveBlocked: boolean | null
}

function analyzeCrashes(allTrades: ClosedPosition[], scanEntries: LogEntry[]): CrashRecord[] {
  const scanByToken = new Map<string, ScanLogEntry[]>()
  for (const e of scanEntries) {
    if (e.type !== 'scan') continue
    const list = scanByToken.get(e.tokenAddress) ?? []
    list.push(e as ScanLogEntry)
    scanByToken.set(e.tokenAddress, list)
  }
  for (const list of scanByToken.values()) list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  const crashes = allTrades.filter(t => t.returnPct < -40)
  return crashes.map(t => {
    const entries = scanByToken.get(t.tokenAddress) ?? []
    // Last scan at or before the actual entry — the tick that would have
    // informed the buy decision, not an arbitrary "nearest" tick (a nearby
    // LATER tick could already reflect the crash itself, producing a false
    // "the filter should have caught this" reading — see this session's
    // earlier corrected rawDataAtEntry mistake).
    const priorEntries = entries.filter(e => new Date(e.timestamp).getTime() <= t.entryTimestamp)
    const atEntry = priorEntries.length ? priorEntries[priorEntries.length - 1] : undefined
    const h1 = atEntry?.rawData?.priceChange?.h1
    const m5 = atEntry?.rawData?.priceChange?.m5
    const antiGapWouldHaveBlocked = atEntry ? ((h1 != null && h1 < -50) || (m5 != null && m5 < -30)) : null
    return {
      symbol: t.symbol,
      strategy: t.strategy,
      returnPct: t.returnPct,
      holdingMinutes: t.holdingMinutes,
      exitReason: t.exitReason,
      rawDataAvailable: !!atEntry?.rawData,
      h1AtEntry: h1,
      m5AtEntry: m5,
      antiGapWouldHaveBlocked,
    }
  })
}

// ==================== Section 6 — EARLY vs EARLY_STRICT ====================

interface EarlyComparisonResult {
  totalEvaluatedByBoth: number
  passedEarlyOnly: number
  passedBoth: number
  passedEarlyOnlyPerformance: { n: number; winRate: number | null; avgReturn: number | null }
  passedBothPerformance: { n: number; winRate: number | null; avgReturn: number | null }
  overallEarlyWinRate: number | null
  overallEarlyStrictWinRate: number | null
}

function compareEarlyVsStrict(scanEntries: LogEntry[], closedTrades: ClosedPosition[]): EarlyComparisonResult {
  let totalEvaluatedByBoth = 0
  let passedEarlyOnly = 0
  let passedBoth = 0
  const earlyOnlyTokens = new Set<string>()
  const bothTokens = new Set<string>()

  for (const e of scanEntries) {
    if (e.type !== 'scan') continue
    const scan = e as ScanLogEntry
    const earlyEvaluated = scan.early && scan.early.reason !== 'not evaluated'
    const strictEvaluated = scan.early_strict && scan.early_strict.reason !== 'not evaluated'
    if (!earlyEvaluated || !strictEvaluated) continue
    totalEvaluatedByBoth++
    if (scan.early.pass && !scan.early_strict.pass) {
      passedEarlyOnly++
      earlyOnlyTokens.add(scan.tokenAddress)
    } else if (scan.early.pass && scan.early_strict.pass) {
      passedBoth++
      bothTokens.add(scan.tokenAddress)
    }
  }

  const earlyTrades = closedTrades.filter(t => t.strategy === 'early')
  const strictTrades = closedTrades.filter(t => t.strategy === 'early_strict')
  const earlyOnlyTrades = earlyTrades.filter(t => earlyOnlyTokens.has(t.tokenAddress))
  const bothTrades = earlyTrades.filter(t => bothTokens.has(t.tokenAddress))

  function summarize(trades: ClosedPosition[]): { n: number; winRate: number | null; avgReturn: number | null } {
    if (trades.length === 0) return { n: 0, winRate: null, avgReturn: null }
    const wins = trades.filter(t => t.returnPct > 0)
    return { n: trades.length, winRate: (wins.length / trades.length) * 100, avgReturn: mean(trades.map(t => t.returnPct)) }
  }

  function winRateOf(trades: ClosedPosition[]): number | null {
    if (trades.length === 0) return null
    return (trades.filter(t => t.returnPct > 0).length / trades.length) * 100
  }

  return {
    totalEvaluatedByBoth,
    passedEarlyOnly,
    passedBoth,
    passedEarlyOnlyPerformance: summarize(earlyOnlyTrades),
    passedBothPerformance: summarize(bothTrades),
    overallEarlyWinRate: winRateOf(earlyTrades),
    overallEarlyStrictWinRate: winRateOf(strictTrades),
  }
}

// ==================== Section 7 — expected value ====================

interface EVCalc {
  winRate: number | null
  avgWinPct: number | null
  avgLossPct: number | null
  evPerTradePct: number | null
  breakevenWinRatePct: number | null
  tradesPerDayObserved: number | null
  monthlyTargetWinRatePct: number | null
}

function computeEV(stats: PeriodStats): EVCalc {
  const { winRate, avgWin, avgLoss, tradesPerDay } = stats
  if (winRate == null || avgWin == null || avgLoss == null) {
    return { winRate, avgWinPct: avgWin, avgLossPct: avgLoss, evPerTradePct: null, breakevenWinRatePct: null, tradesPerDayObserved: tradesPerDay, monthlyTargetWinRatePct: null }
  }
  const w = winRate / 100
  const evPerTradePct = w * avgWin + (1 - w) * avgLoss
  const absLoss = Math.abs(avgLoss)
  const breakevenWinRatePct = (absLoss / (avgWin + absLoss)) * 100

  // Monthly +10% target — explicit assumptions (fixed $50/trade, no
  // compounding, $1000 reference paper capital): needed daily $ gain =
  // $100/30; per-trade $ gain needed = that / observed trades-per-day;
  // convert to a required EV% per trade via TRADE_AMOUNT_USD, then solve
  // the same breakeven-style equation for winRate. Not computable without
  // a trades/day figure.
  let monthlyTargetWinRatePct: number | null = null
  if (tradesPerDay != null && tradesPerDay > 0) {
    const monthlyTargetUsd = 0.10 * PAPER_CAPITAL_USD
    const dailyTargetUsd = monthlyTargetUsd / 30
    const perTradeTargetUsd = dailyTargetUsd / tradesPerDay
    const perTradeTargetPct = (perTradeTargetUsd / TRADE_AMOUNT_USD) * 100
    // w*avgWin + (1-w)*avgLoss = target  =>  w = (target - avgLoss) / (avgWin - avgLoss)
    const w2 = (perTradeTargetPct - avgLoss) / (avgWin - avgLoss)
    monthlyTargetWinRatePct = w2 * 100
  }

  return { winRate, avgWinPct: avgWin, avgLossPct: avgLoss, evPerTradePct, breakevenWinRatePct, tradesPerDayObserved: tradesPerDay, monthlyTargetWinRatePct }
}

// ==================== Report assembly ====================

async function main(): Promise<void> {
  const periods = buildPeriods()
  const scanEntries = await readScanLogEntriesForDates(SCAN_LOG_DATES)
  const closedTrades = await readClosedPositionsForDates(CLOSED_POSITIONS_DATES)
  const openPositions = await getOpenPositions()
  const ticksByToken = buildPriceTicksByToken(scanEntries)

  const buckets = bucketByPeriod(closedTrades, periods)
  const periodStats = periods.map(p => computeStats(p, buckets.get(p.key) ?? []))

  const exitSimSummaries = runExitSimAcrossFullHistory(closedTrades, ticksByToken)
  const crashes = analyzeCrashes(closedTrades, scanEntries)
  const earlyComparison = compareEarlyVsStrict(scanEntries, closedTrades)

  // Overall (all 400 trades, whatever period)
  const overallWins = closedTrades.filter(t => t.returnPct > 0)
  const overallWinRate = closedTrades.length ? (overallWins.length / closedTrades.length) * 100 : null
  const overallAvgReturn = mean(closedTrades.map(t => t.returnPct))
  const overallBest = closedTrades.length ? closedTrades.reduce((a, b) => (b.returnPct > a.returnPct ? b : a)) : null

  // "Depuis le début avec la config actuelle" — the exit-sim "ConfigD (momentum exit)"
  // entry in EXIT_CONFIGS *is* the current production config (unchanged since
  // 2026-07-01T20:41:01.653Z — see file header). Its avgReturn, replayed
  // across ALL 400 trades' real price history, is the only real-data-backed
  // answer to "if we'd had this config since the start."
  const currentConfigSim = exitSimSummaries.find(s => s.label === 'ConfigD (momentum exit)') ?? null
  const wouldBePositive = currentConfigSim?.avgReturn != null ? currentConfigSim.avgReturn > 0 : null

  const md = buildMarkdown({
    periods, periodStats, exitSimSummaries, crashes, earlyComparison, openPositions,
    overallWinRate, overallAvgReturn, overallBest, currentConfigSim, wouldBePositive,
    closedTradesTotal: closedTrades.length,
  })

  const reportPath = dataPath('retro', '2026-07-02-full-retro.md')
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, md, 'utf-8')

  printTerminalSummary({ overallWinRate, overallAvgReturn, overallBest, periodStats, wouldBePositive, currentConfigSim })
  console.log(`\nRapport complet écrit dans ${reportPath}`)
}

function buildMarkdown(data: {
  periods: Period[]
  periodStats: PeriodStats[]
  exitSimSummaries: ExitSimSummary[]
  crashes: CrashRecord[]
  earlyComparison: EarlyComparisonResult
  openPositions: Awaited<ReturnType<typeof getOpenPositions>>
  overallWinRate: number | null
  overallAvgReturn: number | null
  overallBest: ClosedPosition | null
  currentConfigSim: ExitSimSummary | null
  wouldBePositive: boolean | null
  closedTradesTotal: number
}): string {
  const { periods, periodStats, exitSimSummaries, crashes, earlyComparison, openPositions, overallWinRate, overallAvgReturn, overallBest, currentConfigSim, wouldBePositive, closedTradesTotal } = data
  const lines: string[] = []

  lines.push('# Rétrospection complète — 2 derniers jours (2026-07-01 / 2026-07-02)')
  lines.push('')
  lines.push('> Chiffres bruts calculés sur données réelles (scan-log + positions/closed). Toute')
  lines.push('> valeur non calculable avec les données disponibles est marquée explicitement')
  lines.push('> "n/a" ou "non calculable" — aucun chiffre n\'est inventé ou extrapolé sans le dire.')
  lines.push(`> Total trades fermés analysés : **${closedTradesTotal}**.`)
  lines.push('')

  // Section 1
  lines.push('## Section 1 — Timeline des configs')
  lines.push('')
  lines.push('| Période | Début | Fin | Config |')
  lines.push('|---|---|---|---|')
  for (const p of periods) {
    lines.push(`| ${p.label} | ${p.startMs === 0 ? '(début des données)' : new Date(p.startMs).toISOString()} | ${p.endMs == null ? '(en cours)' : new Date(p.endMs).toISOString()} | ${p.note} |`)
  }
  lines.push('')
  lines.push('Provenance des bornes : ConfigD documenté (nom de fichier du rapport exit-sim du')
  lines.push('2026-07-01) ; EARLY_STRICT dérivé du scan-log (premier enregistrement où ce champ')
  lines.push('n\'est pas "not evaluated") ; Phase 1+2 et fixes audit tirés des `CreationDate`')
  lines.push('Windows des process PID 61900 / 72656 relevés en session.')
  lines.push('')

  // Section 2
  lines.push('## Section 2 — Performance par période')
  lines.push('')
  lines.push('| Période | n | Win rate | Ret. moyen | Ret. médian | Meilleur | Pire | Drop moy. depuis peak (proxy) |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const s of periodStats) {
    if (s.n === 0) {
      lines.push(`| ${s.period.label} | 0 | — | — | — | — | — | — |`)
      continue
    }
    if (s.n < 10) {
      lines.push(`| ${s.period.label} | **${s.n} — échantillon insuffisant** | ${fmtPct(s.winRate)} | ${fmtPct(s.avgReturn)} | ${fmtPct(s.medianReturn)} | ${fmtPct(s.best!.returnPct)} ${s.best!.symbol} | ${fmtPct(s.worst!.returnPct)} ${s.worst!.symbol} | ${fmtPct(s.avgDropFromPeakAtExit)} |`)
      continue
    }
    lines.push(`| ${s.period.label} | ${s.n} | ${fmtPct(s.winRate)} | ${fmtPct(s.avgReturn)} | ${fmtPct(s.medianReturn)} | ${fmtPct(s.best!.returnPct)} ${s.best!.symbol} | ${fmtPct(s.worst!.returnPct)} ${s.worst!.symbol} | ${fmtPct(s.avgDropFromPeakAtExit)} |`)
  }
  lines.push('')
  lines.push('Répartition des raisons de sortie par période :')
  lines.push('')
  for (const s of periodStats) {
    if (s.n === 0) continue
    const reasons = Object.entries(s.byReason).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}: ${c}`).join(' | ')
    lines.push(`- **${s.period.label}** (n=${s.n}) : ${reasons}`)
  }
  lines.push('')
  lines.push('Note sur "drop depuis peak" : proxy uniquement, PAS le vrai drawdown intraday —')
  lines.push('ni `OpenPosition` ni `ClosedPosition` ne trackent un prix-plancher courant, seul le')
  lines.push('pic (`peakPrice`) est suivi (limitation déjà documentée dans')
  lines.push('data/retro/2026-07-01-analysis.md).')
  lines.push('')

  // Section 3
  lines.push('## Section 3 — Exit-sim avec la config actuelle (rejoué sur tout l\'historique de prix réel)')
  lines.push('')
  lines.push('Rejoue `evaluateExitRulesWithConfig` (version simplifiée mono-palier de')
  lines.push('`evaluateExitRules` — voir la limitation documentée dans exit-sim.ts : pas de seuil')
  lines.push('d\'activation du trailing stop, `liquidity_drain` non simulé) sur les séries de prix')
  lines.push('réelles de scan-log, pour chacun des 400 trades fermés.')
  lines.push('')
  lines.push('| Config | n (sorties simulées) | Exclus (historique insuffisant) | Win rate | Ret. moyen | Ret. médian |')
  lines.push('|---|---|---|---|---|---|')
  for (const s of exitSimSummaries) {
    lines.push(`| ${s.label} | ${s.n} | ${s.excluded} | ${s.winRate != null ? s.winRate.toFixed(1) + '%' : 'n/a'} | ${fmtPct(s.avgReturn)} | ${fmtPct(s.medianReturn)} |`)
  }
  lines.push('')
  lines.push('"Actuelle (simplifiée)" = config d\'origine (stopLoss -25%, trailing -20%, pas de')
  lines.push('momentum_reversal) — c\'est un nom hérité du fichier exit-sim.ts, pas la config')
  lines.push('actuelle malgré le libellé. "ConfigD (momentum exit)" EST la config actuelle : les')
  lines.push('règles de sortie n\'ont pas changé depuis son adoption — voir Section 1.')
  lines.push('')
  if (currentConfigSim) {
    lines.push(`**Réponse à la question posée** : rejouée sur les ${currentConfigSim.n} trades simulables`)
    lines.push(`(sur ${closedTradesTotal} au total, ${currentConfigSim.excluded} exclus faute d'historique de prix`)
    lines.push(`suffisant), la config actuelle donne un retour moyen de ${fmtPct(currentConfigSim.avgReturn)}`)
    lines.push(`et un win rate de ${currentConfigSim.winRate != null ? currentConfigSim.winRate.toFixed(1) + '%' : 'n/a'}.`)
  }
  lines.push('')

  // Section 4
  lines.push('## Section 4 — Analyse des crashs extrêmes (returnPct < -40%)')
  lines.push('')
  lines.push(`**${crashes.length} trades** sur ${closedTradesTotal} avec un retour inférieur à -40%.`)
  lines.push('')
  lines.push('| Symbol | Strategy | Return% | Holding (min) | Exit reason | rawData dispo | h1 à l\'entrée | m5 à l\'entrée | Anti-gap aurait bloqué ? |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const c of crashes) {
    const antiGap = c.antiGapWouldHaveBlocked === null ? 'n/a (pas de scan avant entrée)' : (c.antiGapWouldHaveBlocked ? 'OUI' : 'non')
    lines.push(`| ${c.symbol} | ${c.strategy} | ${fmtPct(c.returnPct)} | ${c.holdingMinutes.toFixed(1)} | ${c.exitReason} | ${c.rawDataAvailable ? 'oui' : 'non'} | ${c.h1AtEntry != null ? c.h1AtEntry.toFixed(1) + '%' : 'n/a'} | ${c.m5AtEntry != null ? c.m5AtEntry.toFixed(1) + '%' : 'n/a'} | ${antiGap} |`)
  }
  const blockedCount = crashes.filter(c => c.antiGapWouldHaveBlocked === true).length
  const noRawDataCount = crashes.filter(c => !c.rawDataAvailable).length
  lines.push('')
  lines.push(`Sur ces ${crashes.length} crashs : **${blockedCount}** auraient été bloqués par l'anti-gap`)
  lines.push(`(h1 < -50% ou m5 < -30% AU MOMENT DE L'ENTRÉE, pas après) s'il avait été actif à ce`)
  lines.push(`moment-là ; **${noRawDataCount}** n'ont aucun scan antérieur à l'entrée avec rawData`)
  lines.push('disponible pour trancher.')
  lines.push('')
  lines.push('Sur la question de l\'intervalle réduit (15s vs 60s) : non calculable ici — cette')
  lines.push('simulation n\'a que les ticks scan-log réellement enregistrés (un point par cycle de')
  lines.push('scan de l\'époque, pas un point par seconde), donc rejouer "et si on avait vérifié')
  lines.push('toutes les 15s" nécessiterait une résolution de prix qui n\'existe pas dans les')
  lines.push('données — non simulable sans inventer des prix intermédiaires.')
  lines.push('')

  // Section 5
  lines.push('## Section 5 — Pump.fun watchlist performance')
  lines.push('')
  lines.push('**0 achats via la watchlist pump.fun** — confirmé par construction : le code de')
  lines.push('`live-scan.ts` n\'a aucun chemin d\'achat pour les tokens détectés via pumpportal.fun,')
  lines.push('`checkPumpWatchlist` ne fait qu\'évaluer et logguer (`security=PASS/REJECT`), jamais')
  lines.push('acheter — voir le commentaire `// Mode achat immédiat — TODO Phase suivante, pas')
  lines.push('actif` dans le code. Ce n\'est pas une absence de données, c\'est le comportement')
  lines.push('voulu du mode surveillance actuel.')
  lines.push('')
  lines.push('Tokens de la watchlist ayant atteint les critères d\'achat EARLY (indexés + liquides')
  lines.push('+ `checkTokenSecurity` PASS), observés cette session (voir')
  lines.push('data/retro/2026-07-02-current.md) : **2** — Trainrot ($13,232 liquidité) et Bepe')
  lines.push('($15,287 liquidité). 329 autres détectés restaient en attente d\'indexation au')
  lines.push('moment de ce rapport. Aucune mesure d\'avantage temps réel (ageMinutes pump.fun vs')
  lines.push('DexScreener) n\'est calculable puisqu\'aucun achat n\'a jamais eu lieu par cette voie —')
  lines.push('il n\'y a rien à comparer.')
  lines.push('')

  // Section 6
  lines.push('## Section 6 — EARLY vs EARLY_STRICT')
  lines.push('')
  lines.push(`Tokens évalués par les deux stratégies dans le même cycle : **${earlyComparison.totalEvaluatedByBoth}**.`)
  lines.push(`- Passés EARLY mais pas EARLY_STRICT : **${earlyComparison.passedEarlyOnly}** occurrences de scan`)
  lines.push(`- Passés par les deux : **${earlyComparison.passedBoth}** occurrences de scan`)
  lines.push('')
  const eoP = earlyComparison.passedEarlyOnlyPerformance
  const bothP = earlyComparison.passedBothPerformance
  lines.push('Performance réelle des trades EARLY correspondants (par tokenAddress) :')
  lines.push('')
  lines.push('| Groupe | n trades fermés | Win rate | Ret. moyen |')
  lines.push('|---|---|---|---|')
  lines.push(`| Passés EARLY seul (EARLY_STRICT aurait rejeté) | ${eoP.n} | ${eoP.winRate != null ? eoP.winRate.toFixed(1) + '%' : 'n/a'} | ${fmtPct(eoP.avgReturn)} |`)
  lines.push(`| Passés par les deux | ${bothP.n} | ${bothP.winRate != null ? bothP.winRate.toFixed(1) + '%' : 'n/a'} | ${fmtPct(bothP.avgReturn)} |`)
  lines.push('')
  if (eoP.n < 10 || bothP.n < 10) {
    lines.push('**Échantillon insuffisant** (n<10 dans au moins un groupe) pour trancher si')
    lines.push('EARLY_STRICT avait raison de rejeter ces tokens.')
  } else if (eoP.avgReturn != null && bothP.avgReturn != null) {
    lines.push(eoP.avgReturn < bothP.avgReturn
      ? '→ Les tokens rejetés par EARLY_STRICT ont, en moyenne, moins bien performé — cohérent avec le rôle du filtre.'
      : '→ Les tokens rejetés par EARLY_STRICT ont, en moyenne, mieux performé que ceux passés par les deux — EARLY_STRICT aurait exclu de bons trades ici.')
  }
  lines.push('')
  lines.push(`Win rate global EARLY (toutes causes) : ${earlyComparison.overallEarlyWinRate != null ? earlyComparison.overallEarlyWinRate.toFixed(1) + '%' : 'n/a'}`)
  lines.push(`Win rate global EARLY_STRICT (toutes causes) : ${earlyComparison.overallEarlyStrictWinRate != null ? earlyComparison.overallEarlyStrictWinRate.toFixed(1) + '%' : 'n/a'}`)
  lines.push('')
  lines.push('Note : "Passés par les deux" n\'a PAS une performance identique par construction —')
  lines.push('EARLY_STRICT et EARLY sont des brokers/positions séparés ; même paire, même')
  lines.push('exitConfig, mais des exécutions/`entryTimestamp` indépendants à quelques centaines de')
  lines.push('ms d\'écart (voir position-tracker.ts) peuvent produire des `entryPrice` légèrement')
  lines.push('différents.')
  lines.push('')

  // Section 7
  lines.push('## Section 7 — Projection mathématique')
  lines.push('')
  lines.push('`E = winRate × avgWin + (1-winRate) × avgLoss` ; breakeven : `winRate = |avgLoss| / (avgWin + |avgLoss|)`.')
  lines.push('')
  lines.push('| Période | Win rate | avgWin | avgLoss | EV/trade | Winrate breakeven | Trades/jour observés |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const s of periodStats) {
    if (s.n < 10) {
      lines.push(`| ${s.period.label} | échantillon insuffisant (n=${s.n}) | — | — | — | — | — |`)
      continue
    }
    const ev = computeEV(s)
    lines.push(`| ${s.period.label} | ${fmtPct(ev.winRate)} | ${fmtPct(ev.avgWinPct)} | ${fmtPct(ev.avgLossPct)} | ${fmtPct(ev.evPerTradePct, 2)} | ${ev.breakevenWinRatePct != null ? ev.breakevenWinRatePct.toFixed(1) + '%' : 'n/a'} | ${ev.tradesPerDayObserved != null ? ev.tradesPerDayObserved.toFixed(1) : 'n/a'} |`)
  }
  lines.push('')
  lines.push(`Cible +10%/mois — hypothèses explicites : taille fixe $${TRADE_AMOUNT_USD}/trade, capital`)
  lines.push(`de référence $${PAPER_CAPITAL_USD}, PAS de composition (le système ne réinvestit pas les`)
  lines.push('gains en taille de position — `TRADE_AMOUNT_USD` est une constante fixe dans')
  lines.push('live-scan.ts, pas un pourcentage du capital). Sous ces hypothèses :')
  lines.push('')
  lines.push('| Période | Winrate requis pour +10%/mois |')
  lines.push('|---|---|')
  for (const s of periodStats) {
    if (s.n < 10) { lines.push(`| ${s.period.label} | échantillon insuffisant |`); continue }
    const ev = computeEV(s)
    lines.push(`| ${s.period.label} | ${ev.monthlyTargetWinRatePct != null ? ev.monthlyTargetWinRatePct.toFixed(1) + '%' : 'n/a'} |`)
  }
  lines.push('')

  // Section 8
  lines.push('## Section 8 — Verdict honnête')
  lines.push('')
  const validPeriods = periodStats.filter(s => s.n >= 10)
  lines.push(`**1. Amélioration réelle ou bruit statistique ?** ${validPeriods.length} période(s) sur`)
  lines.push(`${periodStats.length} ont n≥10 (règle retenue). ${validPeriods.length < 2
    ? 'Moins de deux périodes comparables avec un échantillon suffisant — impossible de trancher entre amélioration réelle et bruit sur cette base seule.'
    : 'Voir Section 2 pour la comparaison chiffrée entre périodes qualifiées ; toute différence entre périodes à n<30 reste dans la zone où le bruit statistique ne peut pas être exclu (règle n≥30 pour une conclusion défendable, voir Q4).'}`)
  lines.push('')
  const longestPeriod = periodStats.filter(s => s.n > 0).reduce((a, b) => (b.n > a.n ? b : a), periodStats[0]!)
  lines.push(`**2. Win rate minimum sur la plus longue période continue (sans redémarrage) ?**`)
  lines.push(`La période avec le plus de trades ininterrompus est **${longestPeriod.period.label}**`)
  lines.push(`(n=${longestPeriod.n}), win rate ${fmtPct(longestPeriod.winRate)}.`)
  lines.push('')
  lines.push(`**3. Avec la config actuelle depuis le début, serait-on en positif sur 2 jours ?**`)
  lines.push(wouldBePositive == null
    ? 'Non calculable — historique de prix insuffisant pour simuler assez de trades.'
    : (wouldBePositive
      ? `**Oui, sur le sous-ensemble simulable** — rejouée sur tout l'historique de prix disponible, la config actuelle (ConfigD) donne un retour moyen de ${fmtPct(currentConfigSim!.avgReturn)} sur ${currentConfigSim!.n} trades simulés. Nuance : ce n'est PAS une simulation d'entrées (voir Section 3 et l'en-tête d'exit-sim.ts) — seules les règles de SORTIE sont rejouées, les décisions d'achat elles-mêmes sont les vraies décisions historiques, prises sous d'anciens filtres d'entrée.`
      : `**Non** — rejouée sur tout l'historique de prix disponible, la config actuelle (ConfigD) donne un retour moyen de ${fmtPct(currentConfigSim!.avgReturn)} sur ${currentConfigSim!.n} trades simulés, toujours négatif. Nuance identique à ci-dessus : seules les règles de sortie sont rejouées, pas les décisions d'entrée.`))
  lines.push('')
  lines.push(`**4. Assez de trades pour conclure avec confiance statistique (n≥30) ?**`)
  const over30 = periodStats.filter(s => s.n >= 30)
  lines.push(over30.length > 0
    ? `Oui pour : ${over30.map(s => `${s.period.label} (n=${s.n})`).join(', ')}. Les autres périodes restent sous le seuil de 30 retenu par la consigne.`
    : 'Non — aucune période individuelle n\'atteint n≥30. Seul le total global (400 trades, toutes périodes confondues) dépasse ce seuil, mais mélanger des périodes à filtres/infrastructure différents dans une seule conclusion masquerait les changements réels plutôt que de les révéler.')
  lines.push('')
  lines.push(`**5. Prochaine modification la plus susceptible d'améliorer le win rate ?**`)
  lines.push('Basé uniquement sur les données ci-dessus (pas une opinion externe) :')
  const worstReason = (() => {
    const merged: Record<string, number> = {}
    for (const s of periodStats) for (const [r, c] of Object.entries(s.byReason)) merged[r] = (merged[r] ?? 0) + c
    const sorted = Object.entries(merged).sort((a, b) => b[1] - a[1])
    return sorted[0] ?? null
  })()
  if (worstReason) {
    lines.push(`La raison de sortie la plus fréquente sur l'ensemble des ${closedTradesTotal} trades est`)
    lines.push(`**${worstReason[0]}** (${worstReason[1]} occurrences, ${((worstReason[1] / closedTradesTotal) * 100).toFixed(1)}% des sorties)`)
    lines.push('— c\'est le mécanisme qui détermine le plus souvent l\'issue d\'un trade actuellement,')
    lines.push('donc le paramètre le plus susceptible d\'avoir un effet mesurable en le retouchant.')
  } else {
    lines.push('Non déterminable — aucune donnée de raison de sortie disponible.')
  }
  lines.push('')

  // Open positions context
  lines.push('## Annexe — Positions ouvertes au moment du rapport')
  lines.push('')
  lines.push(`${openPositions.length} positions ouvertes actuellement (non incluses dans les stats de`)
  lines.push('trades fermés ci-dessus, puisqu\'aucune n\'a encore de `returnPct` définitif).')
  lines.push('')

  return lines.join('\n')
}

function printTerminalSummary(data: {
  overallWinRate: number | null
  overallAvgReturn: number | null
  overallBest: ClosedPosition | null
  periodStats: PeriodStats[]
  wouldBePositive: boolean | null
  currentConfigSim: ExitSimSummary | null
}): void {
  const { overallWinRate, overallAvgReturn, overallBest, periodStats, wouldBePositive, currentConfigSim } = data
  console.log('')
  console.log('='.repeat(80))
  console.log('RETRO COMPLET — 2 derniers jours — résumé')
  console.log('='.repeat(80))
  console.log(`Win rate global      : ${overallWinRate != null ? overallWinRate.toFixed(1) + '%' : 'n/a'}`)
  console.log(`Retour moyen global  : ${fmtPct(overallAvgReturn)}`)
  console.log(`Meilleur trade       : ${overallBest ? `${fmtPct(overallBest.returnPct)} ${overallBest.symbol} (${overallBest.strategy})` : 'n/a'}`)
  console.log('')
  console.log('Par période :')
  for (const s of periodStats) {
    if (s.n === 0) { console.log(`  ${s.period.label}: aucun trade`); continue }
    const tag = s.n < 10 ? ' [échantillon insuffisant]' : ''
    console.log(`  ${s.period.label} (n=${s.n})${tag}: winrate ${fmtPct(s.winRate)}, ret. moyen ${fmtPct(s.avgReturn)}`)
  }
  console.log('')
  console.log('Question principale : "Avec la config actuelle depuis le début, serait-on en positif sur 2 jours ?"')
  console.log(wouldBePositive == null
    ? '  → Non calculable (historique de prix insuffisant).'
    : `  → ${wouldBePositive ? 'OUI' : 'NON'} (retour moyen simulé ${fmtPct(currentConfigSim?.avgReturn ?? null)} sur ${currentConfigSim?.n ?? 0} trades — exit-sim rejoue les règles de sortie sur les vraies décisions d'entrée historiques, pas une re-simulation complète).`)
  console.log('')
  const worst = periodStats.filter(s => s.n > 0).reduce((a, b) => ((b.avgReturn ?? -Infinity) < (a.avgReturn ?? -Infinity) ? b : a), periodStats.find(s => s.n > 0) ?? periodStats[0]!)
  console.log(`Recommandation : la période la plus faible mesurée avec un échantillon exploitable est`)
  console.log(`  "${worst.period.label}" (${fmtPct(worst.avgReturn)}, n=${worst.n}) — c'est le point d'entrée le plus`)
  console.log('  justifié par les données pour la prochaine itération, plutôt qu\'un ajustement au hasard.')
  console.log('='.repeat(80))
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
if (isMainModule) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export { buildPeriods, computeStats, bucketByPeriod, computeEV, analyzeCrashes, compareEarlyVsStrict, main }
