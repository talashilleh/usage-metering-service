import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  call, consume, newAccount, newPlan, newUser, startApp, stopApp, uniq, useAccountPlan,
} from "./helpers.js";

beforeAll(startApp);
afterAll(stopApp);
afterEach(() => vi.useRealTimers());

describe("API key validation", () => {
  it("rejects a missing key on every protected route", async () => {
    for (const [m, url] of [
      ["GET", "/account"], ["GET", "/plans"], ["GET", "/users/x"], ["GET", "/usage"], ["GET", "/requests"],
    ] as const) {
      expect((await call(m, url)).status).toBe(401);
    }
    expect((await call("POST", "/consume", undefined, { userId: "a", units: 1, requestId: "r" })).status).toBe(401);
  });

  it("rejects an invalid key", async () => {
    const r = await call("GET", "/account", "mk_not_a_real_key");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_api_key");
  });

  it("accepts a valid key and never returns the key again", async () => {
    const a = await newAccount();
    const r = await call("GET", "/account", a.key);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(a.key);
  });
});

describe("account isolation", () => {
  it("an account cannot see, use or change another account's data", async () => {
    const a = await newAccount("A");
    const b = await newAccount("B");
    await newUser(a.key, "alice");
    await newUser(b.key, "zed");
    const aPlan = await newPlan(a.key, "user", 500, 50);

    expect((await call("GET", "/users/alice", b.key)).status).toBe(404);
    expect((await consume(b.key, "alice", 1)).status).toBe(404);
    expect((await call("GET", "/users/alice/usage", b.key)).status).toBe(404);
    expect((await call("PUT", `/plans/${aPlan.id}`, b.key, { monthlyAllowance: 1 })).status).toBe(404);
    expect((await newUser(b.key, "zed2", aPlan.id)).status).toBe(404);
    expect((await call("PUT", "/users/zed/plan", b.key, { planId: aPlan.id })).status).toBe(404);

    const plansSeenByB = (await call("GET", "/plans", b.key)).body.plans.map((p: any) => p.id);
    expect(plansSeenByB).not.toContain(aPlan.id);
  });

  it("usage and history only include the caller's own users", async () => {
    const a = await newAccount();
    const b = await newAccount();
    await newUser(a.key, "alice");
    await newUser(b.key, "zed");
    await consume(a.key, "alice", 5);
    await consume(b.key, "zed", 7);

    const usageA = (await call("GET", "/usage", a.key)).body;
    expect(usageA.users.map((u: any) => u.userId)).toEqual(["alice"]);
    expect(usageA.account.consumed).toBe(5);
    const histB = (await call("GET", "/requests", b.key)).body;
    expect(histB.items.every((i: any) => i.userId === "zed")).toBe(true);
  });

  it("the same user id can exist in two accounts without mixing totals", async () => {
    const a = await newAccount();
    const b = await newAccount();
    await newUser(a.key, "shared-name");
    await newUser(b.key, "shared-name");
    await consume(a.key, "shared-name", 10);
    expect((await call("GET", "/users/shared-name/usage", b.key)).body.user.consumed).toBe(0);
  });
});

