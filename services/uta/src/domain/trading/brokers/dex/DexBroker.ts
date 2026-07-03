/**
 * DexBroker — paper-mode-only IBroker implementation for on-chain meme-coin
 * trading (Solana / Ethereum / Base / BSC), one instance per chain.
 *
 * Phase A (this file): `paper: true` is the only supported mode. Positions
 * are simulated fills against real DexScreener prices, tracked in an
 * in-memory ledger — same shape as MockBroker, but marked-to-market against
 * live DexScreener data instead of an injected/simulator price. No wallet,
 * no signing, no on-chain transaction ever happens here.
 *
 * Real execution (Jupiter swap submission for Solana, signed router tx for
 * EVM) is Phase B — `init()` refuses to start a `paper: false` account with
 * a clear CONFIG error rather than silently no-op or half-work.
 */
import { z } from 'zod'
import Decimal from 'decimal.js'
import {
  Contract,
  ContractDescription,
  ContractDetails,
  Order,
  OrderCancel,
  OrderState,
  UNSET_DECIMAL,
} from '@traderalice/ibkr'
import {
  BrokerError,
  type IBroker,
  type AccountCapabilities,
  type AccountInfo,
  type Position,
  type PlaceOrderResult,
  type OpenOrder,
  type Quote,
  type MarketClock,
  type TpSlParams,
} from '../types.js'
import '../../contract-ext.js'
import { derivePositionMath, aggregateAccountFromPositions } from '../../position-math.js'
import { buildPosition } from '../contract-builder.js'
import { pairToContract, tokenAddressToContract, contractToTokenAddress } from './dex-contracts.js'
import { searchDexScreenerPairs, fetchDexScreenerTokenPairs, bestPair, type DexScreenerPair } from './dex-market-data.js'

/**
 * Mirrors scripts/scan/live-scan.ts's TRADE_AMOUNT_USD — duplicated rather
 * than imported, since a domain/broker module must not depend on an
 * application script (same convention as dex-market-data.ts/wallet-watcher.ts
 * each independently resolving HELIUS_API_KEY). Keep the two in sync if
 * position sizing changes.
 */
const DEFAULT_RESTORE_TRADE_USD = 50

export const DEX_CHAINS = ['solana', 'ethereum', 'base', 'bsc'] as const
export type DexChain = (typeof DEX_CHAINS)[number]

export interface DexBrokerMeta {
  chain: DexChain
  /** Public wallet address only — Phase A never holds a private key. */
  walletAddress?: string
}

interface InternalPosition {
  contract: Contract
  quantity: Decimal
  avgCost: Decimal
}

interface InternalOrder {
  id: string
  contract: Contract
  order: Order
  status: 'Filled'
  avgFillPrice: Decimal
}

export interface DexBrokerOptions {
  id: string
  label?: string
  chain: DexChain
  paper: boolean
  paperCashUsd?: number
}

export class DexBroker implements IBroker<DexBrokerMeta> {
  // ---- Self-registration ----

