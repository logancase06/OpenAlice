/**
 * retro:exitsim — replays EXIT rules (not entry filters) against the real
 * price series already recorded in scan-log, testing alternative
 * stop-loss/trailing-stop/take-profit/time-exit thresholds on trades that
 * actually happened.
 *
 * Deliberately narrower than a full re-simulation: entry decisions are NOT
 * replayed. A full entry-filter replay would need to re-run
 * `checkTokenSecurity()` against DexScreener/GoPlus/Solana RPC "now" — for a
 * token address scanned hours ago, "now" reflects whatever that token has
 * become since (often rugged/delisted for pump.fun tokens), not its state
 * at the original scan moment. That's not a historical replay, it's
 * `retro:today` under another name. See docs/exit-sim-scope.md discussion
 * in the PR/commit that introduced this file.
 *
 * What IS honest here: for any token that was actually bought (closed or
 * still open), scan-log has repeated `priceAtScan` observations over time
 * for that same tokenAddress — a real (if coarse — one point per scan
 * cycle, not tick-by-tick) price path. Walking that path through
 * `evaluateExitRulesWithConfig` under a different threshold set answers "if
 * we'd used these exit rules instead, when would we have sold, on this
 * exact price history" — without inventing any price data.
 *
 * Coverage caveat: entries logged before `rawData` existed (see
 * live-scan.ts's ScanLogEntry) have no `priceChange.m5`, so
 * `momentum_reversal` can never trigger on those older ticks — reported,
 * not silently ignored.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'
import { getOpenPositions, getClosedToday, type StrategyLabel } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'
import { scanLogPath, type ScanLogEntry, type LogEntry } from '../scan/live-scan.js'

const MIN_TICKS_AFTER_ENTRY = 3

export interface ExitSimConfig {
  label: string
  stopLoss: number
  trailingStop: number
  takeProfitPct: number
  timeExitMinutes: number
  /** Defaults to -15 (production's momentum_reversal threshold) when unset. */
  momentumReversalThreshold?: number
}

export const EXIT_CONFIGS: ExitSimConfig[] = [
  {
    label: 'Actuelle (simplifiée)',
    stopLoss: -25,
    trailingStop: -20,
    takeProfitPct: 300,
    timeExitMinutes: 1440,
  },
  {
    label: 'ConfigB (plus serré)',
    stopLoss: -15,
    trailingStop: -12,
    takeProfitPct: 100,
    timeExitMinutes: 240,
  },
  {
    label: 'ConfigC (take profit rapide)',
    stopLoss: -20,
    trailingStop: -15,
    takeProfitPct: 50,
    timeExitMinutes: 120,
  },
  {
    label: 'ConfigD (momentum exit)',
    stopLoss: -20,
    trailingStop: -15,
    takeProfitPct: 200,
    timeExitMinutes: 180,
    momentumReversalThreshold: -10,
  },
]

export interface PriceTick {
  timestamp: number
  price: number
  liquidityUsd: number
  priceChange5m?: number
}

export interface SimPosition {
  tokenAddress: string
  symbol: string
  strategy: StrategyLabel
  entryPrice: number
  entryLiquidityUsd: number
  entryTimestamp: number
}

export interface SimTradeResult {
  tokenAddress: string
  symbol: string
  strategy: StrategyLabel
  entryPrice: number
  exitPrice: number | null
  returnPct: number | null
  holdingMinutes: number | null
  /** null = never triggered an exit within the available price history (position still "open" in this simulation). */
  exitReason: string | null
}

/**
 * Single-tier simplification of live-scan.ts's `evaluateExitRules`: real
 * production trailing-stop logic has 3 return-band-dependent tiers
 * (>100%/-15, >50%/-20, <=0%/-20). The 4 configs being compared here only
 * specify one `trailingStop` number each, so this applies that one
 * threshold unconditionally against drop-from-peak — meaning "Actuelle" in
 * this file's output is an APPROXIMATION of production, not a byte-for-byte
 * replica. Its simulated numbers will not exactly match the real recorded
 * outcomes for the same trades, by design of this simplification.
 * `liquidity_drain` (production's 6th exit reason) has no configurable
 * threshold in these 4 configs and is intentionally not simulated here.
 */
