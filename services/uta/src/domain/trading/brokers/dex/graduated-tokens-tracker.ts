/**
 * Tracks tokens observed graduating from pump.fun's bonding curve to
 * PumpSwap (see `helius-pool-feed.ts`'s `onGraduation`), so GRAD_DIP can
 * watch for a post-graduation dip-then-recovery without re-deriving "when
 * did this token graduate and what was its peak since then" from scratch
 * every scan cycle.
 *
 * Persisted to `data/graduated/active.json` — survives a scanner restart,
 * same rationale as `position-tracker.ts`'s open positions.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'
import type { GraduationEvent } from './helius-pool-feed.js'

const MAX_WATCH_MS = 6 * 60 * 60_000
const MAX_TRACKED = 100
/** "dip -25% à -60% depuis peak" — depth must be at least 25% but no more than 60%. */
const DIP_MIN_PCT = -60
const DIP_MAX_PCT = -25

export interface GraduatedToken {
  mintAddress: string
  symbol?: string
  graduatedAt: number
  peakPriceSinceGrad: number
  peakPriceAt: number
  currentPrice: number
  lastChecked: number
  pairAddress?: string
  initialLiquidityUsd?: number
}

function graduatedTokensPath(): string {
  return dataPath('graduated', 'active.json')
}

/** Same atomic tmp+rename pattern used throughout this directory (wallet-watcher.ts, wallet-bootstrapper.ts). */
async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmpPath, filePath)
}

export class GraduatedTokensTracker {
  private tokens = new Map<string, GraduatedToken>()

  /** Restores from `data/graduated/active.json` — call once at startup, mirroring `restoreOpenPositions` in live-scan.ts. A missing/corrupt file starts empty rather than throwing (this is a discovery aid, not financial state — losing it is not a "refuse to start" condition, unlike position-tracker.ts's corrupt-JSON handling). */
  async load(): Promise<void> {
    try {
      const raw = await readFile(graduatedTokensPath(), 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const t of parsed as GraduatedToken[]) this.tokens.set(t.mintAddress, t)
      }
    } catch {
      // No file yet, or corrupt — start empty. See docstring above for why this differs from position-tracker.ts's stricter handling.
    }
  }

  private async persist(): Promise<void> {
    await writeJsonAtomically(graduatedTokensPath(), [...this.tokens.values()])
  }

  /**
   * Ignored if `mintAddress` is already tracked — a re-graduation
   * notification (confirmed live 2026-07-02: pump.fun's program can emit
   * more than one genuine `Instruction: Migrate` log for the same mint, not
   * just theoretically) must never reset an in-progress peak. FIFO-evicts
   * the oldest-graduated entry at MAX_TRACKED, same convention as
   * live-scan.ts's pump/Helius watchlists.
   *
   * Returns whether this call actually added a new entry — callers MUST use
   * this to gate one-time actions like GRAD_IMMEDIATE's buy (see
   * live-scan.ts's onGraduation wiring): without it, the same live
   * duplicate-Migrate-log scenario above bought the same token 3 times in a
   * row before this return value existed.
   */
  async add(event: GraduationEvent, opts?: { symbol?: string; initialLiquidityUsd?: number }): Promise<boolean> {
    if (this.tokens.has(event.mintAddress)) return false
    if (this.tokens.size >= MAX_TRACKED) {
      const oldest = [...this.tokens.values()].sort((a, b) => a.graduatedAt - b.graduatedAt)[0]
      if (oldest) this.tokens.delete(oldest.mintAddress)
    }
    this.tokens.set(event.mintAddress, {
      mintAddress: event.mintAddress,
      symbol: opts?.symbol,
      graduatedAt: event.graduatedAt,
      peakPriceSinceGrad: 0,
      peakPriceAt: event.graduatedAt,
      currentPrice: 0,
      lastChecked: event.graduatedAt,
      initialLiquidityUsd: opts?.initialLiquidityUsd,
    })
    await this.persist()
    return true
  }

  /** No-op for an untracked mint (already evicted/never added — never throws). Peak only ever increases — a price below the tracked peak updates `currentPrice`/`lastChecked` but never regresses `peakPriceSinceGrad`. */
  async updatePrice(mintAddress: string, price: number, _liquidity: number, opts?: { pairAddress?: string }): Promise<void> {
    const token = this.tokens.get(mintAddress)
    if (!token) return
    const now = Date.now()
    token.currentPrice = price
    token.lastChecked = now
    if (opts?.pairAddress) token.pairAddress = opts.pairAddress
    if (price > token.peakPriceSinceGrad) {
      token.peakPriceSinceGrad = price
      token.peakPriceAt = now
    }
    await this.persist()
  }

  /**
   * Tokens currently in the -25%/-60% dip-from-peak range. `priceChange.m5`
   * is NOT checked here (this tracker never receives it — only
   * `currentPrice`/`liquidity` via `updatePrice`) — the caller
   * (`handleGradDip` in live-scan.ts) re-fetches a live pair for each
   * candidate this returns and applies the `priceChange.m5 > 0` check there,
   * matching the two-stage design in the implementation spec.
   */
  getEligibleForDip(): GraduatedToken[] {
    return [...this.tokens.values()].filter((t) => {
      if (t.peakPriceSinceGrad <= 0 || t.currentPrice <= 0) return false
      const dipPct = ((t.currentPrice - t.peakPriceSinceGrad) / t.peakPriceSinceGrad) * 100
      return dipPct >= DIP_MIN_PCT && dipPct <= DIP_MAX_PCT
    })
  }

  /** Removes tokens graduated more than 6h ago. */
  async cleanup(): Promise<void> {
    const cutoff = Date.now() - MAX_WATCH_MS
    let changed = false
    for (const [mint, token] of this.tokens) {
      if (token.graduatedAt < cutoff) {
        this.tokens.delete(mint)
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  getAll(): GraduatedToken[] {
    return [...this.tokens.values()]
  }
}
