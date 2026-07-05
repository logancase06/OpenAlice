/**
 * Manual training mode — user-picked paper positions in the terminal.
 *
 * Lets the user open a paper position on a pump.fun token THEY chose and
 * watch what a raw x2-or-stop bracket does to it: take_profit +100%,
 * stop_loss -20%, nothing else (see MANUAL_EXIT_CONFIG's docstring). The
 * point is training — comparing human picks against the automatic
 * strategies on the same metrics (`stats` subcommand), with zero real
 * transactions (DexBroker is paper-mode-only).
 *
 * Ownership model, deliberately CLI-owned: this process is the ONLY thing
 * monitoring manual positions (5s loop, same cadence as the scanner's
 * fast-exit regime). The scanner never touches the 'manual' label — no
 * interference with automatic strategies, and manual positions get their
 * own broker so they can't count toward any strategy's
 * MAX_OPEN_POSITIONS_PER_STRATEGY. The trade-off: if this process dies,
 * the position sits unmonitored (still on disk) until
 * `pnpm manual-trade watch` reattaches. Run ONE watch instance at a time.
 *
 * Usage:
 *   pnpm manual-trade <mint-address>   open a position, then watch it
 *   pnpm manual-trade watch            reattach to all open manual positions
 *   pnpm manual-trade status           one-shot view of open manual positions
 *   pnpm manual-trade stats            my picks vs automatic strategies
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
  getClosedToday,
  openPosition,
  type ClosedPosition,
  type StrategyLabel,
} from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'

const WATCH_INTERVAL_MS = 5_000

async function makeBroker(): Promise<DexBroker> {
  const broker = new DexBroker({ id: 'manual-solana', chain: 'solana', paper: true, paperCashUsd: 10_000 })
  await broker.init()
  await restoreOpenPositions([{ config: MANUAL_CONFIG, broker }])
  return broker
}

async function openManualPositions(): Promise<Awaited<ReturnType<typeof getOpenPositions>>> {
  return (await getOpenPositions()).filter(p => p.strategy === 'manual')
}

function fmtLine(symbol: string, entryPrice: number, currentPrice: number | null, holdingMinutes: number): string {
  const ret = currentPrice != null ? ((currentPrice - entryPrice) / entryPrice) * 100 : null
  return [
    symbol.padEnd(12),
    `entrée $${entryPrice.toPrecision(4)}`,
    currentPrice != null ? `actuel $${currentPrice.toPrecision(4)}` : 'actuel n/a',
    ret != null ? `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%` : '—',
    `tenu ${holdingMinutes.toFixed(0)}min`,
  ].join('  ')
}

async function cmdOpen(mint: string): Promise<void> {
  const broker = await makeBroker()
  const already = (await openManualPositions()).find(p => p.tokenAddress === mint)
  if (already) {
    console.log(`Position manuelle déjà ouverte sur ${already.symbol} (${mint}) — une seule position par token. \`pnpm manual-trade watch\` pour la suivre.`)
    return
  }

  const pairs = await fetchDexScreenerTokenPairs('solana', mint)
  const pair = bestPair(pairs)
  const entryPrice = Number(pair?.priceUsd ?? 0)
  if (!pair || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    console.error(`Impossible de résoudre une paire DexScreener exploitable pour ${mint} — token trop frais, adresse invalide, ou pas encore indexé.`)
    process.exitCode = 1
    return
  }

  const contract = broker.resolveNativeKey(mint)
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.cashQty = new Decimal(TRADE_AMOUNT_USD)
  const result = await broker.placeOrder(contract, order, undefined, pair)
  if (!result.success) {
    console.error(`Achat paper refusé par le broker pour ${pair.baseToken.symbol} — voir logs broker ci-dessus.`)
    process.exitCode = 1
    return
  }

  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60_000 : 0
  await openPosition(pair, 'manual', entryPrice, ageMinutes, MANUAL_CONFIG.exitConfig, [], true)
  priceFeed.subscribe(pair.pairAddress)
  console.log(`✅ Position d'entraînement ouverte (paper) : ${pair.baseToken.symbol} @ $${entryPrice.toPrecision(4)} — $${TRADE_AMOUNT_USD}`)
  console.log(`   Sortie : take_profit +100% (x2) | stop_loss -20% | vérification toutes les 5s`)
  await watchLoop(broker)
}

async function cmdWatch(): Promise<void> {
  const broker = await makeBroker()
  const open = await openManualPositions()
  if (open.length === 0) {
    console.log('Aucune position manuelle ouverte. `pnpm manual-trade <mint>` pour en ouvrir une.')
    return
  }
  for (const p of open) priceFeed.subscribe(p.pairAddress)
  await watchLoop(broker)
}

async function watchLoop(broker: DexBroker): Promise<void> {
  let stopping = false
  process.on('SIGINT', () => {
    stopping = true
    console.log('\nArrêt du suivi — les positions restent ouvertes sur disque. Reprends avec `pnpm manual-trade watch`.')
  })

  while (!stopping) {
    const closedCount = await checkExits('solana', broker, 'manual')
    if (closedCount > 0) {
      const closed = (await getClosedToday()).filter(c => c.strategy === 'manual')
        .sort((a, b) => b.exitTimestamp - a.exitTimestamp)
        .slice(0, closedCount)
      for (const c of closed) {
        const emoji = c.exitReason === 'take_profit' ? '🎯' : c.exitReason === 'stop_loss' ? '🛑' : '🏁'
        console.log(`${emoji} CLÔTURE ${c.symbol}: ${c.exitReason} — retour ${c.returnPct >= 0 ? '+' : ''}${c.returnPct.toFixed(1)}% après ${c.holdingMinutes.toFixed(0)}min`)
      }
    }

    const open = await openManualPositions()
    if (open.length === 0) {
      console.log('Plus aucune position manuelle ouverte — fin du suivi.')
      priceFeed.closeAll()
      return
    }
    const now = new Date().toISOString().slice(11, 19)
    for (const p of open) {
      const price = priceFeed.getLatestPrice(p.pairAddress)
      console.log(`[${now}] ${fmtLine(p.symbol, p.entryPrice, price?.priceUsd ?? null, (Date.now() - p.entryTimestamp) / 60_000)}`)
    }
    await new Promise(r => setTimeout(r, WATCH_INTERVAL_MS))
  }
  priceFeed.closeAll()
}

async function cmdStatus(): Promise<void> {
  const open = await openManualPositions()
  if (open.length === 0) {
    console.log('Aucune position manuelle ouverte.')
    return
  }
  for (const p of open) {
    const pairs = await fetchDexScreenerTokenPairs('solana', p.tokenAddress)
    const pair = bestPair(pairs)
    const current = pair ? Number(pair.priceUsd ?? 0) : null
    console.log(fmtLine(p.symbol, p.entryPrice, current && current > 0 ? current : null, (Date.now() - p.entryTimestamp) / 60_000))
  }
}

async function readAllClosed(): Promise<ClosedPosition[]> {
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

async function cmdStats(): Promise<void> {
  const all = await readAllClosed()
  if (all.length === 0) {
    console.log('Aucun trade clôturé.')
    return
  }
  const byStrategy = new Map<StrategyLabel, ClosedPosition[]>()
  for (const c of all) {
    const arr = byStrategy.get(c.strategy) ?? []
    arr.push(c)
    byStrategy.set(c.strategy, arr)
  }
  const row = (label: string, trades: ClosedPosition[]): string => {
    const wins = trades.filter(t => t.returnPct > 0).length
    const avg = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length
    return [
      label.padEnd(20),
      `n=${String(trades.length).padStart(4)}`,
      `win rate ${(wins / trades.length * 100).toFixed(0).padStart(3)}%`,
      `retour moyen ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`,
    ].join('  ')
  }
  const manual = byStrategy.get('manual')
  console.log('=== MES PICKS (manuel) vs stratégies automatiques ===')
  console.log(manual ? row('MES PICKS', manual) : 'MES PICKS             n=   0  (aucun trade manuel clôturé)')
  for (const [label, trades] of [...byStrategy.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (label === 'manual') continue
    console.log(row(label, trades))
  }
}

const [arg] = process.argv.slice(2)
if (!arg) {
  console.log('Usage: pnpm manual-trade <mint-address> | watch | status | stats')
} else if (arg === 'watch') {
  await cmdWatch()
} else if (arg === 'status') {
  await cmdStatus()
} else if (arg === 'stats') {
  await cmdStats()
} else {
  await cmdOpen(arg)
}
