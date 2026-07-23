/** Per-process budget for quota-consuming calls.
 *
 *  Not every tool costs quota: reading events, stats and config is free, while
 *  scoring and the enrichment checks each burn a row of the tenant's monthly
 *  allowance. Only the latter are counted here.
 */

export class QuotaExceededError extends Error {
  constructor(readonly used: number, readonly ceiling: number) {
    super(
      `Kaidn MCP session quota ceiling reached (${used}/${ceiling} quota-consuming calls). ` +
        `Stopping so an agent loop cannot burn the tenant's monthly plan. ` +
        `Raise KAIDN_MCP_MAX_QUOTA_CALLS deliberately if this limit is wrong.`,
    );
    this.name = "QuotaExceededError";
  }
}

export class QuotaGuard {
  private used = 0;

  constructor(private readonly ceiling: number) {}

  /** Reserve `cost` units up front, throwing rather than exceeding the ceiling. */
  spend(cost = 1): void {
    if (this.used + cost > this.ceiling) {
      throw new QuotaExceededError(this.used, this.ceiling);
    }
    this.used += cost;
  }

  get remaining(): number {
    return Math.max(0, this.ceiling - this.used);
  }

  /** Appended to every quota-consuming tool result so the agent can self-pace. */
  footer(): string {
    return `\n\n_Session quota: ${this.used}/${this.ceiling} used, ${this.remaining} remaining._`;
  }
}
