// This file decides whether a request to use units is accepted or rejected.
// It reads like a recipe: each numbered step below is one simple action.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { isUniqueViolation } from "../db/errors.js";
import { accounts, accountUsage, plans, requests, users, userUsage } from "../db/schema.js";
import { describeViolation, evaluate, remainingUnits, type Violation } from "../domain/rules.js";

type Plan = typeof plans.$inferSelect;
type User = typeof users.$inferSelect;
type OldRequest = typeof requests.$inferSelect;

// The month a request belongs to, in UTC, like "2026-10".
export function currentMonthUtc(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

// What the caller sends us.
export type ConsumeInput = {
  accountId: string;
  userExternalId: string;
  units: number;
  requestId: string;
};

// A summary of one side (the account or the user): its plan, what it used, what is left.
type Side = {
  plan: { id: string; name: string };
  limits: { monthlyAllowance: number; maxPerRequest: number };
  consumed: number;
  remaining: number;
};

// What we answer.
export type Decision = {
  accepted: boolean;
  replayed: boolean; // true when this is a retry and we repeat our old answer
  requestId: string;
  userId: string;
  units: number;
  month: string;
  rejection: { level: "account" | "user"; rule: string; message: string } | null;
  violations: Violation[];
  account: Side;
  user: Side;
};

export type ConsumeResult =
  | { kind: "user_not_found" }
  | { kind: "request_id_conflict" }
  | { kind: "decision"; decision: Decision };

// ---------- small helpers ----------

function describeSide(plan: Plan, consumed: number): Side {
  return {
    plan: { id: plan.id, name: plan.name },
    limits: { monthlyAllowance: plan.monthlyAllowance, maxPerRequest: plan.maxPerRequest },
    consumed,
    remaining: remainingUnits(plan, consumed),
  };
}

// Finds the account plan and the user plan that apply right now.
async function loadPlans(accountId: string, user: User) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  const [accountPlan] = await db.select().from(plans).where(eq(plans.id, account.accountPlanId));
  const [userPlan] = await db.select().from(plans).where(eq(plans.id, user.userPlanId));
  return { accountPlan, userPlan };
}

// Reads (without locking) how much the account and the user have used in a month.
async function loadConsumed(accountId: string, userId: string, month: string) {
  const [accountRow] = await db
    .select()
    .from(accountUsage)
    .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.month, month)));
  const [userRow] = await db
    .select()
    .from(userUsage)
    .where(and(eq(userUsage.userId, userId), eq(userUsage.month, month)));
  return { accountConsumed: accountRow?.consumed ?? 0, userConsumed: userRow?.consumed ?? 0 };
}

// Puts the final answer together.
function buildDecision(a: {
  input: ConsumeInput;
  month: string;
  replayed: boolean;
  accepted: boolean;
  violations: Violation[];
  rejection: Decision["rejection"];
  accountPlan: Plan;
  userPlan: Plan;
  accountConsumed: number;
  userConsumed: number;
}): Decision {
  return {
    accepted: a.accepted,
    replayed: a.replayed,
    requestId: a.input.requestId,
    userId: a.input.userExternalId,
    units: a.input.units,
    month: a.month,
    rejection: a.rejection,
    violations: a.violations,
    account: describeSide(a.accountPlan, a.accountConsumed),
    user: describeSide(a.userPlan, a.userConsumed),
  };
}

// Builds the "why was it rejected" part from the first broken rule.
function makeRejection(
  violation: Violation,
  units: number,
  accountPlan: Plan,
  userPlan: Plan,
  accountConsumed: number,
  userConsumed: number,
): Decision["rejection"] {
  const plan = violation.level === "account" ? accountPlan : userPlan;
  const consumed = violation.level === "account" ? accountConsumed : userConsumed;
  return {
    level: violation.level,
    rule: violation.rule,
    message: describeViolation(violation, units, plan, consumed),
  };
}

// ---------- a retry: we already answered this requestId, so repeat the same answer ----------

async function repeatOldAnswer(input: ConsumeInput, user: User, old: OldRequest): Promise<ConsumeResult> {
  // The same requestId must mean the same user and the same units.
  if (old.userId !== user.id || old.units !== input.units) {
    return { kind: "request_id_conflict" };
  }

  const { accountPlan, userPlan } = await loadPlans(input.accountId, user);
  const { accountConsumed, userConsumed } = await loadConsumed(input.accountId, user.id, old.month);

  let violations: Violation[] = [];
  let rejection: Decision["rejection"] = null;
  if (!old.accepted && old.rejectionLevel && old.rejectionRule) {
    const violation: Violation = { level: old.rejectionLevel, rule: old.rejectionRule };
    violations = [violation];
    rejection = makeRejection(violation, old.units, accountPlan, userPlan, accountConsumed, userConsumed);
  }

  const decision = buildDecision({
    input,
    month: old.month,
    replayed: true,
    accepted: old.accepted,
    violations,
    rejection,
    accountPlan,
    userPlan,
    accountConsumed,
    userConsumed,
  });
  return { kind: "decision", decision };
}

