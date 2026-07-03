/**
 * retro:today — "if the bot had been running today, would its decisions
 * have been good?" for tokens created recently, reusing the exact same
 * security check (`checkTokenSecurity`) TokenSecurityGuard runs live —
 * never re-implements the filter logic, so live and retro can't diverge.
 *
 * NOT a minute-by-minute simulation. It uses CURRENT DexScreener data
 * (today's liquidity, today's priceChange windows) for tokens created in
 * the last 24h — it approximates what a live scan would have seen, it
 * does not replay history at the actual moment of hypothetical detection.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'
import {
  fetchLatestTokenProfiles,
  fetchDexScreenerTokenPairs,
  bestPair,
  type DexScreenerPair,
} from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { checkTokenSecurity, type TokenSecurityConfig } from '../../services/uta/src/domain/trading/guards/TokenSecurityGuard.js'

export const DEX_CHAINS = ['solana', 'ethereum', 'base', 'bsc'] as const
export type DexChain = (typeof DEX_CHAINS)[number]

const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface RetroTodayRow {
  chain: string
  symbol: string
  tokenAddress: string
  liquidityUsd: number
  ageMinutes: number
  priceChangeWindow: 'h1' | 'h6' | 'h24'
  priceChangePercent: number | null
  passed: boolean
  reasons: string[]
}

const DEFAULT_SECURITY_CONFIG: TokenSecurityConfig = {
  rejectIfHoneypot: true,
  rejectIfMintable: true,
  rejectIfOwnerCanBlacklist: true,
  rejectIfHighTax: true,
  maxBuyTaxPercent: 10,
  maxSellTaxPercent: 10,
  minHolderCount: 20,
  maxTop10HolderPercent: 70,
  rejectIfLiquidityUnlocked: true,
}

export function parseArgs(argv: string[]): { chain: DexChain | 'all'; minLiquidityUsd: number } {
  let chain: DexChain | 'all' = 'all'
  let minLiquidityUsd = 5000
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--chain') {
      const v = argv[++i]
      if (v === 'all' || (DEX_CHAINS as readonly string[]).includes(v)) {
        chain = v as DexChain | 'all'
      } else {
        throw new Error(`Invalid --chain "${v}" — expected one of: all, ${DEX_CHAINS.join(', ')}`)
      }
    } else if (argv[i] === '--min-liquidity') {
      const raw = argv[++i]
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid --min-liquidity "${raw}"`)
      minLiquidityUsd = parsed
    }
  }
  return { chain, minLiquidityUsd }
}

/** Nearest DexScreener priceChange window to the token's actual age. */
function pickPriceChangeWindow(ageMinutes: number, pair: DexScreenerPair): { window: 'h1' | 'h6' | 'h24'; percent: number | null } {
  if (ageMinutes < 60) return { window: 'h1', percent: pair.priceChange?.h1 ?? null }
  if (ageMinutes < 360) return { window: 'h6', percent: pair.priceChange?.h6 ?? null }
  return { window: 'h24', percent: pair.priceChange?.h24 ?? null }
}

export async function buildRetroTodayReport(chain: DexChain | 'all', minLiquidityUsd: number): Promise<RetroTodayRow[]> {
  const profiles = await fetchLatestTokenProfiles()
  const scoped = chain === 'all' ? profiles : profiles.filter(p => p.chainId === chain)
  const now = Date.now()
  const rows: RetroTodayRow[] = []

  for (const profile of scoped) {
    const pairs = await fetchDexScreenerTokenPairs(profile.chainId, profile.tokenAddress)
    const pair = bestPair(pairs)
    if (!pair || !pair.pairCreatedAt) continue

    const ageMs = now - pair.pairCreatedAt
    if (ageMs < 0 || ageMs > MAX_AGE_MS) continue
    const ageMinutes = ageMs / 60_000

    const security = await checkTokenSecurity(profile.chainId, profile.tokenAddress, {
      ...DEFAULT_SECURITY_CONFIG,
      minLiquidityUsd,
    })
    const { window, percent } = pickPriceChangeWindow(ageMinutes, pair)

    rows.push({
      chain: profile.chainId,
      symbol: pair.baseToken.symbol,
      tokenAddress: profile.tokenAddress,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      ageMinutes,
      priceChangeWindow: window,
      priceChangePercent: percent,
      passed: security.passed,
      reasons: security.reasons,
    })
  }

  rows.sort((a, b) => (b.priceChangePercent ?? -Infinity) - (a.priceChangePercent ?? -Infinity))
  return rows
}

