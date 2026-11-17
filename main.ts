/**
 * Slow-regime rider for the agent-fun/bars-replay/v1 BTC race.
 *
 * Strategy in one line: hold cbBTC only while its slow regime is up,
 * sized large, and step aside the moment the regime or the tape says
 * the move is over.
 *
 * Why slow: on 1-minute bars the noise is several bps a bar while a
 * round trip costs roughly 26 bps in fees, slippage and price impact,
 * so fast crossover systems churn themselves to death. This bot
 * trades rarely, on purpose:
 *
 * - It keeps the close of every bar and maintains a long simple
 *   moving average (the regime line) and a trailing return over a
 *   multi-hour lookback (the momentum).
 * - Entry: while flat, it buys when the close is above the regime
 *   line and the trailing momentum is positive by more than the
 *   entry threshold — the market has been rising for hours, not
 *   minutes. The buy spends a fixed large fraction of equity.
 * - Exit: while holding, it sells everything when the close falls
 *   back below the regime line, when the trailing momentum turns
 *   negative past the exit threshold, when the close falls more
 *   than the trailing stop below the highest close since entry, or
 *   when it falls more than the hard stop below the entry reference
 *   price. Once the gain passes the lock-arm level the trailing
 *   stop tightens, so a winning trade gives less back.
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
// (one bar is one minute), and the momentum lookback in bars.
const TREND_SPAN = 240;
const MOM_LOOKBACK = 120;
// The least trailing move, in bps, that counts as a rising regime
// worth entering, and the negative move that ends one.
const MOM_MIN_BPS = 15;
const MOM_EXIT_BPS = -15;
// Share of equity one entry may spend.
const SIZE_NUM = 4n;
const SIZE_DEN = 5n;
// Exit geometry, in bps from the reference price.
const TRAIL_BPS = 70;
const TRAIL_TIGHT_BPS = 35;
const LOCK_ARM_BPS = 150;
const STOP_BPS = 90;
// Bars to sit out after any exit before a fresh entry is allowed.
const COOLDOWN_BARS = 30;
// Slippage budget named on every order, in bps from the latest close.
const ORDER_SLIPPAGE_BPS = 120;
// A buy must spend at least this many quote units (1 USDC); buys are
// far larger, this only guards a nearly empty account.
const MIN_BUY_QUOTE_UNITS = 1_000_000n;

/** The strategy's memory: closes and the open trade. */
class Rider {
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

  /** Trailing return over the momentum lookback, in bps. */
  momentumBps(): number | null {
    if (this.closes.length <= MOM_LOOKBACK) return null;
    const base = this.closes[this.closes.length - 1 - MOM_LOOKBACK];
    if (base <= 0) return null;
    return (this.closes[this.closes.length - 1] / base - 1) * 10_000;
  }
}

const rider = new Rider();

function entryOrders(state: BarsState, close: number): OrderInput[] {
  if (rider.cooldown > 0) return [];
  const trend = rider.trendAverage();
  const mom = rider.momentumBps();
  if (trend === null || mom === null) return [];
  if (close <= trend) return [];
  if (mom < MOM_MIN_BPS) return [];
  const budget = (state.equity * SIZE_NUM) / SIZE_DEN;
  let spend = state.cash < budget ? state.cash : budget;
  const room = state.weightRoom(SYMBOL);
  if (room < spend) spend = room;
  if (spend < MIN_BUY_QUOTE_UNITS) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: ORDER_SLIPPAGE_BPS }];
}

function exitOrders(state: BarsState, close: number, qty: bigint): OrderInput[] {
  if (rider.entryRef === null || rider.peak === null) {
    rider.entryRef = close;
    rider.peak = close;
  }
  if (close > (rider.peak as number)) rider.peak = close;

  const trend = rider.trendAverage();
  const mom = rider.momentumBps();
  const gainBps = (close / (rider.entryRef as number) - 1) * 10_000;
  const trail = gainBps >= LOCK_ARM_BPS ? TRAIL_TIGHT_BPS : TRAIL_BPS;
  const stopHit = close * 10_000 <= (rider.entryRef as number) * (10_000 - STOP_BPS);
  const trailHit = close * 10_000 <= (rider.peak as number) * (10_000 - trail);
  const regimeOff = trend !== null && close < trend;
  const momentumOff = mom !== null && mom < MOM_EXIT_BPS;
  if (!(stopHit || trailHit || regimeOff || momentumOff)) return [];
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: ORDER_SLIPPAGE_BPS }];
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar !== undefined && bar.t !== rider.lastT) {
    rider.lastT = bar.t;
    rider.noteBar(Number(bar.c));
  }
  if (state.warmingUp || bar === undefined) return [];
  const closeBig = state.close(SYMBOL);
  if (closeBig === null) return [];
  const close = Number(closeBig);

  const held = state.positions.get(SYMBOL);
  if (rider.cooldown > 0) rider.cooldown -= 1;

  if (held !== undefined && held.qty > 0n) return exitOrders(state, close, held.qty);
  if (rider.entryRef !== null) {
    // The position is gone (an exit filled): start the cooldown.
    rider.entryRef = null;
    rider.peak = null;
    rider.cooldown = COOLDOWN_BARS;
  }
  return entryOrders(state, close);
}

await runBars({ onBatch });