describe("consuming units", () => {
  it("accepts and adds to both the user and the account", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    const r = (await consume(a.key, "alice", 10)).body;
    expect(r.accepted).toBe(true);
    expect(r.user).toMatchObject({ consumed: 10, remaining: 990 });
    expect(r.account).toMatchObject({ consumed: 10, remaining: 9990 });
  });

  it("rejects with the user's per-request limit and consumes nothing", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    const r = (await consume(a.key, "alice", 25)).body;
    expect(r.accepted).toBe(false);
    expect(r.rejection).toMatchObject({ level: "user", rule: "max_per_request" });
    expect(r.user.consumed).toBe(0);
    expect(r.account.consumed).toBe(0);
  });

  it("rejects with the account's per-request limit", async () => {
    const a = await newAccount(); // Starter: 100 per request
    const premium = (await call("GET", "/plans", a.key)).body.plans.find((p: any) => p.name === "Premium");
    await newUser(a.key, "bob", premium.id); // 200 per request
    const r = (await consume(a.key, "bob", 150)).body;
    expect(r.rejection).toMatchObject({ level: "account", rule: "max_per_request" });
  });

  it("rejects with the user's monthly allowance", async () => {
    const a = await newAccount();
    const small = await newPlan(a.key, "user", 30, 20);
    await newUser(a.key, "alice", small.id);
    expect((await consume(a.key, "alice", 20)).body.accepted).toBe(true);
    const r = (await consume(a.key, "alice", 15)).body;
    expect(r.rejection).toMatchObject({ level: "user", rule: "monthly_allowance" });
    expect(r.user.remaining).toBe(10);
  });

  it("rejects with the SHARED account allowance while the user still has plenty", async () => {
    const a = await newAccount();
    const tiny = await newPlan(a.key, "account", 15, 100);
    await useAccountPlan(a.key, tiny.id);
    await newUser(a.key, "alice");
    await newUser(a.key, "bob");
    expect((await consume(a.key, "alice", 10)).body.accepted).toBe(true);
    const r = (await consume(a.key, "bob", 10)).body; // only 5 left on the account
    expect(r.accepted).toBe(false);
    expect(r.rejection).toMatchObject({ level: "account", rule: "monthly_allowance" });
    expect(r.user.consumed).toBe(0);
    expect(r.user.remaining).toBe(1000);
    expect((await consume(a.key, "bob", 5)).body.accepted).toBe(true);
  });

  it("users sharing one plan definition keep separate totals", async () => {
    const a = await newAccount();
    const shared = await newPlan(a.key, "user", 100, 50);
    await newUser(a.key, "u1", shared.id);
    await newUser(a.key, "u2", shared.id);
    await consume(a.key, "u1", 40);
    const r = (await consume(a.key, "u2", 10)).body;
    expect(r.user).toMatchObject({ consumed: 10, remaining: 90 });
    const usage = (await call("GET", "/usage", a.key)).body;
    expect(usage.account.consumed).toBe(50);
  });

  it("validates input", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    for (const units of [0, -3, 1.5, "10", null]) {
      const r = await call("POST", "/consume", a.key, { userId: "alice", units, requestId: uniq("v") });
      expect(r.status).toBe(400);
    }
    expect((await call("POST", "/consume", a.key, { userId: "alice", units: 1 })).status).toBe(400);
    expect((await call("POST", "/consume", a.key, { units: 1, requestId: "x" })).status).toBe(400);
    expect((await consume(a.key, "nobody", 1)).status).toBe(404);
  });
});

describe("retries (idempotency)", () => {
  it("a retried request returns the same decision and counts once", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    const first = (await consume(a.key, "alice", 10, "same-id")).body;
    const retry = (await consume(a.key, "alice", 10, "same-id")).body;
    expect(first.replayed).toBe(false);
    expect(retry).toMatchObject({ accepted: true, replayed: true });
    expect((await call("GET", "/users/alice/usage", a.key)).body.user.consumed).toBe(10);
  });

  it("a retried REJECTED request is rejected the same way", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    await consume(a.key, "alice", 25, "rej-id");
    const retry = (await consume(a.key, "alice", 25, "rej-id")).body;
    expect(retry).toMatchObject({ accepted: false, replayed: true });
    expect(retry.rejection).toMatchObject({ level: "user", rule: "max_per_request" });
  });

  it("reusing a requestId with different units or user returns 409", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    await newUser(a.key, "bob");
    await consume(a.key, "alice", 10, "dup");
    expect((await consume(a.key, "alice", 11, "dup")).status).toBe(409);
    expect((await consume(a.key, "bob", 10, "dup")).status).toBe(409);
  });

  it("two accounts can use the same requestId independently", async () => {
    const a = await newAccount();
    const b = await newAccount();
    await newUser(a.key, "u");
    await newUser(b.key, "u");
    expect((await consume(a.key, "u", 5, "shared-req")).body.replayed).toBe(false);
    expect((await consume(b.key, "u", 5, "shared-req")).body.replayed).toBe(false);
  });
});