  static configSchema = z.object({
    chain: z.enum(DEX_CHAINS),
    paper: z.boolean().default(true),
    paperCashUsd: z.coerce.number().default(1000),
  })

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): DexBroker {
    const bc = DexBroker.configSchema.parse(config.brokerConfig)
    return new DexBroker({
      id: config.id,
      label: config.label,
      chain: bc.chain,
      paper: bc.paper,
      paperCashUsd: bc.paperCashUsd,
    })
  }

  // ---- Instance ----

  readonly id: string
  readonly label: string
  readonly meta: DexBrokerMeta
  private readonly chain: DexChain
  private readonly paper: boolean

  private cash: Decimal
  private realizedPnL = new Decimal(0)
  private positions = new Map<string, InternalPosition>()
  private orders = new Map<string, InternalOrder>()
  private contractRegistry = new Map<string, Contract>()
  private nextOrderId = 1

  constructor(options: DexBrokerOptions) {
    this.id = options.id
    this.label = options.label ?? `DEX (${options.chain})`
    this.chain = options.chain
    this.paper = options.paper
    this.cash = new Decimal(options.paperCashUsd ?? 1000)
    this.meta = { chain: options.chain }
  }

  // ---- Lifecycle ----

  async init(): Promise<void> {
    if (!this.paper) {
      throw new BrokerError(
        'CONFIG',
        'Real DEX execution is not implemented yet — set paper: true. ' +
        '(Real signing lands in a later phase, gated behind an explicit live-trading flag.)',
      )
    }
  }

  async close(): Promise<void> {}

  // ---- Contract search ----

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    const pairs = await searchDexScreenerPairs(pattern)
    const byToken = new Map<string, DexScreenerPair>()
    for (const p of pairs) {
      if (p.chainId !== this.chain) continue
      const addr = p.baseToken.address
      const existing = byToken.get(addr)
      if (!existing || (p.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) byToken.set(addr, p)
    }
    return [...byToken.values()].map((pair) => {
      const desc = new ContractDescription()
      desc.contract = this.rememberContract(pairToContract(pair, this.chain))
      return desc
    })
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const tokenAddress = contractToTokenAddress(query)
    const pairs = await fetchDexScreenerTokenPairs(this.chain, tokenAddress)
    const pair = bestPair(pairs)
    if (!pair) return null

    const details = new ContractDetails()
    details.contract = this.rememberContract(pairToContract(pair, this.chain))
    details.longName = pair.baseToken.name
    return details
  }

  // ---- Trading operations ----

  /**
   * `knownPair` skips the DexScreener fetch entirely when the caller already
   * has a fresh pair in hand — e.g. live-scan.ts's scan loop fetches the
   * pair once per candidate, then both `checkTokenSecurity` and this method
   * used to each re-fetch the exact same data independently. Absent, this
   * behaves exactly as before (fetches via `getQuote`).
   */
  async placeOrder(contract: Contract, order: Order, _tpsl?: TpSlParams, knownPair?: DexScreenerPair): Promise<PlaceOrderResult> {
    if (!this.paper) {
      return { success: false, error: 'Real DEX execution is not implemented yet (paper: false)' }
    }

    let quote: Quote
    try {
      quote = knownPair
        ? this.buildQuoteFromPair(contract, contractToTokenAddress(contract), knownPair)
        : await this.getQuote(contract)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
    const price = new Decimal(quote.last)

    const side = order.action.toUpperCase()
    const cashQty = !order.cashQty.equals(UNSET_DECIMAL) ? order.cashQty : undefined
    const qty = cashQty && cashQty.gt(0)
      ? cashQty.div(price)
      : (!order.totalQuantity.equals(UNSET_DECIMAL) ? order.totalQuantity : new Decimal(0))

    if (qty.lte(0)) {
      return { success: false, error: 'Order quantity must be positive' }
    }

    try {
      this.applyFill(contract, side, qty, price)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    const cost = qty.mul(price)
    this.cash = side === 'BUY' ? this.cash.minus(cost) : this.cash.plus(cost)

    const orderId = `dex-ord-${this.nextOrderId++}`
    this.orders.set(orderId, { id: orderId, contract, order, status: 'Filled', avgFillPrice: price })

    const orderState = new OrderState()
    orderState.status = 'Filled'
    return { success: true, orderId, orderState }
  }

  async modifyOrder(_orderId: string, _changes: Partial<Order>): Promise<PlaceOrderResult> {
    return { success: false, error: 'DEX swaps fill immediately — there is no resting order to modify' }
  }

  async cancelOrder(_orderId: string, _orderCancel?: OrderCancel): Promise<PlaceOrderResult> {
    return { success: false, error: 'DEX swaps fill immediately — there is no resting order to cancel' }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const key = this.getNativeKey(contract)
    const pos = this.positions.get(key)
    if (!pos) return { success: false, error: `No open position for ${key}` }

    const order = new Order()
    order.action = 'SELL'
    order.orderType = 'MKT'
    order.totalQuantity = quantity ?? pos.quantity
    return this.placeOrder(pos.contract, order)
  }

  /**
   * Re-inject a position into the in-memory ledger without any network call
   * or quote fetch — synchronous, no `getQuote()`, no TradingGit event (this
   * is state recovery, not a new order). Used at scanner startup to recover
   * what position-tracker.ts persisted across a process restart: this
   * ledger is purely in-memory and would otherwise start empty, causing
   * `evaluateStrategy`'s `hasOpenPosition` check to miss the position and
   * re-buy the same token (see live-scan.ts's restore loop). Same weighted-
   * average-cost accumulation as `applyFill`'s BUY path, so calling this
   * twice for the same token merges rather than duplicating.
   *
   * `quantity` defaults to `DEFAULT_RESTORE_TRADE_USD / entryPrice` — valid
   * only as long as every buy uses that same fixed trade size; pass an
   * explicit `quantity` when that assumption doesn't hold.
   */
  restorePosition(tokenAddress: string, entryPrice: number, quantity?: number): void {
    if (!this.paper) {
      throw new BrokerError('CONFIG', 'restorePosition is only supported in paper mode')
    }
    const price = new Decimal(entryPrice)
    if (!price.isFinite() || !price.gt(0)) {
      throw new Error(`DexBroker[${this.id}]: cannot restore position for ${tokenAddress} — invalid entryPrice ${entryPrice}`)
    }
    const qty = quantity != null ? new Decimal(quantity) : new Decimal(DEFAULT_RESTORE_TRADE_USD).div(price)

    const contract = tokenAddressToContract(tokenAddress, this.chain)
    this.rememberContract(contract)
    const key = this.getNativeKey(contract)

    const existing = this.positions.get(key)
    if (existing) {
      const totalCost = existing.avgCost.mul(existing.quantity).plus(price.mul(qty))
      existing.quantity = existing.quantity.plus(qty)
      existing.avgCost = totalCost.div(existing.quantity)
    } else {
      this.positions.set(key, { contract, quantity: qty, avgCost: price })
    }
    this.cash = this.cash.minus(qty.mul(price))

    console.log(`DexBroker[${this.id}]: Restored position: ${tokenAddress} qty=${qty.toFixed()} avgCost=${price.toFixed()}`)
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    let unrealizedPnL = new Decimal(0)
    const aggregateInputs: Array<{ side: 'long' | 'short'; marketValue: string }> = []
    for (const pos of this.positions.values()) {
      const price = await this.markPriceFor(pos)
      const { marketValue, unrealizedPnL: pnl } = derivePositionMath({
        quantity: pos.quantity,
        marketPrice: price.toString(),
        avgCost: pos.avgCost.toString(),
        multiplier: '1',
        side: 'long',
      })
      aggregateInputs.push({ side: 'long', marketValue })
      unrealizedPnL = unrealizedPnL.plus(pnl)
    }
    const { netLiquidation } = aggregateAccountFromPositions(this.cash, aggregateInputs)

    return {
      baseCurrency: 'USD',
      netLiquidation: netLiquidation.toString(),
      totalCashValue: this.cash.toString(),
      unrealizedPnL: unrealizedPnL.toString(),
      realizedPnL: this.realizedPnL.toString(),
    }
  }

  async getPositions(): Promise<Position[]> {
    const result: Position[] = []
    for (const pos of this.positions.values()) {
      const price = await this.markPriceFor(pos)
      result.push(buildPosition({
        contract: pos.contract,
        currency: pos.contract.currency || 'USD',
        side: 'long',
        quantity: pos.quantity,
        avgCost: pos.avgCost.toString(),
        marketPrice: price.toString(),
        realizedPnL: '0',
      }))
    }
    return result
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    const results: OpenOrder[] = []
    for (const id of orderIds) {
      const order = await this.getOrder(id)
      if (order) results.push(order)
    }
    return results
  }

  async getOrder(orderId: string): Promise<OpenOrder | null> {
    const internal = this.orders.get(orderId)
    if (!internal) return null
    const orderState = new OrderState()
    orderState.status = internal.status
    return {
      contract: internal.contract,
      order: internal.order,
      orderState,
      orderId: internal.id,
      avgFillPrice: internal.avgFillPrice.toString(),
    }
  }

  /** Paper fills are synchronous — nothing is ever left pending. */
  async getOpenOrders(): Promise<OpenOrder[]> {
    return []
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const tokenAddress = contractToTokenAddress(contract)
    const pairs = await fetchDexScreenerTokenPairs(this.chain, tokenAddress)
    return this.buildQuoteFromPair(contract, tokenAddress, bestPair(pairs))
  }

  /**
   * A zero/negative/malformed price is never valid and must be rejected
   * here rather than left for callers to divide by: `cashQty.div(0)`
   * silently produces Infinity (Decimal.js doesn't throw on it), which
   * then poisons the paper ledger with NaN cash instead of failing the
   * order cleanly. `new Decimal()` itself throws on a non-numeric string,
   * hence the try/catch rather than a bare `.gt(0)` check.
   */
  private buildQuoteFromPair(contract: Contract, tokenAddress: string, pair: DexScreenerPair | null): Quote {
    let price: Decimal | null = null
    try {
      price = pair?.priceUsd ? new Decimal(pair.priceUsd) : null
    } catch {
      price = null
    }
    if (!pair || !price || !price.isFinite() || !price.gt(0)) {
      throw new BrokerError('NETWORK', `No usable DexScreener price available for ${tokenAddress} on ${this.chain}`)
    }
    // Use the validated Decimal (not the raw `pair.priceUsd` string) — it's
    // typed `string | undefined` on DexScreenerPair and TS can't carry the
    // non-null narrowing from `price` back onto that field.
    const priceStr = price.toString()
    return {
      contract,
      last: priceStr,
      bid: priceStr,
      ask: priceStr,
      volume: String(pair.volume?.h24 ?? 0),
      timestamp: new Date(),
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    return { isOpen: true }
  }

  assetClassFor(): 'crypto' {
    return 'crypto'
  }

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['CRYPTO'],
      // DEX aggregators (Jupiter/Uniswap) fill-or-fail at a slippage bound —
      // there's no broker-side resting limit/stop order to speak of.
      supportedOrderTypes: ['MKT'],
    }
  }

  // ---- Contract identity ----

  getNativeKey(contract: Contract): string {
    return contractToTokenAddress(contract)
  }

  resolveNativeKey(nativeKey: string): Contract {
    const remembered = this.contractRegistry.get(nativeKey)
    if (remembered) return remembered
    return tokenAddressToContract(nativeKey, this.chain)
  }

  // ==================== Internal ====================

  private rememberContract(contract: Contract): Contract {
    const key = this.getNativeKey(contract)
    if (!this.contractRegistry.has(key)) this.contractRegistry.set(key, contract)
    return contract
  }

  private async markPriceFor(pos: InternalPosition): Promise<Decimal> {
    try {
      const quote = await this.getQuote(pos.contract)
      return new Decimal(quote.last)
    } catch {
      // Price temporarily unavailable — fall back to avgCost (flat PnL)
      // rather than fail the whole getAccount/getPositions call.
      return pos.avgCost
    }
  }

  /** Long-only ledger — DEX swaps don't support opening a short position. */
  private applyFill(contract: Contract, side: string, qty: Decimal, price: Decimal): void {
    const key = this.getNativeKey(contract)
    this.rememberContract(contract)
    const existing = this.positions.get(key)

    if (!existing) {
      if (side === 'SELL') {
        throw new Error(`DexBroker[${this.id}]: cannot SELL ${qty.toFixed()} ${key} — no existing position`)
      }
      this.positions.set(key, { contract, quantity: qty, avgCost: price })
      return
    }

    if (side === 'BUY') {
      const totalCost = existing.avgCost.mul(existing.quantity).plus(price.mul(qty))
      existing.quantity = existing.quantity.plus(qty)
      existing.avgCost = totalCost.div(existing.quantity)
      return
    }

    const remaining = existing.quantity.minus(qty)
    if (remaining.lt(0)) {
      throw new Error(`DexBroker[${this.id}]: cannot SELL ${qty.toFixed()} ${key} — only ${existing.quantity.toFixed()} held`)
    }
    this.realizedPnL = this.realizedPnL.plus(price.minus(existing.avgCost).mul(qty))
    if (remaining.isZero()) {
      this.positions.delete(key)
    } else {
      existing.quantity = remaining
    }
  }
}
