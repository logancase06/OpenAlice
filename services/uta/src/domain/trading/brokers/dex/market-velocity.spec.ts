import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { recordVelocitySnapshot, getMarketVelocity } from './market-velocity.js'
import { dataPath } from '@/core/paths.js'

const FILE_PATH = dataPath('snapshots', 'market-velocity.json')

beforeEach(async () => {
  await rm(FILE_PATH, { force: true })
})

afterEach(async () => {
  await rm(FILE_PATH, { force: true })
})

async function readRawSnapshots(): Promise<unknown[]> {
  try {
    return JSON.parse(await readFile(FILE_PATH, 'utf-8'))
  } catch {
    return []
  }
}

describe('recordVelocitySnapshot', () => {
  it('creates the file on the first snapshot', async () => {
    await recordVelocitySnapshot(10)
    const raw = await readRawSnapshots()
    expect(raw).toHaveLength(1)
  })

  it('accumulates snapshots up to 48, then evicts the oldest', async () => {
    for (let i = 0; i < 50; i++) {
      await recordVelocitySnapshot(i)
    }
    const raw = await readRawSnapshots() as Array<{ tokenCount: number }>
    expect(raw).toHaveLength(48)
    // First two (tokenCount 0 and 1) evicted; oldest remaining is tokenCount 2.
    expect(raw[0]!.tokenCount).toBe(2)
    expect(raw[47]!.tokenCount).toBe(49)
  })
})

describe('getMarketVelocity', () => {
  it('returns an empty/stable result with fewer than 2 snapshots', async () => {
    const velocity = await getMarketVelocity()
    expect(velocity.snapshotCount).toBe(0)
    expect(velocity.trend).toBe('stable')
    expect(velocity.tokensPerHour).toBe(0)

    await recordVelocitySnapshot(5)
    const velocity2 = await getMarketVelocity()
    expect(velocity2.snapshotCount).toBe(1)
    expect(velocity2.trend).toBe('stable')
  })

  it('reports trend "accelerating" when the most recent window is well above the earliest', async () => {
    await mkdir(dataPath('snapshots'), { recursive: true })
    const now = Date.now()
    const snapshots = [
      ...Array.from({ length: 6 }, (_, i) => ({ tokenCount: 5, timestamp: now - (12 - i) * 300_000 })),
      ...Array.from({ length: 6 }, (_, i) => ({ tokenCount: 50, timestamp: now - (6 - i) * 300_000 })),
    ]
    await writeFile(FILE_PATH, JSON.stringify(snapshots))

    const velocity = await getMarketVelocity()
    expect(velocity.trend).toBe('accelerating')
  })

  it('reports trend "decelerating" when the most recent window is well below the earliest', async () => {
    await mkdir(dataPath('snapshots'), { recursive: true })
    const now = Date.now()
    const snapshots = [
      ...Array.from({ length: 6 }, (_, i) => ({ tokenCount: 50, timestamp: now - (12 - i) * 300_000 })),
      ...Array.from({ length: 6 }, (_, i) => ({ tokenCount: 5, timestamp: now - (6 - i) * 300_000 })),
    ]
    await writeFile(FILE_PATH, JSON.stringify(snapshots))

    const velocity = await getMarketVelocity()
    expect(velocity.trend).toBe('decelerating')
  })

  it('reports isHighActivity: true when tokensPerHour exceeds 50', async () => {
    await mkdir(dataPath('snapshots'), { recursive: true })
    const now = Date.now()
    // Two snapshots, 1 minute apart, totalling 100 tokens -> ~6000/h.
    const snapshots = [
      { tokenCount: 50, timestamp: now - 60_000 },
      { tokenCount: 50, timestamp: now },
    ]
    await writeFile(FILE_PATH, JSON.stringify(snapshots))

    const velocity = await getMarketVelocity()
    expect(velocity.isHighActivity).toBe(true)
    expect(velocity.tokensPerHour).toBeGreaterThan(50)
  })

  it('does not crash on a corrupted snapshot file', async () => {
    await mkdir(dataPath('snapshots'), { recursive: true })
    await writeFile(FILE_PATH, '{not valid json[[[')

    const velocity = await getMarketVelocity()
    expect(velocity.snapshotCount).toBe(0)
  })
})
