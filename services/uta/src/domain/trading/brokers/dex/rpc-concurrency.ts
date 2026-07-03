/**
 * Shared concurrency gate for outbound Solana RPC calls across solana-rpc.ts
 * and wallet-watcher.ts. Deliberately a real shared module (not the usual
 * per-file duplication convention in this directory) — both modules hit the
 * same Helius API key, so the cap has to be one counter, not one per
 * module, to actually bound the account's total in-flight request count.
 */

const MAX_CONCURRENT_RPC_CALLS = 3
// Each call still resolves within its own bounded timeout, so the queue
// always drains eventually — but under sustained high arrival / low
// departure (an outage, hundreds of scanned tokens per cycle), unbounded
// growth means requests queued tens of minutes ago still get serviced long
// after the cycle that needed them is irrelevant. Bounding it turns that
// into a fast, explicit failure the caller already knows how to handle
// (every RPC caller in this codebase already treats a failure as "skip,
// fail-safe"), rather than silent unbounded memory/latency growth.
const MAX_QUEUE_DEPTH = 50

let active = 0
const queue: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_RPC_CALLS) {
    active++
    return Promise.resolve()
  }
  if (queue.length >= MAX_QUEUE_DEPTH) {
    throw new Error(`RPC queue full (${MAX_QUEUE_DEPTH}) — dropping request, RPC may be overloaded`)
  }
  return new Promise(resolve => queue.push(resolve))
}

function release(): void {
  active--
  const next = queue.shift()
  if (next) {
    active++
    next()
  }
}

/** Runs `fn` once a slot is free (max 3 concurrent across the whole process); others wait in FIFO order. */
export async function withRpcSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}
