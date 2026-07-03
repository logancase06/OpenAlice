/**
 * retro:replay — once a DEX paper account has actually run, replay its
 * TradingGit commit history and ask: were the results good?
 *
 * Reuses `TradingGit.restore()` (the same Decimal-rehydration path the live
 * UTA process uses when loading commit.json — see `rehydrateCommit`/
 * `rehydrateGitState` in TradingGit.ts) instead of re-parsing the JSON by
 * hand, and the same DexScreener price lookup (`fetchDexScreenerTokenPairs`
 * + `bestPair`) `DexBroker.getQuote()` uses for still-open positions — no
 * duplicated logic for either.
 *
 * Exit price for a closed position is derived from the CASH DELTA between
 * consecutive `stateAfter` snapshots (`totalCashValue` before vs. after the
 * position disappears), not from `OperationResult.filledPrice` — verified
 * by reading `TradingGit.push()`/`parseOperationResult()` before writing
 * this script: `filledPrice` is only populated later by a separate
 * `syncOrders` commit from the order-sync poller, never on the immediate
 * `placeOrder` commit, so it can't be relied on as an immediate source of
 * exit price.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type { GitCommit, TradingGitConfig } from '@traderalice/uta-protocol'
import { dataPath } from '@/core/paths.js'
import { loadGitState } from '../../services/uta/src/domain/trading/git-persistence.js'
import { TradingGit } from '../../services/uta/src/domain/trading/git/TradingGit.js'
import { pnlOf } from '../../services/uta/src/domain/trading/position-math.js'
import { fetchDexScreenerTokenPairs, bestPair } from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'

export interface ReplayPositionResult {
  nativeKey: string
  symbol: string
  chain: string
  status: 'open' | 'closed'
  entryPrice: string
  quantity: string
  exitPrice?: string
  currentPrice?: string
  pnl: string
  pnlPercent: number
  openedAt: string
  closedAt?: string
}

export interface ReplaySummary {
  winRatePercent: number
  avgReturnPercent: number
  best: ReplayPositionResult | null
  worst: ReplayPositionResult | null
  stillOpenCount: number
  evaluatedCount: number
}

export function parseArgs(argv: string[]): { account: string; from?: Date; to?: Date } {
  let account: string | undefined
  let from: Date | undefined
  let to: Date | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') account = argv[++i]
    else if (argv[i] === '--from') from = new Date(argv[++i]!)
    else if (argv[i] === '--to') to = new Date(argv[++i]!)
  }
  if (!account) throw new Error('--account <accountId> is required')
  if (from && Number.isNaN(from.getTime())) throw new Error('Invalid --from date')
  if (to && Number.isNaN(to.getTime())) throw new Error('Invalid --to date')
  return { account, from, to }
}

/** Read-only config — none of these callbacks should ever fire from this script. */
function readOnlyTradingGitConfig(): TradingGitConfig {
  return {
    executeOperation: async () => {
      throw new Error('retro:replay is read-only — executeOperation must never be called')
    },
    getGitState: async () => {
      throw new Error('retro:replay is read-only — getGitState must never be called')
    },
  }
}

/** Load and rehydrate the account's full commit history, filtered to [from, to]. */
export async function loadCommitsInRange(accountId: string, from?: Date, to?: Date): Promise<GitCommit[]> {
  const state = await loadGitState(accountId)
  if (!state) return []

  const git = TradingGit.restore(state, readOnlyTradingGitConfig())
  // log() returns newest-first and only takes a `limit` — pass the full
  // count so nothing is dropped, then walk show() in chronological order.
  const summaries = git.log({ limit: state.commits.length })
  const chronologicalHashes = summaries.map(s => s.hash).reverse()

  const commits: GitCommit[] = []
  for (const hash of chronologicalHashes) {
    const commit = git.show(hash)
    if (!commit) continue
    const ts = new Date(commit.timestamp)
    if (from && ts < from) continue
    if (to && ts > to) continue
    commits.push(commit)
  }
  return commits
}

interface TrackedPosition {
  contract: Contract
  avgCost: string
  quantity: Decimal
  openedAt: string
}

function nativeKeyOf(contract: Contract): string {
  return contract.localSymbol || contract.symbol
}

