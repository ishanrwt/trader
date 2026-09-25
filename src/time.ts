/** UTC epoch milliseconds, as required by SPEC.md section 1. */
export function nowMs(): number {
  return Date.now();
}

/**
 * The calendar day (YYYY-MM-DD) that `ms` falls on in `timeZone`, used to group
 * trading-day limits and summaries per SPEC.md section 1 / TRADING_DAY_TZ.
 */
export function tradingDayKey(ms: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is what we want directly.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(ms));
}

/**
 * "21:44 IST": wall-clock HH:MM in `timeZone` plus its short name. en-US gives
 * names like EDT or UTC; where it only has a raw offset (GMT+5:30), en-IN is
 * tried for a named abbreviation (IST), else the offset is kept.
 */
export function formatClockInZone(ms: number, timeZone: string): string {
  const parts = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(ms));
  const us = parts("en-US");
  const pick = (ps: Intl.DateTimeFormatPart[], type: string) => ps.find((p) => p.type === type)?.value ?? "";
  let zone = pick(us, "timeZoneName");
  if (zone.startsWith("GMT")) {
    const alt = pick(parts("en-IN"), "timeZoneName");
    if (alt && !alt.startsWith("GMT")) zone = alt;
  }
  return `${pick(us, "hour")}:${pick(us, "minute")} ${zone}`;
}

/** True if `a` and `b` fall on the same trading day in `timeZone`. */
export function isSameTradingDay(a: number, b: number, timeZone: string): boolean {
  return tradingDayKey(a, timeZone) === tradingDayKey(b, timeZone);
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
