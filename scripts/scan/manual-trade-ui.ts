/**
 * Local web UI for the manual training mode — a pump.fun-style live card
 * feed where every card also shows what OUR system sees (EARLY_STRICT
 * decision, silent-distribution flag, vol/liquidity ratio, website
 * presence), and one click opens a paper 'manual' position (same bracket
 * and isolation as the manual-trade CLI).
 *
 * Latency design (2026-07-05 requirement):
 *  - Card feed sources, fastest first: HeliusPoolFeed (logsSubscribe on
 *    pump.fun's CreateV2, ~2.9s after on-chain creation — only when
 *    HELIUS_API_KEY is set) and PumpFunFeed (pumpportal relay, no key,
 *    a few seconds) create cards IMMEDIATELY with partial data; the
 *    scan-log tail (3s) enriches them progressively as the scanner sees
 *    the same tokens — no blocking wait for enrichment.
 *  - Browser push over SSE (GET /api/stream), not polling — SSE over
 *    WebSocket because the flow is strictly server→browser (buys are a
 *    normal POST) and SSE needs zero dependencies on a bare node http
 *    server.
 *  - Click→position: fast path uses the dex-price-feed cache (3s batch)
 *    when the card's pair is subscribed and fresh (<10s), skipping the
 *    DexScreener round-trip entirely; falls back to a live pair fetch
 *    otherwise. The measured click→open latency is returned to the
 *    browser and displayed. To keep DexScreener rate-limit pressure away
 *    from the scanner process (shared IP), only the newest
 *    PRICE_SUB_CAP enriched cards are subscribed at any time.
 *
 * Isolation: read-only on the scanner's data (scan-log/silent-distribution
 * tails); own broker id ('manual-solana'); own Helius/pumpportal sockets;
 * never touches the scanner process. Manual positions are monitored by
 * THIS process's 5s loop — closing the server pauses monitoring until the
 * next `pnpm manual-trade watch|ui` (same documented limitation as the CLI).
 *
 * Binds 127.0.0.1 only — never exposed to the network.
 */
