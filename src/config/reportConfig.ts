import { envSchema } from "./schema.js";

/**
 * Only the settings the report (npm run report / /report) actually reads:
 * the go-live checklist thresholds (SPEC.md section 11.4) and
 * STUCK_WRITE_OFF_MIN (to decide if a closing position counts as "stuck"),
 * and DIGEST_INTERVAL_MINUTES (the window size for --windows / /windows).
 * Picked from the same envSchema used by the full bot config (src/config/
 * schema.ts) so the field types/defaults can never drift out of sync with
 * it — but picking excludes every required secret field, so this parses
 * successfully with no .env at all, let alone API keys. The report only
 * ever reads the local SQLite database; it never calls DexScreener, Jupiter,
 * the Solana RPC, or Telegram.
 */
const reportEnvSchema = envSchema.pick({
  TRADING_DAY_TZ: true,
  DIGEST_INTERVAL_MINUTES: true,
  STUCK_WRITE_OFF_MIN: true,
  GOLIVE_MIN_TRADES: true,
  GOLIVE_MIN_DAYS: true,
  GOLIVE_MIN_MEDIAN_PNL_PCT: true,
  GOLIVE_MIN_TOTAL_PNL_USD: true,
  GOLIVE_MIN_P10_PNL_PCT: true,
});

export type ReportConfig = ReturnType<typeof reportEnvSchema.parse>;

export class ReportConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid report configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ReportConfigError";
    this.issues = issues;
  }
}

export function loadReportConfig(envSource: Record<string, string | undefined>): ReportConfig {
  const parsed = reportEnvSchema.safeParse(envSource);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ReportConfigError(issues);
  }
  return parsed.data;
}
