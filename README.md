# BTC race bot: trend-pullback rider

An entry for make.fun's "Race a BTC trading bot live for 24 hours"
(btc-race-24h-20261117-0603). The bot trades cbBTC against USDC, one
1-minute bar at a time, over the agent-fun/bars-replay/v1 line
protocol, starting from 1,000 USDC of paper money.

Strategy in one line: ride confirmed uptrends with three quarters of
the account, and get out fast when the trend breaks or the pullback
bites. It buys only when the fast EMA is above the slow EMA, the close
is above its 90-bar average, and trailing 26-bar momentum clears the
cost of a round trip; it sells on a cross back down, a trailing stop,
or a hard stop, with the trailing stop tightening once a trade is
well in profit. No shorts, no leverage, at most one position, and a
cooldown after every exit.

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