import { createServer, type ServerResponse } from 'node:http'
import { readFile, open, stat, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataPath } from '@/core/paths.js'
import {
  LOW_VOL_LIQUIDITY_RATIO_THRESHOLD,
  loadSilentDistributionFlags,
  sdFlaggedTokens,
  type StrategyDecision,
} from './live-scan.js'
import {
  makeManualBroker,
  openManualPosition,
  getOpenManualPositions,
  checkManualExits,
  readAllClosed,
  buildStatsRows,
  MANUAL_WATCH_INTERVAL_MS,
} from './manual-trade-core.js'
import { PumpFunFeed, type PumpFunToken } from '../../services/uta/src/domain/trading/brokers/dex/pump-fun-feed.js'
import { HeliusPoolFeed } from '../../services/uta/src/domain/trading/brokers/dex/helius-pool-feed.js'
import { priceFeed } from '../../services/uta/src/domain/trading/brokers/dex/dex-price-feed.js'
import { openPosition, getClosedToday } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'
import { MANUAL_CONFIG, TRADE_AMOUNT_USD } from './live-scan.js'
import { DexBroker } from '../../services/uta/src/domain/trading/brokers/dex/DexBroker.js'
import type { DexScreenerPair } from '../../services/uta/src/domain/trading/brokers/dex/dex-market-data.js'
import { Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'

export const DEFAULT_UI_PORT = 8787
export const CARD_CAP = 200
export const PRICE_SUB_CAP = 15
const SCAN_TAIL_INTERVAL_MS = 3_000
const SD_RELOAD_INTERVAL_MS = 30_000
const PRICE_CACHE_FRESH_MS = 10_000
const FEED_SEED_WINDOW_MS = 60 * 60_000

// ==================== Card store (pure logic — unit-tested) ====================

export interface TokenCard {
  mint: string
  symbol: string
  name?: string
  /** On-chain creation time (ms) when a fast feed saw it; scan-derived otherwise. Null until any source provides it. */
  createdAt: number | null
  firstSeenAt: number
  source: 'helius' | 'pump' | 'scan'
  updatedAt: number
  pairAddress?: string
  priceUsd?: number
  liquidityUsd?: number
  priceChangeM5?: number
  priceChangeH1?: number
  volumeH1?: number
  earlyStrict?: { pass: boolean; reason: string }
  sdFlagged: boolean
  volLiqRatio?: number
  volLiqLow?: boolean
  hasWebsite?: boolean
  hasSocials?: boolean
}

/** Minimal shape of a scan-log 'scan' entry that the card store needs — kept structural so tests don't have to build full ScanLogEntry objects. */
export interface ScanFeedEntry {
  timestamp: string
  tokenAddress: string
  pairAddress?: string
  symbol: string
  ageMinutes: number
  liquidityUsd: number
  priceAtScan?: number
  early_strict?: StrategyDecision
  rawData?: {
    priceChange?: { m5?: number; h1?: number }
    volume?: { h1?: number }
    hasWebsite?: boolean
    hasSocials?: boolean
  }
}

function evictIfOverCap(store: Map<string, TokenCard>): void {
  if (store.size <= CARD_CAP) return
  let oldest: TokenCard | null = null
  for (const c of store.values()) if (!oldest || c.firstSeenAt < oldest.firstSeenAt) oldest = c
  if (oldest) store.delete(oldest.mint)
}

export function upsertFastFeedCard(
  store: Map<string, TokenCard>,
  source: 'helius' | 'pump',
  t: { mintAddress: string; symbol?: string; name?: string; createdAt?: number },
  now: number,
): TokenCard {
  const existing = store.get(t.mintAddress)
  if (existing) {
    // A fast feed never downgrades scan enrichment — it can only fill createdAt/name gaps.
    if (existing.createdAt == null && t.createdAt != null) existing.createdAt = t.createdAt
    if (!existing.name && t.name) existing.name = t.name
    existing.updatedAt = now
    return existing
  }
  const card: TokenCard = {
    mint: t.mintAddress,
    symbol: t.symbol ?? t.mintAddress.slice(0, 6),
    name: t.name,
    createdAt: t.createdAt ?? now,
    firstSeenAt: now,
    source,
    updatedAt: now,
    sdFlagged: false,
  }
  store.set(card.mint, card)
  evictIfOverCap(store)
  return card
}

export function enrichCardFromScan(
  store: Map<string, TokenCard>,
  entry: ScanFeedEntry,
  sdFlagged: ReadonlyMap<string, number>,
  now: number,
): TokenCard {
  const scanTs = new Date(entry.timestamp).getTime()
  let card = store.get(entry.tokenAddress)
  if (!card) {
    card = {
      mint: entry.tokenAddress,
      symbol: entry.symbol,
      createdAt: Number.isFinite(scanTs) ? scanTs - entry.ageMinutes * 60_000 : null,
      firstSeenAt: now,
      source: 'scan',
      updatedAt: now,
      sdFlagged: false,
    }
    store.set(card.mint, card)
    evictIfOverCap(store)
  }
  card.symbol = entry.symbol || card.symbol
  if (card.createdAt == null && Number.isFinite(scanTs)) card.createdAt = scanTs - entry.ageMinutes * 60_000
  if (entry.pairAddress) card.pairAddress = entry.pairAddress
  if (entry.priceAtScan != null && entry.priceAtScan > 0) card.priceUsd = entry.priceAtScan
  card.liquidityUsd = entry.liquidityUsd
  if (entry.early_strict) card.earlyStrict = { pass: entry.early_strict.pass, reason: entry.early_strict.reason }
  const raw = entry.rawData
  if (raw) {
    card.priceChangeM5 = raw.priceChange?.m5 ?? card.priceChangeM5
    card.priceChangeH1 = raw.priceChange?.h1 ?? card.priceChangeH1
    card.volumeH1 = raw.volume?.h1 ?? card.volumeH1
    if (raw.hasWebsite != null) card.hasWebsite = raw.hasWebsite
    if (raw.hasSocials != null) card.hasSocials = raw.hasSocials
  }
  if (card.volumeH1 != null && entry.liquidityUsd > 0) {
    card.volLiqRatio = card.volumeH1 / entry.liquidityUsd
    card.volLiqLow = card.volLiqRatio <= LOW_VOL_LIQUIDITY_RATIO_THRESHOLD
  }
  card.sdFlagged = sdFlagged.has(entry.tokenAddress)
  card.updatedAt = now
  return card
}

export function listCards(store: Map<string, TokenCard>): TokenCard[] {
  return [...store.values()].sort((a, b) => b.firstSeenAt - a.firstSeenAt)
}

// ==================== Scan-log tail (incremental, read-only) ====================

interface TailState { file: string | null; offset: number; remainder: string }

/** Reads only the bytes appended since the last call; resets when the day rolls over to a new file. */
export async function tailScanLogOnce(state: TailState, onLine: (line: string) => void): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const file = dataPath('scan-log', `${today}.jsonl`)
  if (state.file !== file) { state.file = file; state.offset = 0; state.remainder = '' }
  let size: number
  try { size = (await stat(file)).size } catch { return }
  if (size <= state.offset) return
  const fh = await open(file, 'r')
  try {
    const len = size - state.offset
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, state.offset)
    state.offset = size
    const text = state.remainder + buf.toString('utf-8')
    const lines = text.split('\n')
    state.remainder = lines.pop() ?? ''
    for (const l of lines) if (l.trim()) onLine(l)
  } finally {
    await fh.close()
  }
}

