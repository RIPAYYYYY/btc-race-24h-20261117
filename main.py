"""Trend-pullback rider for the agent-fun/bars-replay/v1 BTC race.

Strategy in one line: ride confirmed cbBTC uptrends with most of the
account, get out fast when the trend breaks or the pullback bites.

How it works, batch by batch (one batch carries one closed 1-minute bar):

- The bot keeps the close of every bar it has seen and maintains two
  exponential moving averages of those closes, a fast one and a slow
  one, plus a long simple moving average that says which way the day
  is leaning.
- Entry: while flat, it buys when the fast average sits above the slow
  one, the close is above the long average, and the trailing momentum
  over the lookback window is positive by more than the entry
  threshold (a round trip costs roughly 26 bps in fees, slippage and
  price impact, so a trade has to be chasing a real move, not noise).
  The buy spends a fixed fraction of equity, never everything, so a
  bad fill cannot sink the account.
- Exit: while holding, it sells everything when the fast average
  crosses back below the slow one (after a minimum hold, so one noisy
  bar cannot flip it straight back out), when the close falls more
  than the trailing stop below the highest close since entry, or when
  it falls more than the hard stop below the entry reference price.
  Once the gain passes the lock-arm level the trailing stop tightens,
  so a winning trade gives less back.
- After an exit it waits out a cooldown before it may enter again,
  and it never sends an order on a warm-up batch or when the batch
  carries no bar for the symbol.

Everything is a pure function of the bars seen so far: no clock, no
environment, no randomness, so the two graded executions agree byte
for byte. Amounts are integers of the protocol's quote units; every
order names a max_slippage_bps measured from the latest close, wide
enough for the modelled slippage and the order's own impact, narrow
enough to refuse a wild fill.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bars

SYMBOL = "CBBTC"

# Indicator spans, in bars (one bar is one minute).
FAST_SPAN = 12
SLOW_SPAN = 36
TREND_SPAN = 90
# Trailing momentum lookback and the least move, in bps, worth chasing.
MOM_LOOKBACK = 26
MOM_MIN_BPS = 10
# Share of equity one entry may spend (kept under 100% on purpose).
SIZE_NUM = 3
SIZE_DEN = 4
# Exit geometry, in bps from the reference price.
TRAIL_BPS = 55
TRAIL_TIGHT_BPS = 30
LOCK_ARM_BPS = 160
STOP_BPS = 70
# Bars to hold before a cross back down may exit, and bars to sit out
# after any exit before a fresh entry is allowed.
MIN_HOLD_BARS = 20
COOLDOWN_BARS = 10
# Slippage budget named on every order, in bps from the latest close.
ORDER_SLIPPAGE_BPS = 120
# A buy must spend at least this many quote units (1 USDC); buys are
# far larger, this only guards a nearly empty account.
MIN_BUY_QUOTE_UNITS = 1_000_000


class Rider:
    """The strategy's memory: closes, averages, and the open trade."""

    def __init__(self):
        self.last_t = None
        self.closes = []
        self.ema_fast = None
        self.ema_slow = None
        self.prev_fast = None
        self.prev_slow = None
        self.entry_ref = None
        self.peak = None
        self.held_bars = 0
        self.cooldown = 0

    @staticmethod
    def _ema_step(prev, value, span):
        if prev is None:
            return float(value)
        k = 2.0 / (span + 1)
        return value * k + prev * (1.0 - k)

    def note_bar(self, close):
        """Fold one new bar's close into the indicators."""
        self.prev_fast = self.ema_fast
        self.prev_slow = self.ema_slow
        self.ema_fast = self._ema_step(self.ema_fast, close, FAST_SPAN)
        self.ema_slow = self._ema_step(self.ema_slow, close, SLOW_SPAN)
        self.closes.append(close)

    def trend_average(self):
        if len(self.closes) < TREND_SPAN:
            return None
        return sum(self.closes[-TREND_SPAN:]) / TREND_SPAN

    def momentum_bps(self):
        if len(self.closes) <= MOM_LOOKBACK:
            return None
        base = self.closes[-1 - MOM_LOOKBACK]
        if base <= 0:
            return None
        return (self.closes[-1] / base - 1.0) * 10_000.0


RIDER = Rider()


def _bar_for(batch):
    for bar in batch["bars"]:
        if bar["symbol"] == SYMBOL:
            return bar
    return None


def on_batch(state, batch):
    bar = _bar_for(batch)
    if bar is not None and bar["t"] != RIDER.last_t:
        RIDER.last_t = bar["t"]
        RIDER.note_bar(int(bar["c"]))
    if state.warming_up or bar is None:
        return []
    close = state.close(SYMBOL)
    if close is None or RIDER.ema_slow is None:
        return []

    held = state.positions.get(SYMBOL)
    if RIDER.cooldown > 0:
        RIDER.cooldown -= 1

    if held is not None and held.qty > 0:
        return _exit_orders(state, close, held)
    if RIDER.entry_ref is not None:
        # The position is gone (an exit filled): start the cooldown.
        RIDER.entry_ref = None
        RIDER.peak = None
        RIDER.held_bars = 0
        RIDER.cooldown = COOLDOWN_BARS
    return _entry_orders(state, close)


def _entry_orders(state, close):
    if RIDER.cooldown > 0:
        return []
    if len(RIDER.closes) < TREND_SPAN:
        return []
    trend = RIDER.trend_average()
    mom = RIDER.momentum_bps()
    if trend is None or mom is None:
        return []
    if not (RIDER.ema_fast > RIDER.ema_slow):
        return []
    if close <= trend:
        return []
    if mom < MOM_MIN_BPS:
        return []
    budget = state.equity * SIZE_NUM // SIZE_DEN
    spend = min(state.cash, budget, state.weight_room(SYMBOL))
    if spend < MIN_BUY_QUOTE_UNITS:
        return []
    return [
        {
            "side": "buy",
            "symbol": SYMBOL,
            "notional_quote_units": spend,
            "max_slippage_bps": ORDER_SLIPPAGE_BPS,
        }
    ]


def _exit_orders(state, close, held):
    if RIDER.entry_ref is None:
        RIDER.entry_ref = close
        RIDER.peak = close
        RIDER.held_bars = 0
    RIDER.held_bars += 1
    if close > RIDER.peak:
        RIDER.peak = close

    gain_bps = (close / RIDER.entry_ref - 1.0) * 10_000.0
    trail = TRAIL_TIGHT_BPS if gain_bps >= LOCK_ARM_BPS else TRAIL_BPS
    stop_hit = close * 10_000 <= RIDER.entry_ref * (10_000 - STOP_BPS)
    trail_hit = close * 10_000 <= RIDER.peak * (10_000 - trail)
    cross_down = (
        RIDER.prev_fast is not None
        and RIDER.prev_slow is not None
        and RIDER.prev_fast >= RIDER.prev_slow
        and RIDER.ema_fast < RIDER.ema_slow
    )
    exit_now = stop_hit or trail_hit or (cross_down and RIDER.held_bars >= MIN_HOLD_BARS)
    if not exit_now:
        return []
    return [
        {
            "side": "sell",
            "symbol": SYMBOL,
            "qty": held.qty,
            "max_slippage_bps": ORDER_SLIPPAGE_BPS,
        }
    ]


if __name__ == "__main__":
    makefun_bars.run(on_batch)