describe("changing plans", () => {
  it("switching a user's plan keeps the units already consumed", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    await consume(a.key, "alice", 10);
    const premium = (await call("GET", "/plans", a.key)).body.plans.find((p: any) => p.name === "Premium");
    const sw = await call("PUT", "/users/alice/plan", a.key, { planId: premium.id });
    expect(sw.status).toBe(200);
    const u = (await call("GET", "/users/alice/usage", a.key)).body.user;
    expect(u).toMatchObject({ consumed: 10, remaining: 9990 });
    expect((await consume(a.key, "alice", 100)).body.accepted).toBe(true); // Premium allows 200 per request
  });

  it("editing a custom plan changes the next request without any client change", async () => {
    const a = await newAccount();
    const plan = await newPlan(a.key, "user", 100, 10);
    await newUser(a.key, "alice", plan.id);
    expect((await consume(a.key, "alice", 50)).body.accepted).toBe(false);
    await call("PUT", `/plans/${plan.id}`, a.key, { maxPerRequest: 60 });
    expect((await consume(a.key, "alice", 50)).body.accepted).toBe(true);
  });

  it("lowering the allowance below usage gives remaining 0 and rejects", async () => {
    const a = await newAccount();
    const plan = await newPlan(a.key, "user", 100, 100);
    await newUser(a.key, "alice", plan.id);
    await consume(a.key, "alice", 60);
    await call("PUT", `/plans/${plan.id}`, a.key, { monthlyAllowance: 20 });
    const r = (await consume(a.key, "alice", 1)).body;
    expect(r.accepted).toBe(false);
    expect(r.user).toMatchObject({ consumed: 60, remaining: 0 });
    // raising it again makes room again
    await call("PUT", `/plans/${plan.id}`, a.key, { monthlyAllowance: 100 });
    expect((await consume(a.key, "alice", 30)).body.accepted).toBe(true);
  });

  it("an edit to an account plan applies to the whole account", async () => {
    const a = await newAccount();
    const plan = await newPlan(a.key, "account", 10, 10);
    await useAccountPlan(a.key, plan.id);
    await newUser(a.key, "alice");
    await newUser(a.key, "bob");
    await consume(a.key, "alice", 10);
    expect((await consume(a.key, "bob", 1)).body.accepted).toBe(false);
    await call("PUT", `/plans/${plan.id}`, a.key, { monthlyAllowance: 100 });
    expect((await consume(a.key, "bob", 1)).body.accepted).toBe(true);
  });

  it("predefined plans are read-only, and plan types cannot be mixed", async () => {
    const a = await newAccount();
    const plans = (await call("GET", "/plans", a.key)).body.plans;
    const starter = plans.find((p: any) => p.name === "Starter");
    const basic = plans.find((p: any) => p.name === "Basic");
    expect((await call("PUT", `/plans/${starter.id}`, a.key, { monthlyAllowance: 1 })).status).toBe(403);
    expect((await useAccountPlan(a.key, basic.id)).status).toBe(404); // a user plan on an account
    await newUser(a.key, "alice");
    expect((await call("PUT", "/users/alice/plan", a.key, { planId: starter.id })).status).toBe(404);
  });

  it("validates plan input", async () => {
    const a = await newAccount();
    expect((await call("POST", "/plans", a.key, { name: "x", type: "user", monthlyAllowance: -1, maxPerRequest: 5 })).status).toBe(400);
    expect((await call("POST", "/plans", a.key, { name: "x", type: "user", monthlyAllowance: 10, maxPerRequest: 0 })).status).toBe(400);
    expect((await call("POST", "/plans", a.key, { name: "x", type: "other", monthlyAllowance: 10, maxPerRequest: 5 })).status).toBe(400);
  });
});

