import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { isUniqueViolation } from "../db/errors.js";
import { accounts, accountUsage, plans, requests, users, userUsage } from "../db/schema.js";
import { describeViolation, evaluate, remainingUnits, type Limits, type Violation } from "../domain/rules.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function currentMonthUtc(d = new Date()): string {
  return d.toISOString().slice(0, 7); // "2026-10"
}

export type ConsumeInput = {
  accountId: string;
  userExternalId: string;
  units: number;
  requestId: string;
};

type Side = {
  plan: { id: string; name: string };
  limits: Limits;
  consumed: number;
  remaining: number;
};

export type Decision = {
  accepted: boolean;
  replayed: boolean;
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

async function readConsumed(tx: Tx, accountId: string, userId: string, month: string) {
  const [a] = await tx
    .select({ c: accountUsage.consumed })
    .from(accountUsage)
    .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.month, month)));
  const [u] = await tx
    .select({ c: userUsage.consumed })
    .from(userUsage)
    .where(and(eq(userUsage.userId, userId), eq(userUsage.month, month)));
  return { account: a?.c ?? 0, user: u?.c ?? 0 };
}

function side(plan: typeof plans.$inferSelect, consumed: number): Side {
  const limits = { monthlyAllowance: plan.monthlyAllowance, maxPerRequest: plan.maxPerRequest };
  return {
    plan: { id: plan.id, name: plan.name },
    limits,
    consumed,
    remaining: remainingUnits(limits, consumed),
  };
}

async function run(input: ConsumeInput): Promise<ConsumeResult> {
  const month = currentMonthUtc();

  return db.transaction(async (tx): Promise<ConsumeResult> => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.accountId, input.accountId), eq(users.externalId, input.userExternalId)))
      .limit(1);
    if (!user) return { kind: "user_not_found" };

    // Make sure this month's counters exist, then lock them.
    await tx.insert(accountUsage).values({ accountId: input.accountId, month }).onConflictDoNothing();
    await tx.insert(userUsage).values({ userId: user.id, month }).onConflictDoNothing();

    // Lock order is always account first, then user, so two requests can never deadlock.
    // Holding the account row also serializes all requests of one account, which is what
    // keeps the shared account total exact.
    const [accUsage] = await tx
      .select()
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, input.accountId), eq(accountUsage.month, month)))
      .for("update");
    const [usrUsage] = await tx
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, user.id), eq(userUsage.month, month)))
      .for("update");

    // Read the plans AFTER taking the locks so we use the latest committed values.
    const [acc] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
    const [accPlan] = await tx.select().from(plans).where(eq(plans.id, acc.accountPlanId));
    const [freshUser] = await tx.select().from(users).where(eq(users.id, user.id));
    const [usrPlan] = await tx.select().from(plans).where(eq(plans.id, freshUser.userPlanId));

    // Idempotency: the same request id from the same account returns the stored decision.
    const [existing] = await tx
      .select()
      .from(requests)
      .where(and(eq(requests.accountId, input.accountId), eq(requests.requestId, input.requestId)))
      .limit(1);

    if (existing) {
      if (existing.userId !== user.id || existing.units !== input.units) {
        return { kind: "request_id_conflict" };
      }
      const consumed = await readConsumed(tx, input.accountId, user.id, existing.month);
      const accSide = side(accPlan, consumed.account);
      const usrSide = side(usrPlan, consumed.user);
      const level = existing.rejectionLevel;
      const rule = existing.rejectionRule;
      const rejected = !existing.accepted && level && rule;
      return {
        kind: "decision",
        decision: {
          accepted: existing.accepted,
          replayed: true,
          requestId: existing.requestId,
          userId: input.userExternalId,
          units: existing.units,
          month: existing.month,
          rejection: rejected
            ? {
                level,
                rule,
                message: describeViolation(
                  { level, rule },
                  existing.units,
                  level === "account" ? accSide.limits : usrSide.limits,
                  level === "account" ? accSide.consumed : usrSide.consumed,
                ),
              }
            : null,
          violations: rejected ? [{ level, rule }] : [],
          account: accSide,
          user: usrSide,
        },
      };
    }

    const accSideBefore = side(accPlan, accUsage.consumed);
    const usrSideBefore = side(usrPlan, usrUsage.consumed);
    const violations = evaluate(
      input.units,
      { limits: accSideBefore.limits, consumed: accSideBefore.consumed },
      { limits: usrSideBefore.limits, consumed: usrSideBefore.consumed },
    );
    const accepted = violations.length === 0;
    const primary = violations[0];

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

    await tx.insert(requests).values({
      accountId: input.accountId,
      userId: user.id,
      requestId: input.requestId,
      units: input.units,
      month,
      accepted,
      rejectionLevel: primary?.level ?? null,
      rejectionRule: primary?.rule ?? null,
    });

    const delta = accepted ? input.units : 0;
    const accSide = side(accPlan, accUsage.consumed + delta);
    const usrSide = side(usrPlan, usrUsage.consumed + delta);

    return {
      kind: "decision",
      decision: {
        accepted,
        replayed: false,
        requestId: input.requestId,
        userId: input.userExternalId,
        units: input.units,
        month,
        rejection: primary
          ? {
              level: primary.level,
              rule: primary.rule,
              message: describeViolation(
                primary,
                input.units,
                primary.level === "account" ? accSideBefore.limits : usrSideBefore.limits,
                primary.level === "account" ? accSideBefore.consumed : usrSideBefore.consumed,
              ),
            }
          : null,
        violations,
        account: accSide,
        user: usrSide,
      },
    };
  });
}

export async function consumeUnits(input: ConsumeInput): Promise<ConsumeResult> {
  try {
    return await run(input);
  } catch (err) {
    // Rare race: two identical request ids that locked different month rows.
    // Run once more; the second pass finds the stored decision.
    if (isUniqueViolation(err)) return run(input);
    throw err;
  }
}
