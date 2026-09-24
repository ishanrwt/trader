export interface OutageEvent {
  type: "started" | "recovered";
  service: string;
}

/**
 * SPEC.md section 10: an urgent alert when a service has been unreachable for
 * more than OUTAGE_ALERT_MINUTES — one message per outage, plus one on
 * recovery.
 */
export class OutageTracker {
  private readonly downSince = new Map<string, number>();
  private readonly alerted = new Set<string>();

  constructor(private readonly outageAlertMinutes: number) {}

  /** Call after every attempt for a service. Returns an event to send, if any. */
  recordResult(service: string, success: boolean, now: number): OutageEvent | null {
    if (success) {
      const shouldAnnounceRecovery = this.alerted.has(service);
      this.downSince.delete(service);
      this.alerted.delete(service);
      return shouldAnnounceRecovery ? { type: "recovered", service } : null;
    }

    const since = this.downSince.get(service) ?? now;
    if (!this.downSince.has(service)) {
      this.downSince.set(service, since);
    }

    const minutesDown = (now - since) / 60_000;
    if (minutesDown >= this.outageAlertMinutes && !this.alerted.has(service)) {
      this.alerted.add(service);
      return { type: "started", service };
    }
    return null;
  }
}