// ==================== Server ====================

interface SseClient { res: ServerResponse }

export async function startManualTradeUi(port = Number(process.env['MANUAL_UI_PORT']) || DEFAULT_UI_PORT): Promise<void> {
  const store = new Map<string, TokenCard>()
  const clients = new Set<SseClient>()
  const broker = await makeManualBroker()
  await loadSilentDistributionFlags()

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of clients) c.res.write(payload)
  }

  // --- fast feeds: cards within seconds of on-chain creation ---
  const pumpFeed = new PumpFunFeed({
    onNewToken: (t: PumpFunToken) => {
      const card = upsertFastFeedCard(store, 'pump', t, Date.now())
      broadcast('card', card)
    },
    onError: err => console.warn(`manual-ui: pump feed error — ${err.message}`),
  })
  pumpFeed.start()

  const heliusFeed = process.env['HELIUS_API_KEY']
    ? new HeliusPoolFeed({
      onNewPool: pool => {
        const card = upsertFastFeedCard(store, 'helius', { mintAddress: pool.mintAddress, createdAt: pool.discoveredAt }, Date.now())
        broadcast('card', card)
      },
      onError: err => console.warn(`manual-ui: helius feed error — ${err.message}`),
    })
    : null
  heliusFeed?.start()
  console.log(`manual-ui: fast feeds — pumpportal ON, helius ${heliusFeed ? 'ON' : 'OFF (no HELIUS_API_KEY — cards still arrive via pumpportal within seconds)'}`)

  // --- scan-log: seed the last hour, then tail every 3s for enrichment ---
  const tail: TailState = { file: null, offset: 0, remainder: '' }
  const seedCutoff = Date.now() - FEED_SEED_WINDOW_MS
  const applyScanLine = (line: string): void => {
    let entry: ScanFeedEntry & { type?: string }
    try { entry = JSON.parse(line) } catch { return }
    if (entry.type === 'exit' || !entry.tokenAddress) return
    const ts = new Date(entry.timestamp).getTime()
    if (ts < seedCutoff && store.size === 0) return
    const card = enrichCardFromScan(store, entry, sdFlaggedTokens, Date.now())
    broadcast('card', card)
  }
  await tailScanLogOnce(tail, applyScanLine) // initial full read of today's file = seed
  setInterval(() => { void tailScanLogOnce(tail, applyScanLine) }, SCAN_TAIL_INTERVAL_MS)
  setInterval(() => { void loadSilentDistributionFlags() }, SD_RELOAD_INTERVAL_MS)

  // --- price-feed subscriptions: newest enriched cards + open positions ---
  const refreshPriceSubs = async (): Promise<void> => {
    const withPair = listCards(store).filter(c => c.pairAddress).slice(0, PRICE_SUB_CAP)
    for (const c of withPair) priceFeed.subscribe(c.pairAddress as string)
    for (const p of await getOpenManualPositions()) priceFeed.subscribe(p.pairAddress)
  }
  setInterval(() => { void refreshPriceSubs() }, SCAN_TAIL_INTERVAL_MS)

  // --- manual position monitoring (same 5s loop as the CLI) ---
  setInterval(() => {
    void (async () => {
      const closedCount = await checkManualExits(broker)
      if (closedCount > 0) {
        const closed = (await getClosedToday()).filter(c => c.strategy === 'manual')
          .sort((a, b) => b.exitTimestamp - a.exitTimestamp).slice(0, closedCount)
        for (const c of closed) broadcast('closed', { symbol: c.symbol, exitReason: c.exitReason, returnPct: c.returnPct, holdingMinutes: c.holdingMinutes })
      }
    })().catch(err => console.error(`manual-ui: exit check failed — ${err instanceof Error ? err.message : String(err)}`))
  }, MANUAL_WATCH_INTERVAL_MS)

  // --- fast buy path: dex-price-feed cache first, live fetch fallback ---
  async function buyFast(mint: string): Promise<{ ok: boolean; error?: string; symbol?: string; entryPrice?: number; latencyMs: number; priceSource: 'cache' | 'fetch' }> {
    const t0 = Date.now()
    const card = store.get(mint)
    const cached = card?.pairAddress ? priceFeed.getLatestPrice(card.pairAddress) : null
    if (card?.pairAddress && cached && cached.priceUsd > 0 && Date.now() - cached.timestamp <= PRICE_CACHE_FRESH_MS) {
      const already = (await getOpenManualPositions()).find(p => p.tokenAddress === mint)
      if (already) return { ok: false, error: `Position déjà ouverte sur ${already.symbol}.`, latencyMs: Date.now() - t0, priceSource: 'cache' }
      const pair: DexScreenerPair = {
        chainId: 'solana',
        pairAddress: card.pairAddress,
        baseToken: { address: mint, symbol: card.symbol, name: card.name ?? card.symbol },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana' },
        priceUsd: String(cached.priceUsd),
        liquidity: { usd: cached.liquidityUsd },
        priceChange: { m5: cached.priceChange.m5 },
        pairCreatedAt: card.createdAt ?? undefined,
      }
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'MKT'
      order.cashQty = new Decimal(TRADE_AMOUNT_USD)
      const result = await (broker as DexBroker).placeOrder(broker.resolveNativeKey(mint), order, undefined, pair)
      if (!result.success) return { ok: false, error: 'Achat paper refusé par le broker.', latencyMs: Date.now() - t0, priceSource: 'cache' }
      const ageMinutes = card.createdAt != null ? (Date.now() - card.createdAt) / 60_000 : 0
      await openPosition(pair, 'manual', cached.priceUsd, ageMinutes, MANUAL_CONFIG.exitConfig, [], true)
      return { ok: true, symbol: card.symbol, entryPrice: cached.priceUsd, latencyMs: Date.now() - t0, priceSource: 'cache' }
    }
    const r = await openManualPosition(broker, mint)
    return r.ok
      ? { ok: true, symbol: r.symbol, entryPrice: r.entryPrice, latencyMs: Date.now() - t0, priceSource: 'fetch' }
      : { ok: false, error: r.error, latencyMs: Date.now() - t0, priceSource: 'fetch' }
  }

  // --- HTTP ---
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'manual-trade-ui.html')
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(await readFile(htmlPath, 'utf-8'))
      } else if (req.method === 'GET' && url.pathname === '/api/feed') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ cards: listCards(store) }))
      } else if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write('event: hello\ndata: {}\n\n')
        const client: SseClient = { res }
        clients.add(client)
        req.on('close', () => clients.delete(client))
      } else if (req.method === 'GET' && url.pathname === '/api/positions') {
        const openPos = await getOpenManualPositions()
        const positions = openPos.map(p => {
          const price = priceFeed.getLatestPrice(p.pairAddress)
          return {
            symbol: p.symbol,
            tokenAddress: p.tokenAddress,
            entryPrice: p.entryPrice,
            currentPrice: price?.priceUsd ?? null,
            returnPct: price ? ((price.priceUsd - p.entryPrice) / p.entryPrice) * 100 : null,
            holdingMinutes: (Date.now() - p.entryTimestamp) / 60_000,
          }
        })
        const closed = await readAllClosed()
        const manualClosed = closed.filter(c => c.strategy === 'manual')
          .sort((a, b) => b.exitTimestamp - a.exitTimestamp)
          .map(c => ({ symbol: c.symbol, exitReason: c.exitReason, returnPct: c.returnPct, holdingMinutes: c.holdingMinutes }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ positions, closed: manualClosed, stats: buildStatsRows(closed) }))
      } else if (req.method === 'POST' && url.pathname === '/api/buy') {
        let body = ''
        for await (const chunk of req) body += chunk
        let mint: unknown
        try { mint = (JSON.parse(body) as { mint?: unknown }).mint } catch { /* handled below */ }
        if (typeof mint !== 'string' || !mint.trim()) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'mint manquant' }))
          return
        }
        const result = await buyFast(mint.trim())
        res.writeHead(result.ok ? 200 : 422, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } else {
        res.writeHead(404)
        res.end()
      }
    })().catch(err => {
      console.error(`manual-ui: request failed — ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`manual-ui: interface d'entraînement sur http://localhost:${port} (127.0.0.1 uniquement)`)
    console.log(`manual-ui: fermer ce process = surveillance des positions manuelles en pause (reprise via pnpm manual-trade ui|watch)`)
  })
}
