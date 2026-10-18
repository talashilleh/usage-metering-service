import { describe, expect, it } from "vitest";
import { evaluate, remainingUnits } from "../src/domain/rules.js";

const acct = (monthlyAllowance: number, maxPerRequest: number, consumed = 0) => ({
  limits: { monthlyAllowance, maxPerRequest },
  consumed,
});

describe("rule evaluation (pure logic)", () => {
  it("accepts when every rule passes", () => {
    expect(evaluate(10, acct(10_000, 100), acct(1_000, 20))).toEqual([]);
  });

  it("rejects by the user's per-request limit (the brief's 25-unit example)", () => {
    expect(evaluate(25, acct(10_000, 100), acct(1_000, 20))).toEqual([
      { level: "user", rule: "max_per_request" },
    ]);
  });

  it("rejects by the account's per-request limit", () => {
    expect(evaluate(150, acct(10_000, 100), acct(10_000, 200))).toEqual([
      { level: "account", rule: "max_per_request" },
    ]);
  });

  it("rejects by the shared account allowance even if the user has plenty (the 5-units-left example)", () => {
    expect(evaluate(10, acct(100, 100, 95), acct(1_000, 20))).toEqual([
      { level: "account", rule: "monthly_allowance" },
    ]);
  });

  it("rejects by the user's monthly allowance", () => {
    expect(evaluate(10, acct(10_000, 100), acct(100, 20, 95))).toEqual([
      { level: "user", rule: "monthly_allowance" },
    ]);
  });

  it("reports per-request rules before monthly rules, user before account", () => {
    const v = evaluate(50, acct(10, 20, 0), acct(10, 20, 0));
    expect(v[0]).toEqual({ level: "user", rule: "max_per_request" });
    expect(v).toHaveLength(4);
  });

  it("accepts exactly the remaining amount", () => {
    expect(evaluate(5, acct(100, 100, 95), acct(1_000, 20))).toEqual([]);
  });

  it("remaining is never negative when the allowance drops below usage", () => {
    expect(remainingUnits({ monthlyAllowance: 5, maxPerRequest: 1 }, 40)).toBe(0);
    expect(evaluate(1, acct(5, 10, 40), acct(1_000, 20))).toEqual([
      { level: "account", rule: "monthly_allowance" },
    ]);
  });
});