export function formatTerminalReport(rows: RetroTodayRow[], chain: DexChain | 'all', minLiquidityUsd: number): string {
  const lines: string[] = []
  lines.push('='.repeat(78))
  lines.push('RETRO:TODAY — approximation, NOT a minute-by-minute simulation.')
  lines.push("Uses CURRENT DexScreener data (price/liquidity as of right now), not the")
  lines.push('state as of the moment a live scanner would actually have detected each')
  lines.push('token. The bot did not really run.')
  lines.push(`Chain: ${chain}  |  minLiquidityUsd: ${minLiquidityUsd}  |  window: last 24h`)
  lines.push('='.repeat(78))
  if (rows.length === 0) {
    lines.push('No candidates found in the last 24h for this chain.')
    return lines.join('\n')
  }
  for (const r of rows) {
    const verdict = r.passed ? 'PASSED' : `REJECTED (${r.reasons.join('; ')})`
    const pct = r.priceChangePercent == null ? 'n/a' : `${r.priceChangePercent.toFixed(1)}%`
    lines.push(
      `${r.chain.padEnd(9)} ${r.symbol.padEnd(10)} liq=$${r.liquidityUsd.toFixed(0).padStart(9)} ` +
      `age=${r.ageMinutes.toFixed(0).padStart(5)}m  ${r.priceChangeWindow}=${pct.padStart(8)}  ${verdict}`,
    )
  }
  return lines.join('\n')
}

export function formatMarkdownReport(rows: RetroTodayRow[], chain: DexChain | 'all', minLiquidityUsd: number): string {
  const lines: string[] = []
  lines.push(`# Retro report — ${new Date().toISOString().slice(0, 10)} (today, ${chain})`)
  lines.push('')
  lines.push('> **Approximation, not a simulation.** Uses DexScreener data as observed')
  lines.push('> right now for tokens created in the last 24h — not the state as of the')
  lines.push('> moment a live scanner would actually have detected each token.')
  lines.push('')
  lines.push(`Chain: \`${chain}\` · minLiquidityUsd: \`${minLiquidityUsd}\``)
  lines.push('')
  lines.push('| Chain | Symbol | Token | Liquidity ($) | Age (min) | Change window | Change % | Verdict |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const verdict = r.passed ? 'PASSED' : `REJECTED — ${r.reasons.join('; ')}`
    const pct = r.priceChangePercent == null ? 'n/a' : `${r.priceChangePercent.toFixed(1)}%`
    lines.push(
      `| ${r.chain} | ${r.symbol} | \`${r.tokenAddress}\` | ${r.liquidityUsd.toFixed(0)} | ` +
      `${r.ageMinutes.toFixed(0)} | ${r.priceChangeWindow} | ${pct} | ${verdict} |`,
    )
  }
  return lines.join('\n')
}

export async function runRetroToday(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { chain, minLiquidityUsd } = parseArgs(argv)
  const rows = await buildRetroTodayReport(chain, minLiquidityUsd)

  console.log(formatTerminalReport(rows, chain, minLiquidityUsd))

  const date = new Date().toISOString().slice(0, 10)
  const reportPath = dataPath('retro', `${date}-today-${chain}.md`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, formatMarkdownReport(rows, chain, minLiquidityUsd))
  console.log(`\nReport written to ${reportPath}`)
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
if (isMainModule) {
  runRetroToday().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
