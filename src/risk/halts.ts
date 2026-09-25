import { buildDailyLossHaltMessage, buildLossStreakPauseMessage } from "../notify/urgent.js";
import type { StateStore } from "../storage/state.js";
import { formatClockInZone, tradingDayKey } from "../time.js";
import { applyTradeToLossStreak, checkEntryBlockers, perModeKey, updateDailyLossHalt, type EntryBlockerReason } from "./index.js";

/**
 * SPEC.md section 9.1: the daily-loss halt and the loss-streak pause, their
 * alerts (section 10), and PAPER_HALTS_OBSERVE_ONLY. Everything here reads and
 * writes the `state` table, never in-memory flags, so a restart neither re-sends
 * an alert already sent for the same halt nor misses one recorded before the
 * bot stopped.
 */

export type HaltName = "daily_loss" | "loss_streak";

export interface HaltConfig {
  mode: string;
  tradingDayTz: string;
  maxDailyLossUsd: number;
  consecutiveLossPause: number;
  lossPauseMinutes: number;
  /** PAPER_HALTS_OBSERVE_ONLY in paper mode: halts are computed, stored and alerted, but don't block entries. */
  observeOnly: boolean;
  /** URGENT_ALERTS: when false, alerts aren't sent (they wait for the digest), but are still recorded as handled. */
  urgentAlerts: boolean;
}

export interface HaltEffects {
  /** Fire-and-forget Telegram send (the client swallows its own errors). */
  send: (text: string) => void;
  logEvent: (type: string, message: string, meta: unknown) => void;
}

export interface StoredHalts {
  /** Trading day the daily-loss halt was recorded on, or null. */
  haltDay: string | null;
  pauseUntil: number | null;
  streak: number;
}

interface PauseStart {
  at: number;
  streak: number;
}

function keys(mode: string) {
  return {
    haltDay: perModeKey("dailyLossHaltDay", mode),
    haltTotal: perModeKey("dailyLossHaltTotalUsd", mode),
    haltAlertedDay: perModeKey("dailyLossAlertedDay", mode),
    streak: perModeKey("lossStreak", mode),
    pauseUntil: perModeKey("lossPauseUntil", mode),
    pauseStart: perModeKey("lossPauseStart", mode),
    pauseAlertedAt: perModeKey("lossPauseAlertedAt", mode),
  };
}

export function readHalts(store: StateStore, mode: string): StoredHalts {
  const k = keys(mode);
  return {
    haltDay: store.get<string | null>(k.haltDay, null),
    pauseUntil: store.get<number | null>(k.pauseUntil, null),
    streak: store.get<number>(k.streak, 0),
  };
}

/** The halts in force at `now`: the daily-loss halt only on the day it was recorded, the pause only before it ends. */
export function activeHalts(h: Pick<StoredHalts, "haltDay" | "pauseUntil">, now: number, tradingDayTz: string): HaltName[] {
  const out: HaltName[] = [];
  if (h.haltDay !== null && h.haltDay === tradingDayKey(now, tradingDayTz)) out.push("daily_loss");
  if (h.pauseUntil !== null && now < h.pauseUntil) out.push("loss_streak");
  return out;
}

/** The value stored as `would_block_at_entry` (section 11.1): which halts a live bot would have been blocked by. */
export function wouldBlockTag(halts: readonly HaltName[]): string {
  return halts.length === 0 ? "none" : [...halts].sort().join("+");
}

/**
 * Records one closed trade in the stored loss streak (section 9.1) and, when
 * this trade makes the pause go from inactive to active, stores when it
 * started and at what streak. Later losses that only extend an active pause
 * keep the original start, so they never re-alert.
 */
export function recordTradeForStreak(store: StateStore, cfg: HaltConfig, trade: { netPnlUsd: number; proceedsUnknown: boolean }, now: number): void {
  const k = keys(cfg.mode);
  const prevUntil = store.get<number | null>(k.pauseUntil, null);
  const wasActive = prevUntil !== null && now < prevUntil;
  const next = applyTradeToLossStreak(
    { consecutiveLosses: store.get<number>(k.streak, 0), pauseUntil: prevUntil },
    trade,
    now,
    { consecutiveLossPause: cfg.consecutiveLossPause, lossPauseMinutes: cfg.lossPauseMinutes },
  );
  store.set(k.streak, next.consecutiveLosses);
  store.set(k.pauseUntil, next.pauseUntil);
  const isActive = next.pauseUntil !== null && now < next.pauseUntil;
  if (!wasActive && isActive) store.set(k.pauseStart, { at: now, streak: next.consecutiveLosses } satisfies PauseStart);
}