export function evaluateExitRulesWithConfig(
  position: { entryPrice: number; entryLiquidityUsd: number; entryTimestamp: number; peakPrice: number },
  currentPrice: number,
  priceChange5m: number | undefined,
  nowMs: number,
  config: ExitSimConfig,
): string | null {
  const returnPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100
  const peak = Math.max(position.peakPrice, currentPrice)
  const dropFromPeak = ((currentPrice - peak) / peak) * 100
  const holdingMinutes = (nowMs - position.entryTimestamp) / 60_000

  if (returnPct <= config.stopLoss) return 'stop_loss'
  if (dropFromPeak <= config.trailingStop) return 'trailing_stop'
  if (returnPct >= config.takeProfitPct) return 'take_profit'
  if (holdingMinutes >= config.timeExitMinutes) return 'time_exit'

  const momentumThreshold = config.momentumReversalThreshold ?? -15
  if (priceChange5m != null && priceChange5m <= momentumThreshold && returnPct < 0) return 'momentum_reversal'

  return null
}

/** Walks one token's real post-entry price ticks in order, applying `config` at each — first trigger wins. `exitReason: null` if no tick in the available history ever triggers. */
export function simulateExitForToken(position: SimPosition, ticksAfterEntry: PriceTick[], config: ExitSimConfig): SimTradeResult {
  let peakPrice = position.entryPrice
  for (const tick of ticksAfterEntry) {
    peakPrice = Math.max(peakPrice, tick.price)
    const reason = evaluateExitRulesWithConfig(
      { entryPrice: position.entryPrice, entryLiquidityUsd: position.entryLiquidityUsd, entryTimestamp: position.entryTimestamp, peakPrice },
      tick.price,
      tick.priceChange5m,
      tick.timestamp,
      config,
    )
    if (reason) {
      return {
        tokenAddress: position.tokenAddress,
        symbol: position.symbol,
        strategy: position.strategy,
        entryPrice: position.entryPrice,
        exitPrice: tick.price,
        returnPct: ((tick.price - position.entryPrice) / position.entryPrice) * 100,
        holdingMinutes: (tick.timestamp - position.entryTimestamp) / 60_000,
        exitReason: reason,
      }
    }
  }
  return {
    tokenAddress: position.tokenAddress,
    symbol: position.symbol,
    strategy: position.strategy,
    entryPrice: position.entryPrice,
    exitPrice: null,
    returnPct: null,
    holdingMinutes: null,
    exitReason: null,
  }
}