/** Walk commits chronologically, diffing stateAfter.positions to detect opens/closes. */
export function reconstructPositions(commits: GitCommit[]): {
  closed: ReplayPositionResult[]
  stillOpen: Map<string, TrackedPosition>
} {
  const tracked = new Map<string, TrackedPosition>()
  const closed: ReplayPositionResult[] = []
  let prevCash: Decimal | null = null

  for (const commit of commits) {
    const cashNow = new Decimal(commit.stateAfter.totalCashValue)
    const presentKeys = new Set<string>()

    for (const pos of commit.stateAfter.positions) {
      const key = nativeKeyOf(pos.contract)
      presentKeys.add(key)
      const existing = tracked.get(key)
      tracked.set(key, {
        contract: pos.contract,
        avgCost: pos.avgCost,
        quantity: pos.quantity,
        openedAt: existing?.openedAt ?? commit.timestamp,
      })
    }

    if (prevCash != null) {
      for (const [key, pos] of [...tracked.entries()]) {
        if (presentKeys.has(key)) continue
        // Present in an earlier commit, gone now -> closed between the two.
        const qtyClosed = pos.quantity
        if (qtyClosed.lte(0)) {
          tracked.delete(key)
          continue
        }
        const exitPrice = cashNow.minus(prevCash).div(qtyClosed)
        const pnl = pnlOf({ quantity: qtyClosed, marketPrice: exitPrice, avgCost: pos.avgCost, multiplier: '1', side: 'long' })
        const entryValue = qtyClosed.mul(new Decimal(pos.avgCost))
        const pnlPercent = entryValue.gt(0) ? Number(new Decimal(pnl).div(entryValue).mul(100).toFixed(2)) : 0

        closed.push({
          nativeKey: key,
          symbol: pos.contract.symbol,
          chain: pos.contract.exchange,
          status: 'closed',
          entryPrice: pos.avgCost,
          quantity: qtyClosed.toString(),
          exitPrice: exitPrice.toString(),
          pnl,
          pnlPercent,
          openedAt: pos.openedAt,
          closedAt: commit.timestamp,
        })
        tracked.delete(key)
      }
    }

    prevCash = cashNow
  }

  return { closed, stillOpen: tracked }
}

/** Mark still-open positions to the current live DexScreener price. */
export async function resolveOpenPositions(stillOpen: Map<string, TrackedPosition>): Promise<ReplayPositionResult[]> {
  const results: ReplayPositionResult[] = []
  for (const [key, pos] of stillOpen) {
    const chain = pos.contract.exchange
    const pairs = await fetchDexScreenerTokenPairs(chain, key)
    const pair = bestPair(pairs)
    const currentPrice = pair?.priceUsd

    const pnl = currentPrice
      ? pnlOf({ quantity: pos.quantity, marketPrice: currentPrice, avgCost: pos.avgCost, multiplier: '1', side: 'long' })
      : '0'
    const entryValue = pos.quantity.mul(new Decimal(pos.avgCost))
    const pnlPercent = currentPrice && entryValue.gt(0)
      ? Number(new Decimal(pnl).div(entryValue).mul(100).toFixed(2))
      : 0

    results.push({
      nativeKey: key,
      symbol: pos.contract.symbol,
      chain,
      status: 'open',
      entryPrice: pos.avgCost,
      quantity: pos.quantity.toString(),
      currentPrice,
      pnl,
      pnlPercent,
      openedAt: pos.openedAt,
    })
  }
  return results
}

/**
 * Win-rate / avg-return are computed across every position with a known
 * PnL — closed ones, and open ones we could mark to a live price. A
 * position with no resolvable current price (DexScreener has nothing for
 * it) is excluded from the stats rather than silently counted as a loss.
 */
export function summarize(all: ReplayPositionResult[]): ReplaySummary {
  const evaluated = all.filter(p => p.status === 'closed' || p.currentPrice != null)
  const winners = evaluated.filter(p => new Decimal(p.pnl).gt(0))
  const winRatePercent = evaluated.length > 0 ? Number(((winners.length / evaluated.length) * 100).toFixed(1)) : 0
  const avgReturnPercent = evaluated.length > 0
    ? Number((evaluated.reduce((sum, p) => sum + p.pnlPercent, 0) / evaluated.length).toFixed(2))
    : 0
  const best = evaluated.reduce<ReplayPositionResult | null>((b, p) => (b == null || p.pnlPercent > b.pnlPercent ? p : b), null)
  const worst = evaluated.reduce<ReplayPositionResult | null>((w, p) => (w == null || p.pnlPercent < w.pnlPercent ? p : w), null)
  const stillOpenCount = all.filter(p => p.status === 'open').length

  return { winRatePercent, avgReturnPercent, best, worst, stillOpenCount, evaluatedCount: evaluated.length }
}