/**
 * Recomputes the daily-loss halt from the day's realized and unrealized PnL
 * (section 9.1) and sends any alert not yet sent for a recorded halt or pause.
 * Called on every entry check, after every recorded trade, after every
 * position poll, and once at startup. Returns the stored halt state.
 */
export function evaluateHalts(
  store: StateStore,
  cfg: HaltConfig,
  inputs: { now: number; realizedNetPnlToday: number; unrealizedLossSum: number },
  fx: HaltEffects,
): StoredHalts {
  const k = keys(cfg.mode);
  const { now } = inputs;
  const today = tradingDayKey(now, cfg.tradingDayTz);

  // A halt recorded but not yet alerted (e.g. the bot stopped in between) is alerted
  // before a day rollover below can clear it.
  alertDailyLossIfNeeded(store, cfg, fx, store.get<string | null>(k.haltDay, null), today);

  const prevDay = store.get<string | null>(k.haltDay, null);
  const nextDay = updateDailyLossHalt(prevDay, inputs.realizedNetPnlToday, inputs.unrealizedLossSum, now, {
    maxDailyLossUsd: cfg.maxDailyLossUsd,
    tradingDayTz: cfg.tradingDayTz,
  });
  if (nextDay !== prevDay) {
    store.set(k.haltDay, nextDay);
    if (nextDay !== null) store.set(k.haltTotal, inputs.realizedNetPnlToday + inputs.unrealizedLossSum);
  }
  alertDailyLossIfNeeded(store, cfg, fx, nextDay, today);

  const start = store.get<PauseStart | null>(k.pauseStart, null);
  if (start !== null && store.get<number | null>(k.pauseAlertedAt, null) !== start.at) {
    const until = store.get<number | null>(k.pauseUntil, null) ?? start.at + cfg.lossPauseMinutes * 60_000;
    const text = buildLossStreakPauseMessage({
      streak: start.streak,
      untilClock: formatClockInZone(until, cfg.tradingDayTz),
      observeOnly: cfg.observeOnly,
      alreadyEnded: now >= until,
    });
    if (cfg.urgentAlerts) fx.send(text);
    fx.logEvent("loss_streak_pause", text, { mode: cfg.mode, streak: start.streak, startedAt: start.at, pauseUntil: until, observeOnly: cfg.observeOnly });
    store.set(k.pauseAlertedAt, start.at);
  }

  return readHalts(store, cfg.mode);
}

function alertDailyLossIfNeeded(store: StateStore, cfg: HaltConfig, fx: HaltEffects, haltDay: string | null, today: string): void {
  const k = keys(cfg.mode);
  if (haltDay === null || store.get<string | null>(k.haltAlertedDay, null) === haltDay) return;
  const total = store.get<number | null>(k.haltTotal, null);
  const text = buildDailyLossHaltMessage({
    dailyLossUsd: total,
    capUsd: cfg.maxDailyLossUsd,
    observeOnly: cfg.observeOnly,
    ...(haltDay !== today ? { lateForDay: haltDay } : {}),
  });
  if (cfg.urgentAlerts) fx.send(text);
  fx.logEvent("daily_loss_halt", text, { mode: cfg.mode, haltDay, dailyLossUsd: total, capUsd: cfg.maxDailyLossUsd, observeOnly: cfg.observeOnly });
  store.set(k.haltAlertedDay, haltDay);
}

/**
 * Section 9.1's entry check: re-evaluates the halts (and their alerts), then
 * applies every blocker. In observe mode the two halts don't block, but
 * because their state is stored either way, turning observe mode off enforces
 * whatever halt is already recorded on the very next check.
 */
export function entryBlockerReason(
  store: StateStore,
  cfg: HaltConfig,
  inputs: { now: number; realizedNetPnlToday: number; unrealizedLossSum: number },
  fx: HaltEffects,
  other: { killed: boolean; paused: boolean; consecutiveErrors: number; openPositionsCount: number; maxConsecutiveErrors: number; maxConcurrent: number },
): EntryBlockerReason | null {
  const h = evaluateHalts(store, cfg, inputs, fx);
  return checkEntryBlockers(
    {
      killed: other.killed,
      paused: other.paused,
      dailyLossHaltDay: h.haltDay,
      pauseUntil: h.pauseUntil,
      consecutiveErrors: other.consecutiveErrors,
      openPositionsCount: other.openPositionsCount,
    },
    inputs.now,
    { maxConsecutiveErrors: other.maxConsecutiveErrors, maxConcurrent: other.maxConcurrent, observeHalts: cfg.observeOnly },
  );
}