export function buildPriceTicksByToken(entries: LogEntry[]): Map<string, PriceTick[]> {
  const map = new Map<string, PriceTick[]>()
  for (const e of entries) {
    if (e.type !== 'scan') continue
    const scan = e as ScanLogEntry
    const list = map.get(scan.tokenAddress) ?? []
    list.push({
      timestamp: new Date(scan.timestamp).getTime(),
      price: scan.priceAtScan,
      liquidityUsd: scan.liquidityUsd,
      priceChange5m: scan.rawData?.priceChange?.m5,
    })
    map.set(scan.tokenAddress, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.timestamp - b.timestamp)
  return map
}

async function readScanLogEntries(date?: string): Promise<LogEntry[]> {
  const filePath = scanLogPath(date)
  try {
    const raw = await readFile(filePath, 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LogEntry)
  } catch {
    return []
  }
}

async function loadBoughtPositions(): Promise<SimPosition[]> {
  const [closed, open] = await Promise.all([getClosedToday(), getOpenPositions()])
  const positions: SimPosition[] = []
  for (const c of closed) {
    positions.push({ tokenAddress: c.tokenAddress, symbol: c.symbol, strategy: c.strategy, entryPrice: c.entryPrice, entryLiquidityUsd: c.entryLiquidityUsd, entryTimestamp: c.entryTimestamp })
  }
  for (const o of open) {
    positions.push({ tokenAddress: o.tokenAddress, symbol: o.symbol, strategy: o.strategy, entryPrice: o.entryPrice, entryLiquidityUsd: o.entryLiquidityUsd, entryTimestamp: o.entryTimestamp })
  }
  return positions
}

interface ConfigSummary {
  config: ExitSimConfig
  totalPositions: number
  excludedInsufficientHistory: number
  simulated: SimTradeResult[]
  closedCount: number
  stillOpenCount: number
  winRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  best: SimTradeResult | null
  worst: SimTradeResult | null
  avgHoldingMinutes: number | null
  reasonCounts: Record<string, number>
}

function mean(arr: number[]): number | null { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null }
function median(arr: number[]): number | null {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export async function runExitSim(): Promise<{ summaries: ConfigSummary[]; usableTokenCount: number; totalPositionCount: number }> {
  const entries = await readScanLogEntries()
  const ticksByToken = buildPriceTicksByToken(entries)
  const positions = await loadBoughtPositions()

  const summaries: ConfigSummary[] = []
  let usableTokenCount = 0

  for (const config of EXIT_CONFIGS) {
    const results: SimTradeResult[] = []
    let excluded = 0
    let firstPass = summaries.length === 0

    for (const pos of positions) {
      const allTicks = ticksByToken.get(pos.tokenAddress) ?? []
      const ticksAfterEntry = allTicks.filter(t => t.timestamp >= pos.entryTimestamp)
      if (ticksAfterEntry.length < MIN_TICKS_AFTER_ENTRY) {
        excluded++
        continue
      }
      if (firstPass) usableTokenCount++
      results.push(simulateExitForToken(pos, ticksAfterEntry, config))
    }

    const closedResults = results.filter(r => r.exitReason != null)
    const stillOpen = results.filter(r => r.exitReason == null)
    const returns = closedResults.map(r => r.returnPct!)
    const wins = closedResults.filter(r => r.returnPct! > 0)
    const holdingMinutes = closedResults.map(r => r.holdingMinutes!)
    const reasonCounts: Record<string, number> = {}
    for (const r of closedResults) reasonCounts[r.exitReason!] = (reasonCounts[r.exitReason!] ?? 0) + 1

    summaries.push({
      config,
      totalPositions: positions.length,
      excludedInsufficientHistory: excluded,
      simulated: results,
      closedCount: closedResults.length,
      stillOpenCount: stillOpen.length,
      winRate: closedResults.length ? (wins.length / closedResults.length) * 100 : null,
      avgReturn: mean(returns),
      medianReturn: median(returns),
      best: closedResults.length ? closedResults.reduce((a, b) => (b.returnPct! > a.returnPct! ? b : a)) : null,
      worst: closedResults.length ? closedResults.reduce((a, b) => (b.returnPct! < a.returnPct! ? b : a)) : null,
      avgHoldingMinutes: mean(holdingMinutes),
      reasonCounts,
    })
  }

  return { summaries, usableTokenCount, totalPositionCount: positions.length }
}

function fmtPct(n: number | null, digits = 1): string {
  if (n == null) return 'n/a'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function formatTerminalReport(summaries: ConfigSummary[], usableTokenCount: number, totalPositionCount: number): string {
  const lines: string[] = []
  lines.push('='.repeat(90))
  lines.push('EXIT SIM — replays exit rules on real price series.')
  lines.push('Entry decisions are unchanged from the original run — only the exit-rule')
  lines.push('thresholds are varied. Not a full historical replay (see file header).')
  lines.push(`${usableTokenCount} tokens with sufficient price history (>=${MIN_TICKS_AFTER_ENTRY} ticks after entry) out of ${totalPositionCount} total positions.`)
  lines.push('='.repeat(90))
  lines.push('')
  lines.push('| Config | Win rate | Ret. moy | Ret. médian | Meilleur | Pire | Durée moy (min) | Encore ouvert (sim) |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const s of summaries) {
    const bestStr = s.best ? `${fmtPct(s.best.returnPct)} ${s.best.symbol}` : 'n/a'
    const worstStr = s.worst ? `${fmtPct(s.worst.returnPct)} ${s.worst.symbol}` : 'n/a'
    lines.push(
      `| ${s.config.label} | ${s.winRate != null ? s.winRate.toFixed(1) + '%' : 'n/a'} | ${fmtPct(s.avgReturn)} | ${fmtPct(s.medianReturn)} | ${bestStr} | ${worstStr} | ${s.avgHoldingMinutes != null ? s.avgHoldingMinutes.toFixed(1) : 'n/a'} | ${s.stillOpenCount} |`,
    )
  }
  lines.push('')
  for (const s of summaries) {
    lines.push(`${s.config.label} — répartition des raisons de sortie (n=${s.closedCount}):`)
    for (const [reason, count] of Object.entries(s.reasonCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${reason}: ${count}`);
    }
    if (s.excludedInsufficientHistory > 0) {
      lines.push(`  (${s.excludedInsufficientHistory} positions exclues — historique de prix insuffisant)`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function formatMarkdownReport(summaries: ConfigSummary[], usableTokenCount: number, totalPositionCount: number): string {
  const lines: string[] = []
  lines.push('# Exit rule simulation — replay on real price series')
  lines.push('')
  lines.push('> Entry decisions are unchanged from the original run — only exit-rule thresholds')
  lines.push('> are varied here. This is NOT a full historical replay: entry filters are not')
  lines.push('> re-evaluated (that would require re-fetching live, i.e. present-day, DexScreener/')
  lines.push('> GoPlus/Solana RPC data for tokens scanned hours ago — not their state at scan time).');
  lines.push('>');
  lines.push(`> ${usableTokenCount}/${totalPositionCount} positions had sufficient price history (>=${MIN_TICKS_AFTER_ENTRY} ticks after entry) to simulate.`);
  lines.push('>');
  lines.push('> "Actuelle (simplifiée)" approximates production\'s exit rules with a single-tier');
  lines.push('> trailing stop instead of the real 3-tier logic — its numbers will not exactly');
  lines.push('> match the real recorded trade outcomes. `liquidity_drain` is not simulated (no');
  lines.push('> configurable threshold was specified for it).');
  lines.push('');
  lines.push('| Config | Win rate | Ret. moyen | Ret. médian | Meilleur | Pire | Durée moy (min) | Encore ouvert (sim) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    const bestStr = s.best ? `${fmtPct(s.best.returnPct)} ${s.best.symbol}` : 'n/a'
    const worstStr = s.worst ? `${fmtPct(s.worst.returnPct)} ${s.worst.symbol}` : 'n/a'
    lines.push(
      `| ${s.config.label} | ${s.winRate != null ? s.winRate.toFixed(1) + '%' : 'n/a'} | ${fmtPct(s.avgReturn)} | ${fmtPct(s.medianReturn)} | ${bestStr} | ${worstStr} | ${s.avgHoldingMinutes != null ? s.avgHoldingMinutes.toFixed(1) : 'n/a'} | ${s.stillOpenCount} |`,
    )
  }
  lines.push('')
  lines.push('## Détail par config')
  lines.push('')
  for (const s of summaries) {
    lines.push(`### ${s.config.label}`)
    lines.push('')
    lines.push(`\`${JSON.stringify(s.config)}\``)
    lines.push('')
    lines.push(`- Trades simulés (sortie déclenchée) : ${s.closedCount}`)
    lines.push(`- Encore ouverts en simulation (jamais de sortie déclenchée dans l'historique disponible) : ${s.stillOpenCount}`)
    lines.push(`- Exclus (historique insuffisant, <${MIN_TICKS_AFTER_ENTRY} ticks après l'entrée) : ${s.excludedInsufficientHistory}`)
    lines.push('- Répartition des raisons de sortie :')
    for (const [reason, count] of Object.entries(s.reasonCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${reason} : ${count}`)
    }
    lines.push('')
    lines.push('| Symbol | Strategy | Entry | Exit | Return% | Holding (min) | Reason |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const r of s.simulated) {
      lines.push(`| ${r.symbol} | ${r.strategy} | ${r.entryPrice} | ${r.exitPrice ?? 'n/a'} | ${fmtPct(r.returnPct)} | ${r.holdingMinutes?.toFixed(1) ?? 'n/a'} | ${r.exitReason ?? 'still_open_in_sim'} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export async function runMain(): Promise<void> {
  const { summaries, usableTokenCount, totalPositionCount } = await runExitSim()

  console.log(formatTerminalReport(summaries, usableTokenCount, totalPositionCount))

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = dataPath('retro', `exit-sim-${timestamp}.md`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, formatMarkdownReport(summaries, usableTokenCount, totalPositionCount))
  console.log(`\nReport written to ${reportPath}`)
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
if (isMainModule) {
  runMain().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
