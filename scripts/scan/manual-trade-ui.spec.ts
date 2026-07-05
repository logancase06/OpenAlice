import { describe, it, expect } from 'vitest'
import {
  CARD_CAP,
  upsertFastFeedCard,
  enrichCardFromScan,
  listCards,
  type TokenCard,
  type ScanFeedEntry,
} from './manual-trade-ui.js'
import { buildStatsRows } from './manual-trade-core.js'
import type { ClosedPosition } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'

const NOW = 1_800_000_000_000
const NO_SD = new Map<string, number>()

function scanEntry(overrides: Partial<ScanFeedEntry> = {}): ScanFeedEntry {
  return {
    timestamp: new Date(NOW).toISOString(),
    tokenAddress: 'mintA',
    pairAddress: 'pair-mintA',
    symbol: 'AAA',
    ageMinutes: 42,
    liquidityUsd: 20_000,
    priceAtScan: 0.001,
    early_strict: { pass: true, reason: 'passed all checks' },
    rawData: { priceChange: { m5: -3, h1: 12 }, volume: { h1: 50_000 }, hasWebsite: true, hasSocials: false },
    ...overrides,
  }
}

describe('manual-trade-ui card store', () => {
  it('a fast-feed event creates a card immediately with partial data (no blocking enrichment)', () => {
    const store = new Map<string, TokenCard>()
    const card = upsertFastFeedCard(store, 'pump', { mintAddress: 'mintFresh', symbol: 'FRSH', name: 'Fresh', createdAt: NOW - 4_000 }, NOW)

    expect(card).toMatchObject({ mint: 'mintFresh', symbol: 'FRSH', source: 'pump', createdAt: NOW - 4_000, sdFlagged: false })
    expect(card.priceUsd).toBeUndefined() // partial — enrichment comes later
    expect(listCards(store)).toHaveLength(1)
  })

  it('scan enrichment fills price/liquidity/signals on an existing fast-feed card without resetting identity', () => {
    const store = new Map<string, TokenCard>()
    upsertFastFeedCard(store, 'pump', { mintAddress: 'mintA', symbol: 'AAA', createdAt: NOW - 60_000 }, NOW - 60_000)

    const card = enrichCardFromScan(store, scanEntry(), NO_SD, NOW)

    expect(card.source).toBe('pump') // identity preserved
    expect(card.firstSeenAt).toBe(NOW - 60_000)
    expect(card.createdAt).toBe(NOW - 60_000) // fast-feed createdAt not overwritten by scan-derived estimate
    expect(card).toMatchObject({ priceUsd: 0.001, liquidityUsd: 20_000, hasWebsite: true, hasSocials: false })
    expect(card.earlyStrict).toEqual({ pass: true, reason: 'passed all checks' })
    expect(card.volLiqRatio).toBeCloseTo(2.5) // 50k / 20k
    expect(card.volLiqLow).toBe(true) // <= 3.64
  })

  it('a scan entry for an unknown mint creates the card, deriving createdAt from ageMinutes', () => {
    const store = new Map<string, TokenCard>()
    const card = enrichCardFromScan(store, scanEntry({ tokenAddress: 'mintScanOnly' }), NO_SD, NOW)

    expect(card.source).toBe('scan')
    expect(card.createdAt).toBe(NOW - 42 * 60_000)
  })

  it('flags sdFlagged from the silent-distribution registry and vol/liq high ratios as not-low', () => {
    const store = new Map<string, TokenCard>()
    const sd = new Map([['mintA', NOW - 10 * 60_000]])
    const card = enrichCardFromScan(store, scanEntry({ rawData: { volume: { h1: 200_000 }, priceChange: {} } }), sd, NOW)

    expect(card.sdFlagged).toBe(true)
    expect(card.volLiqRatio).toBeCloseTo(10) // 200k / 20k
    expect(card.volLiqLow).toBe(false)
  })

  it('lists newest-first and evicts the oldest card past CARD_CAP', () => {
    const store = new Map<string, TokenCard>()
    for (let i = 0; i <= CARD_CAP; i++) {
      upsertFastFeedCard(store, 'pump', { mintAddress: `mint${i}`, symbol: `S${i}` }, NOW + i)
    }
    expect(store.size).toBe(CARD_CAP)
    expect(store.has('mint0')).toBe(false) // oldest evicted
    const cards = listCards(store)
    expect(cards[0]!.mint).toBe(`mint${CARD_CAP}`) // newest first
  })
})

describe('buildStatsRows (manual-trade-core)', () => {
  function closed(strategy: ClosedPosition['strategy'], returnPct: number): ClosedPosition {
    return { strategy, returnPct } as ClosedPosition
  }

  it('puts MES PICKS first when manual trades exist, other strategies by volume', () => {
    const rows = buildStatsRows([
      closed('early', -5), closed('early', 10), closed('early', -2),
      closed('early_strict', 4),
      closed('manual', 100), closed('manual', -20),
    ])
    expect(rows[0]).toMatchObject({ label: 'MES PICKS', n: 2, winRatePct: 50, avgReturnPct: 40 })
    expect(rows[1]!.label).toBe('early')
    expect(rows[2]!.label).toBe('early_strict')
  })

  it('omits the MES PICKS row when no manual trade is closed yet', () => {
    const rows = buildStatsRows([closed('early', 1)])
    expect(rows.every(r => r.label !== 'MES PICKS')).toBe(true)
  })
})
