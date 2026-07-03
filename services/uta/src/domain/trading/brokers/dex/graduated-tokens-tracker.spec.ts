import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rm, readFile } from 'node:fs/promises'
import { dataPath } from '@/core/paths.js'
import { GraduatedTokensTracker } from './graduated-tokens-tracker.js'
import type { GraduationEvent } from './helius-pool-feed.js'

function event(mintAddress: string, graduatedAt: number): GraduationEvent {
  return { mintAddress, graduatedAt, signature: `sig-${mintAddress}`, source: 'helius_logs' }
}

beforeEach(async () => {
  await rm(dataPath('graduated'), { recursive: true, force: true })
})

afterEach(async () => {
  await rm(dataPath('graduated'), { recursive: true, force: true })
  vi.useRealTimers()
})

describe('GraduatedTokensTracker', () => {
  it('add() persists the token to data/graduated/active.json', async () => {
    const tracker = new GraduatedTokensTracker()
    await tracker.add(event('Mint1', Date.now()))

    const raw = JSON.parse(await readFile(dataPath('graduated', 'active.json'), 'utf-8'))
    expect(raw).toHaveLength(1)
    expect(raw[0].mintAddress).toBe('Mint1')
  })

  it('add() ignores a duplicate mint — never resets an already-tracked token', async () => {
    const tracker = new GraduatedTokensTracker()
    const t0 = Date.now()
    await tracker.add(event('Mint1', t0))
    await tracker.updatePrice('Mint1', 10, 5000)
    await tracker.add(event('Mint1', t0 + 60_000)) // re-notification, should be a no-op

    const all = tracker.getAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.peakPriceSinceGrad).toBe(10) // untouched by the duplicate add
  })

  it('add() returns true on a genuine new add and false on a duplicate — callers gate one-time actions on this', async () => {
    const tracker = new GraduatedTokensTracker()
    await expect(tracker.add(event('Mint1', Date.now()))).resolves.toBe(true)
    await expect(tracker.add(event('Mint1', Date.now()))).resolves.toBe(false)
  })

  it('updatePrice() never regresses peakPriceSinceGrad', async () => {
    const tracker = new GraduatedTokensTracker()
    await tracker.add(event('Mint1', Date.now()))

    await tracker.updatePrice('Mint1', 10, 5000)
    await tracker.updatePrice('Mint1', 20, 6000)
    await tracker.updatePrice('Mint1', 5, 4000) // price drops — peak must stay at 20

    const token = tracker.getAll().find(t => t.mintAddress === 'Mint1')
    expect(token!.peakPriceSinceGrad).toBe(20)
    expect(token!.currentPrice).toBe(5)
  })

  it('updatePrice() on an untracked mint is a no-op, never throws', async () => {
    const tracker = new GraduatedTokensTracker()
    await expect(tracker.updatePrice('NeverAdded', 10, 5000)).resolves.toBeUndefined()
    expect(tracker.getAll()).toHaveLength(0)
  })

  it('getEligibleForDip(): a -30% dip is included', async () => {
    const tracker = new GraduatedTokensTracker()
    await tracker.add(event('Mint1', Date.now()))
    await tracker.updatePrice('Mint1', 100, 5000)
    await tracker.updatePrice('Mint1', 70, 5000) // -30% from peak

    const eligible = tracker.getEligibleForDip()
    expect(eligible.map(t => t.mintAddress)).toEqual(['Mint1'])
  })

  it('getEligibleForDip(): a -70% dip is excluded (too deep)', async () => {
    const tracker = new GraduatedTokensTracker()
    await tracker.add(event('Mint1', Date.now()))
    await tracker.updatePrice('Mint1', 100, 5000)
    await tracker.updatePrice('Mint1', 30, 5000) // -70%

    expect(tracker.getEligibleForDip()).toEqual([])
  })

  it('getEligibleForDip(): a -10% dip is excluded (not enough)', async () => {
    const tracker = new GraduatedTokensTracker()
    await tracker.add(event('Mint1', Date.now()))
    await tracker.updatePrice('Mint1', 100, 5000)
    await tracker.updatePrice('Mint1', 90, 5000) // -10%

    expect(tracker.getEligibleForDip()).toEqual([])
  })

  it('cleanup() removes tokens graduated more than 6h ago', async () => {
    const tracker = new GraduatedTokensTracker()
    const now = Date.now()
    await tracker.add(event('Old', now - 7 * 60 * 60_000))
    await tracker.add(event('Recent', now - 1 * 60 * 60_000))

    await tracker.cleanup()

    expect(tracker.getAll().map(t => t.mintAddress)).toEqual(['Recent'])
  })

  it('load() restores tracked tokens from a prior run', async () => {
    const tracker1 = new GraduatedTokensTracker()
    await tracker1.add(event('Mint1', Date.now()))

    const tracker2 = new GraduatedTokensTracker()
    await tracker2.load()

    expect(tracker2.getAll().map(t => t.mintAddress)).toEqual(['Mint1'])
  })

  it('load() starts empty (no throw) when active.json does not exist yet', async () => {
    const tracker = new GraduatedTokensTracker()
    await expect(tracker.load()).resolves.toBeUndefined()
    expect(tracker.getAll()).toEqual([])
  })

  it('getAll() returns every currently-tracked token', async () => {
    const tracker = new GraduatedTokensTracker()
    await tracker.add(event('A', Date.now()))
    await tracker.add(event('B', Date.now()))
    expect(tracker.getAll().map(t => t.mintAddress).sort()).toEqual(['A', 'B'])
  })
})
