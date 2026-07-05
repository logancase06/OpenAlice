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
 * Ownership model, deliberately CLI-owned: this process (or the `ui`
 * server) is the ONLY thing monitoring manual positions (5s loop, same
 * cadence as the scanner's fast-exit regime). The scanner never touches
 * the 'manual' label — no interference with automatic strategies, and
 * manual positions get their own broker so they can't count toward any
 * strategy's MAX_OPEN_POSITIONS_PER_STRATEGY. The trade-off: if this
 * process dies, the position sits unmonitored (still on disk) until
 * `pnpm manual-trade watch` (or `ui`) reattaches. Run ONE watcher at a time.
 *
 * Shared logic lives in manual-trade-core.ts (this file dispatches argv at
 * import time, so the web UI imports the core, not this file).
 *
 * Usage:
 *   pnpm manual-trade <mint-address>   open a position, then watch it
 *   pnpm manual-trade ui               local web UI (http://localhost:8787)
 *   pnpm manual-trade watch            reattach to all open manual positions
 *   pnpm manual-trade status           one-shot view of open manual positions
 *   pnpm manual-trade stats            my picks vs automatic strategies
 */
import { priceFeed } from '../../services/uta/src/domain/trading/brokers/dex/dex-price-feed.js'
import {
  fetchDexScreenerTokenPairs,
  bestPair,
} from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { getClosedToday } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'
import type { DexBroker } from '../../services/uta/src/domain/trading/brokers/dex/DexBroker.js'
import { TRADE_AMOUNT_USD } from './live-scan.js'
import {
  makeManualBroker,
  openManualPosition,
  getOpenManualPositions,
  checkManualExits,
  readAllClosed,
  buildStatsRows,
  MANUAL_WATCH_INTERVAL_MS,
} from './manual-trade-core.js'

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
  const broker = await makeManualBroker()
  const result = await openManualPosition(broker, mint)
  if (!result.ok) {
    console.error(result.error)
    process.exitCode = 1
    return
  }
  console.log(`✅ Position d'entraînement ouverte (paper) : ${result.symbol} @ $${result.entryPrice.toPrecision(4)} — $${TRADE_AMOUNT_USD}`)
  console.log(`   Sortie : take_profit +100% (x2) | stop_loss -20% | vérification toutes les 5s`)
  await watchLoop(broker)
}

async function cmdWatch(): Promise<void> {
  const broker = await makeManualBroker()
  const open = await getOpenManualPositions()
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
    const closedCount = await checkManualExits(broker)
    if (closedCount > 0) {
      const closed = (await getClosedToday()).filter(c => c.strategy === 'manual')
        .sort((a, b) => b.exitTimestamp - a.exitTimestamp)
        .slice(0, closedCount)
      for (const c of closed) {
        const emoji = c.exitReason === 'take_profit' ? '🎯' : c.exitReason === 'stop_loss' ? '🛑' : '🏁'
        console.log(`${emoji} CLÔTURE ${c.symbol}: ${c.exitReason} — retour ${c.returnPct >= 0 ? '+' : ''}${c.returnPct.toFixed(1)}% après ${c.holdingMinutes.toFixed(0)}min`)
      }
    }

    const open = await getOpenManualPositions()
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
    await new Promise(r => setTimeout(r, MANUAL_WATCH_INTERVAL_MS))
  }
  priceFeed.closeAll()
}

async function cmdStatus(): Promise<void> {
  const open = await getOpenManualPositions()
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

async function cmdStats(): Promise<void> {
  const rows = buildStatsRows(await readAllClosed())
  if (rows.length === 0) {
    console.log('Aucun trade clôturé.')
    return
  }
  console.log('=== MES PICKS (manuel) vs stratégies automatiques ===')
  if (rows[0]?.label !== 'MES PICKS') console.log('MES PICKS             n=   0  (aucun trade manuel clôturé)')
  for (const r of rows) {
    console.log([
      r.label.padEnd(20),
      `n=${String(r.n).padStart(4)}`,
      `win rate ${r.winRatePct.toFixed(0).padStart(3)}%`,
      `retour moyen ${r.avgReturnPct >= 0 ? '+' : ''}${r.avgReturnPct.toFixed(2)}%`,
    ].join('  '))
  }
}

const [arg] = process.argv.slice(2)
if (!arg) {
  console.log('Usage: pnpm manual-trade <mint-address> | ui | watch | status | stats')
} else if (arg === 'ui') {
  const { startManualTradeUi } = await import('./manual-trade-ui.js')
  await startManualTradeUi()
} else if (arg === 'watch') {
  await cmdWatch()
} else if (arg === 'status') {
  await cmdStatus()
} else if (arg === 'stats') {
  await cmdStats()
} else {
  await cmdOpen(arg)
}