describe("usage, months and history", () => {
  it("a new UTC month starts at zero and previous months stay queryable", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-31T23:59:30Z"));
    expect((await consume(a.key, "alice", 10)).body.month).toBe("2031-01");

    vi.setSystemTime(new Date("2031-02-01T00:00:30Z"));
    const feb = (await consume(a.key, "alice", 4)).body;
    expect(feb.month).toBe("2031-02");
    expect(feb.user.consumed).toBe(4);
    expect(feb.account.consumed).toBe(4);

    const jan = (await call("GET", "/users/alice/usage?month=2031-01", a.key)).body;
    expect(jan.user.consumed).toBe(10);
    const months = (await call("GET", "/usage/months", a.key)).body.months.map((m: any) => m.month);
    expect(months).toEqual(["2031-02", "2031-01"]);
  });

  it("history is paginated, newest first, and filterable", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    await newUser(a.key, "bob");
    for (let i = 0; i < 5; i++) await consume(a.key, "alice", 1, `h${i}`);
    await consume(a.key, "bob", 25, "hb"); // rejected, still recorded

    const p1 = (await call("GET", "/requests?pageSize=4&page=1", a.key)).body;
    const p2 = (await call("GET", "/requests?pageSize=4&page=2", a.key)).body;
    expect(p1.total).toBe(6);
    expect(p1.items).toHaveLength(4);
    expect(p2.items).toHaveLength(2);
    expect(p1.items[0].requestId).toBe("hb");
    expect(p1.items[0]).toMatchObject({ accepted: false, rejectionLevel: "user", rejectionRule: "max_per_request" });

    const onlyAlice = (await call("GET", "/requests?userId=alice", a.key)).body;
    expect(onlyAlice.total).toBe(5);
  });

  it("history survives plan changes", async () => {
    const a = await newAccount();
    const plan = await newPlan(a.key, "user", 100, 100);
    await newUser(a.key, "alice", plan.id);
    await consume(a.key, "alice", 10, "before");
    await call("PUT", `/plans/${plan.id}`, a.key, { monthlyAllowance: 1 });
    const h = (await call("GET", "/requests", a.key)).body;
    expect(h.items.find((i: any) => i.requestId === "before").accepted).toBe(true);
  });

  it("validates the month format", async () => {
    const a = await newAccount();
    expect((await call("GET", "/usage?month=2026-13", a.key)).status).toBe(400);
    expect((await call("GET", "/requests?month=oct", a.key)).status).toBe(400);
  });
});

