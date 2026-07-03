import { describe, it, expect } from 'vitest'
import { withRpcSlot } from './rpc-concurrency.js'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('withRpcSlot', () => {
  it('never runs more than 3 tasks concurrently, queuing the rest', async () => {
    let active = 0
    let maxActive = 0
    const gates = Array.from({ length: 6 }, () => deferred<void>())

    const runs = gates.map((gate, i) => withRpcSlot(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await gate.promise
      active--
      return i
    }))

    await new Promise(r => setTimeout(r, 10))
    expect(active).toBe(3)
    expect(maxActive).toBe(3)

    for (const gate of gates) {
      gate.resolve()
      await new Promise(r => setTimeout(r, 5))
    }

    const results = await Promise.all(runs)
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
    expect(maxActive).toBe(3)
  })

  it('runs a single task immediately when there is no contention', async () => {
    const result = await withRpcSlot(async () => 42)
    expect(result).toBe(42)
  })

  it('releases the slot for the next task even when the running task throws', async () => {
    await expect(withRpcSlot(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // If the slot weren't released on throw, this would hang until the test's own timeout.
    const result = await withRpcSlot(async () => 'ok')
    expect(result).toBe('ok')
  })

  it('rejects immediately once the queue reaches its max depth (50), instead of growing unbounded', async () => {
    const gate = deferred<void>()
    // 3 occupy the active slots, 50 more fill the queue exactly to its cap.
    const pending = Array.from({ length: 53 }, () => withRpcSlot(() => gate.promise))
    await new Promise(r => setTimeout(r, 10)) // let them all actually queue up

    await expect(withRpcSlot(async () => 'never runs')).rejects.toThrow(/queue full/i)

    gate.resolve()
    await Promise.all(pending)
  })
})
