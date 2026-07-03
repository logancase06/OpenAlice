import { describe, it, expect } from 'vitest'
import { simulateExitForToken, evaluateExitRulesWithConfig, EXIT_CONFIGS, type SimPosition, type PriceTick } from './exit-sim.js'

const CONFIG_A = EXIT_CONFIGS[0]! // Actuelle (simplifiée): stopLoss -25, trailingStop -20, takeProfit 300, timeExit 1440
const CONFIG_B = EXIT_CONFIGS[1]! // ConfigB: stopLoss -15, trailingStop -12, takeProfit 100, timeExit 240
const CONFIG_D = EXIT_CONFIGS[3]! // ConfigD: momentumReversalThreshold -10

function position(overrides: Partial<SimPosition> = {}): SimPosition {
  return {
    tokenAddress: 'tok1',
    symbol: 'TEST',
    strategy: 'early',
    entryPrice: 1.0,
    entryLiquidityUsd: 10_000,
    entryTimestamp: 0,
    ...overrides,
  }
}

describe('simulateExitForToken', () => {
  it('triggers stop_loss at the first tick where returnPct crosses the threshold, not earlier', () => {
    const ticks: PriceTick[] = [
      { timestamp: 60_000, price: 0.95, liquidityUsd: 10_000 }, // -5%
      { timestamp: 120_000, price: 0.80, liquidityUsd: 10_000 }, // -20%
      { timestamp: 180_000, price: 0.70, liquidityUsd: 10_000 }, // -30% <= -25 -> stop_loss here
    ]

    const result = simulateExitForToken(position(), ticks, CONFIG_A)

    expect(result.exitReason).toBe('stop_loss')
    expect(result.exitPrice).toBe(0.70)
    expect(result.holdingMinutes).toBeCloseTo(3, 5)
  })

  it('triggers trailing_stop when the drop-from-peak threshold is crossed', () => {
    const ticks: PriceTick[] = [
      { timestamp: 60_000, price: 1.5, liquidityUsd: 10_000 }, // new peak 1.5, +50%
      { timestamp: 120_000, price: 1.2, liquidityUsd: 10_000 }, // drop (1.2-1.5)/1.5 = -20% <= trailingStop(-20)
    ]

    const result = simulateExitForToken(position(), ticks, CONFIG_B)

    expect(result.exitReason).toBe('trailing_stop')
    expect(result.exitPrice).toBe(1.2)
  })

  it('triggers take_profit once returnPct clears the threshold', () => {
    const ticks: PriceTick[] = [
      { timestamp: 60_000, price: 4.5, liquidityUsd: 10_000 }, // +350% >= takeProfitPct(300)
    ]

    const result = simulateExitForToken(position(), ticks, CONFIG_A)

    expect(result.exitReason).toBe('take_profit')
  })

  it('triggers time_exit once holdingMinutes clears the threshold with no other rule firing', () => {
    const ticks: PriceTick[] = [
      { timestamp: (CONFIG_A.timeExitMinutes + 1) * 60_000, price: 1.0, liquidityUsd: 10_000 }, // flat price, just past the time threshold
    ]

    const result = simulateExitForToken(position(), ticks, CONFIG_A)

    expect(result.exitReason).toBe('time_exit')
  })

  it('triggers momentum_reversal when priceChange5m crosses the configured threshold on a losing position', () => {
    const ticks: PriceTick[] = [
      { timestamp: 60_000, price: 0.95, liquidityUsd: 10_000, priceChange5m: -12 }, // -5% return, momentum <= -10
    ]

    const result = simulateExitForToken(position(), ticks, CONFIG_D)

    expect(result.exitReason).toBe('momentum_reversal')
  })

  it('reports exitReason: null (still open in sim) when no rule ever triggers in the available history', () => {
    const ticks: PriceTick[] = [
      { timestamp: 60_000, price: 1.02, liquidityUsd: 10_000 },
      { timestamp: 120_000, price: 1.01, liquidityUsd: 10_000 },
      { timestamp: 180_000, price: 1.03, liquidityUsd: 10_000 },
    ]

    const result = simulateExitForToken(position(), ticks, CONFIG_A)

    expect(result.exitReason).toBeNull()
    expect(result.exitPrice).toBeNull()
    expect(result.returnPct).toBeNull()
  })
})

describe('evaluateExitRulesWithConfig', () => {
  it('does not trigger any rule when nothing crosses a threshold', () => {
    const reason = evaluateExitRulesWithConfig(
      { entryPrice: 1.0, entryLiquidityUsd: 10_000, entryTimestamp: 0, peakPrice: 1.0 },
      1.01,
      undefined,
      60_000,
      CONFIG_A,
    )
    expect(reason).toBeNull()
  })
})