describe("concurrent requests", () => {
  it("never lets the shared account allowance be exceeded", async () => {
    const a = await newAccount();
    const cap = await newPlan(a.key, "account", 100, 10);
    await useAccountPlan(a.key, cap.id);
    const big = await newPlan(a.key, "user", 1000, 10);
    for (let i = 0; i < 20; i++) await newUser(a.key, `u${i}`, big.id);

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => consume(a.key, `u${i % 20}`, 1, `c${i}`)),
    );
    const accepted = results.filter((r) => r.body.accepted).length;
    const usage = (await call("GET", "/usage?limit=200", a.key)).body;
    const sumUsers = usage.users.reduce((s: number, u: any) => s + u.consumed, 0);

    expect(accepted).toBe(100);
    expect(usage.account.consumed).toBe(100);
    expect(sumUsers).toBe(100);
  });

  it("never lets a single user's allowance be exceeded", async () => {
    const a = await newAccount();
    const plan = await newPlan(a.key, "user", 50, 5);
    await newUser(a.key, "alice", plan.id);
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => consume(a.key, "alice", 1, `s${i}`)),
    );
    expect(results.filter((r) => r.body.accepted)).toHaveLength(50);
    expect((await call("GET", "/users/alice/usage", a.key)).body.user.consumed).toBe(50);
  });

  it("the same requestId sent 30 times in parallel counts once", async () => {
    const a = await newAccount();
    await newUser(a.key, "alice");
    const results = await Promise.all(
      Array.from({ length: 30 }, () => consume(a.key, "alice", 5, "parallel-dup")),
    );
    expect(results.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect((await call("GET", "/users/alice/usage", a.key)).body.user.consumed).toBe(5);
  });

  it("a plan edit during traffic never corrupts totals", async () => {
    const a = await newAccount();
    const plan = await newPlan(a.key, "user", 100, 5);
    await newUser(a.key, "alice", plan.id);
    const traffic = Array.from({ length: 60 }, (_, i) => consume(a.key, "alice", 1, `e${i}`));
    const edit = call("PUT", `/plans/${plan.id}`, a.key, { monthlyAllowance: 30 });
    const results = await Promise.all([...traffic, edit]);
    const u = (await call("GET", "/users/alice/usage", a.key)).body.user;
    const accepted = results.slice(0, 60).filter((r: any) => r.body.accepted).length;
    expect(u.consumed).toBe(accepted); // counter always equals what was accepted
    expect(u.consumed).toBeLessThanOrEqual(60);
    expect(u.remaining).toBeGreaterThanOrEqual(0);
  });
});

describe("hardening regressions", () => {
  it("replays the ORIGINAL decision even after usage and plans change", async () => {
    const a = await newAccount();
    const p = await newPlan(a.key, "user", 100, 50);
    await newUser(a.key, "alice", p.id);

    const first = (await consume(a.key, "alice", 5, "original-snapshot")).body;
    expect(first).toMatchObject({ accepted: true, replayed: false });
    await consume(a.key, "alice", 8, "another-request");
    await call("PUT", `/plans/${p.id}`, a.key, { monthlyAllowance: 13, maxPerRequest: 1 });

    const replay = (await consume(a.key, "alice", 5, "original-snapshot")).body;
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await call("GET", "/users/alice/usage", a.key)).body.user.consumed).toBe(13);
  });

  it("replays every violation of a rejected decision, not just its first reason", async () => {
    const a = await newAccount();
    const p = await newPlan(a.key, "user", 2, 1);
    await newUser(a.key, "alice", p.id);
    const first = (await consume(a.key, "alice", 10, "rejected-snapshot")).body;
    expect(first.accepted).toBe(false);
    expect(first.violations.length).toBeGreaterThan(1);

    await call("PUT", `/plans/${p.id}`, a.key, { monthlyAllowance: 100, maxPerRequest: 100 });
    const replay = (await consume(a.key, "alice", 10, "rejected-snapshot")).body;
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await call("GET", "/users/alice/usage", a.key)).body.user.consumed).toBe(0);
  });

  it("uses the new limit for all requests arriving after a plan edit commits", async () => {
    const a = await newAccount();
    const p = await newPlan(a.key, "user", 500, 50);
    await newUser(a.key, "alice", p.id);

    // Begin traffic before the edit; those requests may legitimately use old limits.
    const earlier = Array.from({ length: 25 }, (_, i) => consume(a.key, "alice", 1, `old-${i}`));
    expect((await call("PUT", `/plans/${p.id}`, a.key, { monthlyAllowance: 0 })).status).toBe(200);

    // These requests begin only AFTER the update response: all must see zero.
    const later = await Promise.all(
      Array.from({ length: 20 }, (_, i) => consume(a.key, "alice", 1, `new-${i}`)),
    );
    await Promise.all(earlier);
    expect(later.every((r) => r.status === 200 && r.body.accepted === false)).toBe(true);
    expect(later.every((r) => r.body.user.limits.monthlyAllowance === 0)).toBe(true);
  });
});
