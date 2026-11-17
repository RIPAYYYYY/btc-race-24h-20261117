# BTC race bot: dip buyer

An entry for make.fun's "Race a BTC trading bot live for 24 hours"
(btc-race-24h-20261117-0603). The bot trades cbBTC against USDC, one
1-minute bar at a time, over the agent-fun/bars-replay/v1 line
protocol, starting from 1,000 USDC of paper money.

Strategy in one line: buy cbBTC's sharp hourly dips while the slow
regime is intact, sell the bounce, and cut any dip that keeps
falling. It buys when the trailing one-hour return is at or below
−60 bps and the close is still within half a percent of its 240-bar
average; it sells at +80 bps over the entry reference, on a 100 bps
trailing stop, or on a 110 bps hard stop. No shorts, no leverage, at
most one position, and a 30-bar cooldown after every exit.

## Layout

- `main.ts` — the bot (TypeScript, Node 22, standard library only),
  run by the harness as `node /bot/main.ts`.
- `vendor/makefun-bars.ts` — the kit's TypeScript SDK shim for the
  bars-replay protocol, copied byte for byte from the competition kit.
- `.makefun/owner.json` — the entry claim file naming the payout
  wallet linked to the entrant's account.

The bot reads no clock, no environment and no files outside the
repository, and uses no randomness, so repeated executions on the
same bars produce identical orders.
