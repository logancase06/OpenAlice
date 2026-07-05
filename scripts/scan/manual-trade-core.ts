/**
 * Shared logic for the manual training mode — used by both the terminal CLI
 * (manual-trade.ts) and the local web UI (manual-trade-ui.ts). Extracted
 * because manual-trade.ts runs its argv dispatch at import time, so the UI
 * can't import it directly without executing the CLI.
 *
 * See manual-trade.ts's header for the ownership model (CLI/UI process owns
 * monitoring; the scanner never touches 'manual' positions).
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { dataPath } from '@/core/paths.js'
import {
  MANUAL_CONFIG,
  TRADE_AMOUNT_USD,
  checkExits,
  restoreOpenPositions,
} from './live-scan.js'
import { DexBroker } from '../../services/uta/src/domain/trading/brokers/dex/DexBroker.js'
import {
  fetchDexScreenerTokenPairs,
  bestPair,
} from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { priceFeed } from '../../services/uta/src/domain/trading/brokers/dex/dex-price-feed.js'
import {
  getOpenPositions,
  openPosition,
  type ClosedPosition,
  type OpenPosition,
  type StrategyLabel,
} from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'

export const MANUAL_WATCH_INTERVAL_MS = 5_000

export async function makeManualBroker(): Promise<DexBroker> {
  const broker = new DexBroker({ id: 'manual-solana', chain: 'solana', paper: true, paperCashUsd: 10_000 })
  await broker.init()
  await restoreOpenPositions([{ config: MANUAL_CONFIG, broker }])
  return broker
}

export async function getOpenManualPositions(): Promise<OpenPosition[]> {
  return (await getOpenPositions()).filter(p => p.strategy === 'manual')
}

export type ManualOpenResult =
  | { ok: true; symbol: string; entryPrice: number; pairAddress: string }
  | { ok: false; error: string }

/** Opens a paper 'manual' position on `mint` — one position per token, TRADE_AMOUNT_USD, MANUAL_EXIT_CONFIG bracket. Subscribes the pair to the price feed so the caller's watch loop sees fresh prices. */
export async function openManualPosition(broker: DexBroker, mint: string): Promise<ManualOpenResult> {
  const already = (await getOpenManualPositions()).find(p => p.tokenAddress === mint)
  if (already) return { ok: false, error: `Position manuelle déjà ouverte sur ${already.symbol} — une seule position par token.` }

  const pairs = await fetchDexScreenerTokenPairs('solana', mint)
  const pair = bestPair(pairs)
  const entryPrice = Number(pair?.priceUsd ?? 0)
  if (!pair || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { ok: false, error: `Impossible de résoudre une paire DexScreener exploitable pour ${mint} — token trop frais, adresse invalide, ou pas encore indexé.` }
  }

  const contract = broker.resolveNativeKey(mint)
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.cashQty = new Decimal(TRADE_AMOUNT_USD)
  const result = await broker.placeOrder(contract, order, undefined, pair)
  if (!result.success) return { ok: false, error: `Achat paper refusé par le broker pour ${pair.baseToken.symbol}.` }

  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60_000 : 0
  await openPosition(pair, 'manual', entryPrice, ageMinutes, MANUAL_CONFIG.exitConfig, [], true)
  priceFeed.subscribe(pair.pairAddress)
  return { ok: true, symbol: pair.baseToken.symbol, entryPrice, pairAddress: pair.pairAddress }
}

/** One 5s watch tick: runs exit checks for 'manual' and returns how many positions closed. */
export async function checkManualExits(broker: DexBroker): Promise<number> {
  return checkExits('solana', broker, 'manual')
}

export async function readAllClosed(): Promise<ClosedPosition[]> {
  const dir = dataPath('positions', 'closed')
  let files: string[]
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')) } catch { return [] }
  const all: ClosedPosition[] = []
  for (const f of files) {
    let raw: string
    try { raw = await readFile(join(dir, f), 'utf-8') } catch { continue }
    for (const line of raw.split('\n').filter(Boolean)) {
      try { all.push(JSON.parse(line) as ClosedPosition) } catch { /* corrupt line — skip */ }
    }
  }
  return all
}

export interface StrategyStatsRow {
  label: StrategyLabel | 'MES PICKS'
  n: number
  winRatePct: number
  avgReturnPct: number
}

/** Win rate / avg return per strategy from the shared closed store, 'manual' relabeled MES PICKS and listed first. */
export function buildStatsRows(closed: ClosedPosition[]): StrategyStatsRow[] {
  const byStrategy = new Map<StrategyLabel, ClosedPosition[]>()
  for (const c of closed) {
    const arr = byStrategy.get(c.strategy) ?? []
    arr.push(c)
    byStrategy.set(c.strategy, arr)
  }
  const toRow = (label: StrategyStatsRow['label'], trades: ClosedPosition[]): StrategyStatsRow => ({
    label,
    n: trades.length,
    winRatePct: trades.filter(t => t.returnPct > 0).length / trades.length * 100,
    avgReturnPct: trades.reduce((s, t) => s + t.returnPct, 0) / trades.length,
  })
  const rows: StrategyStatsRow[] = []
  const manual = byStrategy.get('manual')
  if (manual) rows.push(toRow('MES PICKS', manual))
  for (const [label, trades] of [...byStrategy.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (label === 'manual') continue
    rows.push(toRow(label, trades))
  }
  return rows
}
