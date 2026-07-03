# DEX / Meme-Coin Trading Provider

> **⚠️ Read this before configuring a DEX account.**
>
> - **Paper mode is the only supported mode today.** `paper: false` refuses to
>   start (`init()` throws a `CONFIG` error) — real on-chain execution
>   (Jupiter swap submission, signed EVM router transactions) is not
>   implemented yet.
> - When real execution does ship, it will require a **dedicated wallet**,
>   separate from any wallet holding funds you care about. Meme coins are
>   extremely speculative; never trade with more than you can afford to
>   lose entirely.
> - The anti-scam check (GoPlus Security, via `TokenSecurityGuard`) is
>   **not a guarantee**. It catches common patterns (honeypots, unlocked
>   liquidity, unbounded mint authority, excessive tax) but new scam
>   patterns appear constantly — it's a filter, not a substitute for
>   judgement.

## What this provider is

`DexBroker` (`services/uta/src/domain/trading/brokers/dex/DexBroker.ts`) is an
`IBroker` implementation for on-chain meme-coin trading, one instance per
chain (`solana`, `ethereum`, `base`, `bsc`). It plugs into the same
guard pipeline, `TradingGit` commit history, and account snapshots as every
other broker (CCXT, Alpaca, IBKR, ...) — nothing about the rest of the
framework needed to change.

Token search and price data come from the public **DexScreener** API (no key
required). In paper mode, buys/sells are simulated fills at the live
DexScreener price, tracked in an in-memory position ledger.

## Configuring a DEX account (headless — no wizard yet)

There's no UI wizard step for this preset yet, so add the account directly
to `data/config/accounts.json` (or via `writeUTAsConfig()` from a script):

```json
{
  "id": "dex-solana-a1b2c3d4",
  "label": "DEX (Solana, paper)",
  "presetId": "dex",
  "enabled": true,
  "presetConfig": {
    "chain": "solana",
    "paper": true,
    "paperCashUsd": 1000
  },
  "guards": [
    {
      "type": "token-security",
      "options": {
        "rejectIfHoneypot": true,
        "rejectIfMintable": true,
        "rejectIfOwnerCanBlacklist": true,
        "rejectIfHighTax": true,
        "maxBuyTaxPercent": 10,
        "maxSellTaxPercent": 10,
        "minHolderCount": 20,
        "maxTop10HolderPercent": 70,
        "rejectIfLiquidityUnlocked": true,
        "minLiquidityUsd": 5000
      }
    }
  ]
}
```

Add one account per chain (`dex-solana`, `dex-ethereum`, `dex-base`,
`dex-bsc`) to trade multiple chains — each `DexBroker` instance is scoped to
a single chain. `minLiquidityUsd` is set per account, so tune it per chain
the same way (e.g. a higher floor on Ethereum than Solana, mirroring
typical pool depth) — there's no separate per-chain map inside the guard
config itself.

The `token-security` guard runs `checkTokenSecurity()` (GoPlus Security plus
a DexScreener liquidity floor) before every buy `placeOrder`; on any API
failure or timeout it fails safe (rejects the order) rather than assume the
token is clean. `minLiquidityUsd` is checked against the token's
best-liquidity pool on DexScreener; unset ⇒ the check is skipped entirely
(no extra network call). The threshold is inclusive — liquidity exactly
equal to `minLiquidityUsd` passes.

**`minLiquidityUsd` matters more on Solana than elsewhere** — see the
"Known limitations" section below: `rejectIfLiquidityUnlocked` is not
enforced on Solana at all, so a liquidity floor is currently the *only*
defense this guard has against a thin, easily-manipulated Solana pool.

## Retrospective / Backtest

Two read-only CLI reports answer "if the bot had been running, would its
decisions have been good?" — both reuse the exact same filter logic the
live guard runs (`checkTokenSecurity()`, `dex-contracts.ts`/`dex-market-data.ts`
helpers), so the retro view and the live view can't drift apart over time.

### `pnpm retro:today [--chain solana|ethereum|base|bsc|all] [--min-liquidity <usd>]`

Scans DexScreener's "latest token profiles" feed for tokens created in the
last 24h, runs each one through `checkTokenSecurity()` with the same
thresholds `docs/dex-provider.md`'s example config uses (`--min-liquidity`
overrides `minLiquidityUsd`), and reports each candidate's DexScreener
`priceChange` (nearest window to the token's actual age: `h1`/`h6`/`h24`) as
a proxy for "what would its return have looked like since detection."

**This is an approximation, not a simulation** — it uses DexScreener data as
observed *right now*, not the state as of the moment a live scanner would
actually have detected each token. The bot did not really run. The terminal
output and the written report both say so explicitly.

```bash
pnpm retro:today --chain solana
```

### `pnpm retro:replay --account <accountId> [--from <date>] [--to <date>]`

Once a DEX account has actually run in paper mode, this replays its real
`TradingGit` commit history (`loadGitState()` / `TradingGit.restore()` — the
same rehydration path the live UTA process uses) and reconstructs each
position's lifecycle by diffing `stateAfter.positions` across commits.
Still-open positions are marked to the current live DexScreener price
(reusing the same lookup `DexBroker.getQuote()` uses); closed positions'
exit price is derived from the **cash delta** between the commit where the
position was last present and the commit where it disappeared — not from
`OperationResult.filledPrice`, which is only populated later by a separate
`syncOrders` commit from the order-sync poller, not on the `placeOrder`
commit itself.

Reports: win rate, average return, best/worst position, and how many
positions are still open. Positions with no resolvable current price
(DexScreener has nothing for the token) are excluded from the win-rate/
average-return stats rather than silently counted as a loss.

```bash
pnpm retro:replay --account dex-solana-a1b2c3d4
```

Both commands print a terminal summary and write a markdown report to
`data/retro/{date}-today-{chain}.md` / `data/retro/{date}-replay-{accountId}.md`
so days can be compared over time.

## Known limitations

- **Real execution isn't implemented.** No private key handling, no
  transaction signing, no on-chain submission exists yet in this codebase —
  `paper: false` is refused at startup on purpose.
- **No resting orders.** DEX aggregators (Jupiter, Uniswap-style routers)
  fill-or-fail at a slippage bound; there's no broker-side limit/stop order
  to modify or cancel (`modifyOrder`/`cancelOrder` always return a failure
  explaining why).
- **GoPlus Security is not 100% reliable.** Very new tokens are sometimes
  unindexed (the guard fails safe and rejects them), and no anti-scam
  heuristic catches every scam design.
- **`rejectIfLiquidityUnlocked` does not cover Solana.** GoPlus's Solana
  schema has no usable `lp_holders` data, and its `dex[].burn_percent`
  field doesn't mean what it means on EVM — modern Solana AMMs (Raydium
  CLMM, Orca Whirlpools) manage liquidity via concentrated positions, not
  burnable LP tokens, so legitimate tokens routinely show `burn_percent`
  near 0 (verified live against BONK). Enforcing that check on Solana would
  reject good tokens without reliably catching bad ones, so it's disabled
  there — see the comment in `checkSolana()`. **A Solana token with
  genuinely unlocked liquidity (rug-pull risk) will not be flagged on this
  specific dimension.** `minLiquidityUsd` and the holder-concentration
  check are the closest remaining defenses on that chain, not a full
  replacement — no verified alternative GoPlus field or heuristic for
  Solana liquidity-lock detection exists yet.
- **MEV / front-running** is a real risk on EVM chains once real execution
  lands — not mitigated by this provider.
- **DexScreener has rate limits.** Frequent polling across many accounts
  can hit them; back off on repeated failures rather than retry tightly.
