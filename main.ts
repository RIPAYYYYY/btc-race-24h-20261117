/**
 * Trend-pullback rider for the agent-fun/bars-replay/v1 BTC race.
 *
 * Strategy in one line: ride confirmed cbBTC uptrends with most of the
 * account, get out fast when the trend breaks or the pullback bites.
 *
 * How it works, batch by batch (one batch carries one closed 1-minute
 * bar):
 *
 * - The bot keeps the close of every bar it has seen and maintains two
 *   exponential moving averages of those closes, a fast one and a slow
 *   one, plus a long simple moving average that says which way the day
 *   is leaning.
 * - Entry: while flat, it buys when the fast average sits above the
 *   slow one, the close is above the long average, and the trailing
 *   momentum over the lookback window is positive by more than the
 *   entry threshold (a round trip costs roughly 26 bps in fees,
 *   slippage and price impact, so a trade has to be chasing a real
 *   move, not noise). The buy spends a fixed fraction of equity,
 *   never everything, so a bad fill cannot sink the account.
 * - Exit: while holding, it sells everything when the fast average
 *   crosses back below the slow one (after a minimum hold, so one
 *   noisy bar cannot flip it straight back out), when the close falls
 *   more than the trailing stop below the highest close since entry,
 *   or when it falls more than the hard stop below the entry
 *   reference price. Once the gain passes the lock-arm level the
 *   trailing stop tightens, so a winning trade gives less back.
 * - After an exit it waits out a cooldown before it may enter again,
 *   and it never sends an order on a warm-up batch or when the batch
 *   carries no bar for the symbol.
 *
 * Everything is a pure function of the bars seen so far: no clock, no
 * environment, no randomness, so the two graded executions agree byte
 * for byte. Amounts are the protocol's integer quote units; every
 * order names a max_slippage_bps measured from the latest close, wide
 * enough for the modelled slippage and the order's own impact, narrow
 * enough to refuse a wild fill.
 */

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Indicator spans, in bars (one bar is one minute).
const FAST_SPAN = 12;
const SLOW_SPAN = 36;
const TREND_SPAN = 90;
// Trailing momentum lookback and the least move, in bps, worth chasing.
const MOM_LOOKBACK = 26;
const MOM_MIN_BPS = 10;
// Share of equity one entry may spend (kept under 100% on purpose).
const SIZE_NUM = 3n;
const SIZE_DEN = 4n;
// Exit geometry, in bps from the reference price.
const TRAIL_BPS = 55;
const TRAIL_TIGHT_BPS = 30;
const LOCK_ARM_BPS = 160;
const STOP_BPS = 70;
// Bars to hold before a cross back down may exit, and bars to sit out
// after any exit before a fresh entry is allowed.
const MIN_HOLD_BARS = 20;
const COOLDOWN_BARS = 10;
// Slippage budget named on every order, in bps from the latest close.
const ORDER_SLIPPAGE_BPS = 120;
// A buy must spend at least this many quote units (1 USDC); buys are
// far larger, this only guards a nearly empty account.
const MIN_BUY_QUOTE_UNITS = 1_000_000n;

/** The strategy's memory: closes, averages, and the open trade. */
class Rider {
  lastT: number | null = null;
  closes: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  prevFast: number | null = null;
  prevSlow: number | null = null;
  entryRef: number | null = null;
  peak: number | null = null;
  heldBars = 0;
  cooldown = 0;

  static emaStep(prev: number | null, value: number, span: number): number {
    if (prev === null) return value;
    const k = 2 / (span + 1);
    return value * k + prev * (1 - k);
  }

  /** Fold one new bar's close into the indicators. */
  noteBar(close: number): void {
    this.prevFast = this.emaFast;
    this.prevSlow = this.emaSlow;
    this.emaFast = Rider.emaStep(this.emaFast, close, FAST_SPAN);
    this.emaSlow = Rider.emaStep(this.emaSlow, close, SLOW_SPAN);
    this.closes.push(close);
  }

  trendAverage(): number | null {
    if (this.closes.length < TREND_SPAN) return null;
    let sum = 0;
    for (let i = this.closes.length - TREND_SPAN; i < this.closes.length; i++) sum += this.closes[i];
    return sum / TREND_SPAN;
  }

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
  if (rider.closes.length < TREND_SPAN) return [];
  const trend = rider.trendAverage();
  const mom = rider.momentumBps();
  if (trend === null || mom === null) return [];
  if (rider.emaFast === null || rider.emaSlow === null) return [];
  if (!(rider.emaFast > rider.emaSlow)) return [];
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
    rider.heldBars = 0;
  }
  rider.heldBars += 1;
  if (close > (rider.peak as number)) rider.peak = close;

  const gainBps = (close / (rider.entryRef as number) - 1) * 10_000;
  const trail = gainBps >= LOCK_ARM_BPS ? TRAIL_TIGHT_BPS : TRAIL_BPS;
  const stopHit = close * 10_000 <= (rider.entryRef as number) * (10_000 - STOP_BPS);
  const trailHit = close * 10_000 <= (rider.peak as number) * (10_000 - trail);
  const crossDown =
    rider.prevFast !== null &&
    rider.prevSlow !== null &&
    rider.emaFast !== null &&
    rider.emaSlow !== null &&
    rider.prevFast >= rider.prevSlow &&
    rider.emaFast < rider.emaSlow;
  const exitNow = stopHit || trailHit || (crossDown && rider.heldBars >= MIN_HOLD_BARS);
  if (!exitNow) return [];
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
  if (closeBig === null || rider.emaSlow === null) return [];
  const close = Number(closeBig);

  const held = state.positions.get(SYMBOL);
  if (rider.cooldown > 0) rider.cooldown -= 1;

  if (held !== undefined && held.qty > 0n) return exitOrders(state, close, held.qty);
  if (rider.entryRef !== null) {
    // The position is gone (an exit filled): start the cooldown.
    rider.entryRef = null;
    rider.peak = null;
    rider.heldBars = 0;
    rider.cooldown = COOLDOWN_BARS;
  }
  return entryOrders(state, close);
}

await runBars({ onBatch });
