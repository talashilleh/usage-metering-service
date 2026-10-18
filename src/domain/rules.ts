export type Limits = { monthlyAllowance: number; maxPerRequest: number };
export type Level = "account" | "user";
export type Rule = "max_per_request" | "monthly_allowance";
export type Violation = { level: Level; rule: Rule };
type Side = { limits: Limits; consumed: number };

// Never negative: if the allowance was reduced below usage, remaining is 0.
export function remainingUnits(limits: Limits, consumed: number): number {
  return Math.max(0, limits.monthlyAllowance - consumed);
}

// Returns every rule the request breaks. Empty array = accepted.
// Order matters: the first item is the one reported to the caller.
export function evaluate(units: number, account: Side, user: Side): Violation[] {
  const violations: Violation[] = [];
  if (units > user.limits.maxPerRequest) violations.push({ level: "user", rule: "max_per_request" });
  if (units > account.limits.maxPerRequest) violations.push({ level: "account", rule: "max_per_request" });
  if (units > remainingUnits(user.limits, user.consumed)) violations.push({ level: "user", rule: "monthly_allowance" });
  if (units > remainingUnits(account.limits, account.consumed)) violations.push({ level: "account", rule: "monthly_allowance" });
  return violations;
}

export function describeViolation(v: Violation, units: number, limits: Limits, consumed: number): string {
  const who = v.level === "account" ? "account" : "user";
  if (v.rule === "max_per_request") {
    return `Requested ${units} units, but the ${who} plan allows at most ${limits.maxPerRequest} units per request.`;
  }
  return `Requested ${units} units, but only ${remainingUnits(limits, consumed)} units remain in the ${who} monthly allowance.`;
}