// ---------- the main recipe ----------

async function tryConsume(input: ConsumeInput): Promise<ConsumeResult | "duplicate"> {
  const month = currentMonthUtc();

  // Step 1. Find the user. The user must belong to the account that is calling.
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.accountId, input.accountId), eq(users.externalId, input.userExternalId)))
    .limit(1);
  if (!user) return { kind: "user_not_found" };

  // Step 2. Is this a retry? If we already answered this requestId, repeat that answer.
  // (We do this before locking anything, so retries are fast.)
  const [old] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.accountId, input.accountId), eq(requests.requestId, input.requestId)))
    .limit(1);
  if (old) return repeatOldAnswer(input, user, old);

  // Step 3. Load the two plans (account plan and user plan).
  const { accountPlan, userPlan } = await loadPlans(input.accountId, user);

  // Step 4. Make sure this month's two counters exist (they start at zero).
  // If they already exist, nothing happens. We do this now, before locking, to keep the lock short.
  await db.insert(accountUsage).values({ accountId: input.accountId, month }).onConflictDoNothing();
  await db.insert(userUsage).values({ userId: user.id, month }).onConflictDoNothing();

  // Step 5. Everything below happens inside ONE transaction: it fully happens or not at all.
  return db.transaction(async (tx): Promise<ConsumeResult | "duplicate"> => {
    // Step 5a. Lock this month's counter of the ACCOUNT. While we hold it, no other request
    // of the same account can run, so two requests can never spend the same units.
    const [accountCounter] = await tx
      .select()
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, input.accountId), eq(accountUsage.month, month)))
      .for("update");

    // Step 5b. Lock this month's counter of the USER.
    // Always account first, then user, so two requests can never wait for each other forever.
    const [userCounter] = await tx
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, user.id), eq(userUsage.month, month)))
      .for("update");

    // Step 5c. Check again for a retry. A copy of this same request may have finished
    // while we were waiting for the lock.
    const [sameRequest] = await tx
      .select()
      .from(requests)
      .where(and(eq(requests.accountId, input.accountId), eq(requests.requestId, input.requestId)))
      .limit(1);
    if (sameRequest) return "duplicate";

    // Step 5d. Check the four rules (see rules.ts). An empty list means everything is fine.
    const violations = evaluate(
      input.units,
      { limits: accountPlan, consumed: accountCounter.consumed },
      { limits: userPlan, consumed: userCounter.consumed },
    );
    const accepted = violations.length === 0;

    // Step 5e. If accepted, add the units to the account counter and to the user counter.
    if (accepted) {
      await tx
        .update(accountUsage)
        .set({ consumed: sql`${accountUsage.consumed} + ${input.units}` })
        .where(and(eq(accountUsage.accountId, input.accountId), eq(accountUsage.month, month)));
      await tx
        .update(userUsage)
        .set({ consumed: sql`${userUsage.consumed} + ${input.units}` })
        .where(and(eq(userUsage.userId, user.id), eq(userUsage.month, month)));
    }

    // Step 5f. Always save the request in the history (accepted or rejected).
    const firstBrokenRule = violations[0];
    await tx.insert(requests).values({
      accountId: input.accountId,
      userId: user.id,
      requestId: input.requestId,
      units: input.units,
      month,
      accepted,
      rejectionLevel: firstBrokenRule ? firstBrokenRule.level : null,
      rejectionRule: firstBrokenRule ? firstBrokenRule.rule : null,
    });

    // Step 5g. Build the answer.
    const rejection = firstBrokenRule
      ? makeRejection(
          firstBrokenRule,
          input.units,
          accountPlan,
          userPlan,
          accountCounter.consumed,
          userCounter.consumed,
        )
      : null;
    const added = accepted ? input.units : 0;
    const decision = buildDecision({
      input,
      month,
      replayed: false,
      accepted,
      violations,
      rejection,
      accountPlan,
      userPlan,
      accountConsumed: accountCounter.consumed + added,
      userConsumed: userCounter.consumed + added,
    });
    return { kind: "decision", decision };
  });
}

// The function the rest of the app calls.
export async function consumeUnits(input: ConsumeInput): Promise<ConsumeResult> {
  try {
    const result = await tryConsume(input);
    if (result !== "duplicate") return result;
  } catch (err) {
    // The database refused a second copy of the same requestId. That is fine, see below.
    if (!isUniqueViolation(err)) throw err;
  }

  // Another copy of this same request finished first. Ask again:
  // this time Step 2 finds its answer and repeats it.
  const result = await tryConsume(input);
  if (result === "duplicate") throw new Error("Could not settle a duplicate request id");
  return result;
}
