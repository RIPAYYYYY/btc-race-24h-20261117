/**
 * Dip buyer for the agent-fun/bars-replay/v1 BTC race.
 *
 * Strategy in one line: buy cbBTC's sharp hourly dips while the slow
 * regime is intact, sell the bounce, and cut any dip that keeps
 * falling.
 *
 * Why dips: on 1-minute bars a round trip costs roughly 26 bps in
 * fees, slippage and price impact, and this market spends most of
 * its time oscillating rather than trending — fast trend systems
 * churn themselves to death crossing their own signals. A one-hour
 * drop of 60 bps or more, on the other hand, is a real move: it
 * either snaps back (the common case in a ranging tape) or it is the
 * start of something worse, which the stops exist for.
 *
 * - The bot keeps the close of every bar, a long simple moving
 *   average (the regime line), and the trailing return over the
 *   last hour.
 * - Entry: while flat, it buys when the trailing one-hour return is
 *   at or below the dip threshold and the close is still within
 *   half a percent of the regime line — a dip inside an intact
 *   regime, not a collapse through it. The buy spends a fixed
 *   large fraction of equity.
 * - Exit: while holding, it sells everything when the gain over
 *   the entry reference reaches the take-profit level, when the
 *   close falls more than the trailing stop below the highest
 *   close since entry, or when it falls more than the hard stop
 *   below the entry reference price.
 * - After an exit it waits out a cooldown before it may enter
 *   again, and it never sends an order on a warm-up batch or when
 *   the batch carries no bar for the symbol.
 *
 * Everything is a pure function of the bars seen so far: no clock,
 * no environment, no randomness, so the two graded executions agree
 * byte for byte. Amounts are the protocol's integer quote units;
 * every order names a max_slippage_bps measured from the latest
 * close, wide enough for the modelled slippage and the order's own
 * impact, narrow enough to refuse a wild fill.
 */

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// The regime line: a simple moving average over this many bars
// (one bar is one minute). A dip counts only while the close is
// within REGIME_BAND_BPS of it.
const TREND_SPAN = 240;
const REGIME_BAND_BPS = 50;
// The dip: the trailing return over this many bars, in bps, at or
// below DIP_IN_BPS is deep enough to buy.
const DIP_LOOKBACK = 60;
const DIP_IN_BPS = -60;
// The exit: take profit at this gain over the entry reference, in
// bps; the trailing stop and hard stop bound the loss.
const GAIN_OUT_BPS = 80;
const TRAIL_BPS = 100;
const STOP_BPS = 110;
// Share of equity one entry may spend.
const SIZE_NUM = 4n;
const SIZE_DEN = 5n;
// Bars to sit out after any exit before a fresh entry is allowed.
const COOLDOWN_BARS = 30;
// Slippage budget named on every order, in bps from the latest close.
const ORDER_SLIPPAGE_BPS = 120;
// A buy must spend at least this many quote units (1 USDC); buys are
// far larger, this only guards a nearly empty account.
const MIN_BUY_QUOTE_UNITS = 1_000_000n;

/** The strategy's memory: closes and the open trade. */
class DipBuyer {
  lastT: number | null = null;
  closes: number[] = [];
  entryRef: number | null = null;
  peak: number | null = null;
  cooldown = 0;

  /** Fold one new bar's close into the history. */
  noteBar(close: number): void {
    this.closes.push(close);
  }

  /** The regime line: the mean of the last TREND_SPAN closes. */
  trendAverage(): number | null {
    if (this.closes.length < TREND_SPAN) return null;
    let sum = 0;
    for (let i = this.closes.length - TREND_SPAN; i < this.closes.length; i++) sum += this.closes[i];
    return sum / TREND_SPAN;
  }

  /** Trailing return over the dip lookback, in bps. */
  dipBps(): number | null {
    if (this.closes.length <= DIP_LOOKBACK) return null;
    const base = this.closes[this.closes.length - 1 - DIP_LOOKBACK];
    if (base <= 0) return null;
    return (this.closes[this.closes.length - 1] / base - 1) * 10_000;
  }
}

const buyer = new DipBuyer();

function entryOrders(state: BarsState, close: number): OrderInput[] {
  if (buyer.cooldown > 0) return [];
  const trend = buyer.trendAverage();
  const dip = buyer.dipBps();
  if (trend === null || dip === null) return [];
  if (dip > DIP_IN_BPS) return [];
  if (close * 10_000 < trend * (10_000 - REGIME_BAND_BPS)) return [];
  const budget = (state.equity * SIZE_NUM) / SIZE_DEN;
  let spend = state.cash < budget ? state.cash : budget;
  const room = state.weightRoom(SYMBOL);
  if (room < spend) spend = room;
  if (spend < MIN_BUY_QUOTE_UNITS) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: ORDER_SLIPPAGE_BPS }];
}

function exitOrders(state: BarsState, close: number, qty: bigint): OrderInput[] {
  if (buyer.entryRef === null || buyer.peak === null) {
    buyer.entryRef = close;
    buyer.peak = close;
  }
  if (close > (buyer.peak as number)) buyer.peak = close;

  const gainBps = (close / (buyer.entryRef as number) - 1) * 10_000;
  const stopHit = close * 10_000 <= (buyer.entryRef as number) * (10_000 - STOP_BPS);
  const trailHit = close * 10_000 <= (buyer.peak as number) * (10_000 - TRAIL_BPS);
  if (!(gainBps >= GAIN_OUT_BPS || stopHit || trailHit)) return [];
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: ORDER_SLIPPAGE_BPS }];
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar !== undefined && bar.t !== buyer.lastT) {
    buyer.lastT = bar.t;
    buyer.noteBar(Number(bar.c));
  }
  if (state.warmingUp || bar === undefined) return [];
  const closeBig = state.close(SYMBOL);
  if (closeBig === null) return [];
  const close = Number(closeBig);

  const held = state.positions.get(SYMBOL);
  if (buyer.cooldown > 0) buyer.cooldown -= 1;

  if (held !== undefined && held.qty > 0n) return exitOrders(state, close, held.qty);
  if (buyer.entryRef !== null) {
    // The position is gone (an exit filled): start the cooldown.
    buyer.entryRef = null;
    buyer.peak = null;
    buyer.cooldown = COOLDOWN_BARS;
  }
  return entryOrders(state, close);
}

await runBars({ onBatch });