export function formatTerminalReport(accountId: string, all: ReplayPositionResult[], summary: ReplaySummary): string {
  const lines: string[] = []
  lines.push('='.repeat(78))
  lines.push(`RETRO:REPLAY — account ${accountId}`)
  lines.push('Real TradingGit history, real paper fills — this is not an approximation')
  lines.push('(unlike retro:today), but still-open positions are marked to whatever')
  lines.push('DexScreener reports as the current price right now.')
  lines.push('='.repeat(78))

  if (all.length === 0) {
    lines.push('No positions found in this account/date range.')
    return lines.join('\n')
  }

  for (const p of all) {
    const exit = p.status === 'closed' ? `exit=${p.exitPrice}` : `current=${p.currentPrice ?? 'n/a'}`
    lines.push(
      `${p.chain.padEnd(9)} ${p.symbol.padEnd(10)} [${p.status.padEnd(6)}] entry=${p.entryPrice.padEnd(12)} ` +
      `${exit.padEnd(20)} pnl=${p.pnl.padEnd(12)} (${p.pnlPercent.toFixed(1)}%)`,
    )
  }

  lines.push('-'.repeat(78))
  lines.push(`Win rate: ${summary.winRatePercent}% (${summary.evaluatedCount} evaluated)`)
  lines.push(`Avg return: ${summary.avgReturnPercent}%`)
  lines.push(`Best: ${summary.best ? `${summary.best.symbol} ${summary.best.pnlPercent.toFixed(1)}%` : 'n/a'}`)
  lines.push(`Worst: ${summary.worst ? `${summary.worst.symbol} ${summary.worst.pnlPercent.toFixed(1)}%` : 'n/a'}`)
  lines.push(`Still open: ${summary.stillOpenCount}`)
  return lines.join('\n')
}

export function formatMarkdownReport(accountId: string, all: ReplayPositionResult[], summary: ReplaySummary): string {
  const lines: string[] = []
  lines.push(`# Retro replay — ${accountId} — ${new Date().toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push('Real TradingGit history. Still-open positions are marked to the current')
  lines.push('live DexScreener price, not a historical one.')
  lines.push('')
  lines.push(`- Win rate: **${summary.winRatePercent}%** (${summary.evaluatedCount} evaluated)`)
  lines.push(`- Avg return: **${summary.avgReturnPercent}%**`)
  lines.push(`- Best: ${summary.best ? `${summary.best.symbol} (${summary.best.pnlPercent.toFixed(1)}%)` : 'n/a'}`)
  lines.push(`- Worst: ${summary.worst ? `${summary.worst.symbol} (${summary.worst.pnlPercent.toFixed(1)}%)` : 'n/a'}`)
  lines.push(`- Still open: ${summary.stillOpenCount}`)
  lines.push('')
  lines.push('| Chain | Symbol | Status | Entry | Exit/Current | PnL | PnL % | Opened | Closed |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const p of all) {
    const exit = p.status === 'closed' ? (p.exitPrice ?? 'n/a') : (p.currentPrice ?? 'n/a')
    lines.push(
      `| ${p.chain} | ${p.symbol} | ${p.status} | ${p.entryPrice} | ${exit} | ${p.pnl} | ` +
      `${p.pnlPercent.toFixed(1)}% | ${p.openedAt} | ${p.closedAt ?? '—'} |`,
    )
  }
  return lines.join('\n')
}

export async function runRetroReplay(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { account, from, to } = parseArgs(argv)
  const commits = await loadCommitsInRange(account, from, to)

  if (commits.length === 0) {
    console.log(`No TradingGit history found for account "${account}" in the given range.`)
    return
  }

  const { closed, stillOpen } = reconstructPositions(commits)
  const open = await resolveOpenPositions(stillOpen)
  const all = [...closed, ...open]
  const summary = summarize(all)

  console.log(formatTerminalReport(account, all, summary))

  const date = new Date().toISOString().slice(0, 10)
  const reportPath = dataPath('retro', `${date}-replay-${account}.md`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, formatMarkdownReport(account, all, summary))
  console.log(`\nReport written to ${reportPath}`)
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
if (isMainModule) {
  runRetroReplay().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
