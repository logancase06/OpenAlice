/**
 * Contract resolution helpers for the DEX broker.
 *
 * Pure functions, no dependency on DexBroker instance state — same pattern
 * as `ccxt-contracts.ts`. aliceId itself is stamped by UnifiedTradingAccount
 * (`{utaId}|{nativeKey}`), not here; one DexBroker instance already scopes
 * to a single chain, so the broker-native key is just the token contract
 * address on that chain (mirrors CCXT's unified symbol / Alpaca's ticker).
 */

import { Contract } from '@traderalice/ibkr'
import '../../contract-ext.js'
import { buildContract } from '../contract-builder.js'
import type { DexScreenerPair } from './dex-market-data.js'

/** Convert a DexScreener pair into an IBKR Contract for the given chain. */
export function pairToContract(pair: DexScreenerPair, chain: string): Contract {
  return buildContract({
    symbol: pair.baseToken.symbol,
    secType: 'CRYPTO',
    exchange: chain,
    currency: pair.quoteToken?.symbol || 'USD',
    localSymbol: pair.baseToken.address,
    description: `${pair.baseToken.name} (${pair.baseToken.symbol}) on ${chain}`,
  })
}

/**
 * Reconstruct a minimal tradeable Contract from a bare token address —
 * used by `resolveNativeKey` when no richer DexScreener data is cached
 * for this token (e.g. after process restart, before the next scan).
 */
export function tokenAddressToContract(tokenAddress: string, chain: string, symbolHint?: string): Contract {
  return buildContract({
    symbol: symbolHint || tokenAddress,
    secType: 'CRYPTO',
    exchange: chain,
    currency: 'USD',
    localSymbol: tokenAddress,
  })
}

/** Broker-native key for a Contract — the token's contract address. */
export function contractToTokenAddress(contract: Contract): string {
  return contract.localSymbol || contract.symbol
}
