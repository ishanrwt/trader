/**
 * SPEC.md section 16.8 (decision 5): startup refuses while positions or
 * unresolved intents of the OTHER mode exist. Paper positions are virtual and
 * a live position must never be left unmanaged. Returns the refusal message,
 * or null if it's safe to start.
 */
export function modeSwitchRefusal(
  mode: string,
  positions: ReadonlyArray<{ id: number; mode: string; mint: string; status: string }>,
  unresolvedIntents: ReadonlyArray<{ id: number; mode: string; mint: string; kind: string; status: string }>,
): string | null {
  const otherPositions = positions.filter((p) => p.mode !== mode);
  const otherIntents = unresolvedIntents.filter((i) => i.mode !== mode);
  if (otherPositions.length === 0 && otherIntents.length === 0) return null;
  const lines = [
    `Refusing to start in ${mode} mode: the database still has ${otherPositions.length} position(s) and ${otherIntents.length} unresolved transaction intent(s) from another mode.`,
    ...otherPositions.map((p) => `  position ${p.id} (${p.mode}, ${p.status}): ${p.mint}`),
    ...otherIntents.map((i) => `  intent ${i.id} (${i.mode} ${i.kind}, ${i.status}): ${i.mint}`),
    mode === "live"
      ? "Run in paper mode until those paper positions close (or use the kill switch in paper mode), then switch."
      : "Run in live mode until every live position is closed and every intent is resolved; a live position must never be left unmanaged.",
  ];
  return lines.join("\n");
}
