import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { isUniqueViolation } from "../db/errors.js";
import { accountUsage, requests, userUsage } from "../db/schema.js";
import { describeViolation, evaluate, remainingUnits, type Limits, type Violation } from "../domain/rules.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: any[] }> };

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

type PlanLite = { id: string; name: string; monthlyAllowance: number; maxPerRequest: number };

type State = {
  userId: string;
  accPlan: PlanLite;
  usrPlan: PlanLite;
  existing: {
    userId: string;
    units: number;
    accepted: boolean;
    level: "account" | "user" | null;
    rule: "max_per_request" | "monthly_allowance" | null;
    month: string;
  } | null;
  // Consumed units for the month of the stored request (if any), else for the current month.
  accConsumed: number | null;
  usrConsumed: number | null;
};

// ONE round trip that returns everything we need to know: the user, both plans, a
// previously stored decision for this request id (if any), and the matching counters.
async function readState(
  ex: Exec,
  accountId: string,
  userExternalId: string,
  requestId: string,
  month: string,
): Promise<State | null> {
  const res = await ex.execute(sql`
    SELECT
      u.id AS user_id,
      ap.id AS ap_id, ap.name AS ap_name, ap.monthly_allowance AS ap_allow, ap.max_per_request AS ap_max,
      up.id AS up_id, up.name AS up_name, up.monthly_allowance AS up_allow, up.max_per_request AS up_max,
      r.user_id AS r_user_id, r.units AS r_units, r.accepted AS r_accepted,
      r.rejection_level AS r_level, r.rejection_rule AS r_rule, r.month AS r_month,
      (SELECT au.consumed FROM account_usage au
         WHERE au.account_id = a.id AND au.month = COALESCE(r.month, ${month}::text)) AS acc_consumed,
      (SELECT uu.consumed FROM user_usage uu
         WHERE uu.user_id = u.id AND uu.month = COALESCE(r.month, ${month}::text)) AS usr_consumed
    FROM accounts a
    JOIN plans ap ON ap.id = a.account_plan_id
    JOIN users u ON u.account_id = a.id AND u.external_id = ${userExternalId}
    JOIN plans up ON up.id = u.user_plan_id
    LEFT JOIN requests r ON r.account_id = a.id AND r.request_id = ${requestId}
    WHERE a.id = ${accountId}
  `);
  const row = res.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    accPlan: { id: row.ap_id, name: row.ap_name, monthlyAllowance: row.ap_allow, maxPerRequest: row.ap_max },
    usrPlan: { id: row.up_id, name: row.up_name, monthlyAllowance: row.up_allow, maxPerRequest: row.up_max },
    existing: row.r_user_id
      ? {
          userId: row.r_user_id,
          units: row.r_units,
          accepted: row.r_accepted,
          level: row.r_level,
          rule: row.r_rule,
          month: row.r_month,
        }
      : null,
    accConsumed: row.acc_consumed,
    usrConsumed: row.usr_consumed,
  };
}

function side(plan: PlanLite, consumed: number): Side {
  const limits = { monthlyAllowance: plan.monthlyAllowance, maxPerRequest: plan.maxPerRequest };
  return {
    plan: { id: plan.id, name: plan.name },
    limits,
    consumed,
    remaining: remainingUnits(limits, consumed),
  };
}

// A stored decision never changes, so replaying it needs no lock.
function replay(input: ConsumeInput, st: State): ConsumeResult {
  const ex = st.existing!;
  if (ex.userId !== st.userId || ex.units !== input.units) return { kind: "request_id_conflict" };

  const accSide = side(st.accPlan, st.accConsumed ?? 0);
  const usrSide = side(st.usrPlan, st.usrConsumed ?? 0);
  const level = ex.level;
  const rule = ex.rule;
  const rejected = !ex.accepted && level && rule;

  return {
    kind: "decision",
    decision: {
      accepted: ex.accepted,
      replayed: true,
      requestId: input.requestId,
      userId: input.userExternalId,
      units: ex.units,
      month: ex.month,
      rejection: rejected
        ? {
            level,
            rule,
            message: describeViolation(
              { level, rule },
              ex.units,
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

// Takes the row lock for this month's counter (creating the row the first time).
async function lockAccountUsage(tx: Tx, accountId: string, month: string): Promise<number> {
  const pick = () =>
    tx
      .select({ consumed: accountUsage.consumed })
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.month, month)))
      .for("update");
  let [row] = await pick();
  if (!row) {
    await tx.insert(accountUsage).values({ accountId, month }).onConflictDoNothing();
    [row] = await pick();
  }
  return row.consumed;
}

async function lockUserUsage(tx: Tx, userId: string, month: string): Promise<number> {
  const pick = () =>
    tx
      .select({ consumed: userUsage.consumed })
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.month, month)))
      .for("update");
  let [row] = await pick();
  if (!row) {
    await tx.insert(userUsage).values({ userId, month }).onConflictDoNothing();
    [row] = await pick();
  }
  return row.consumed;
}

async function run(input: ConsumeInput): Promise<ConsumeResult> {
  const month = currentMonthUtc();

  // Fast path, no transaction and no lock: unknown user, or a retry of a stored decision.
  const pre = await readState(db, input.accountId, input.userExternalId, input.requestId, month);
  if (!pre) return { kind: "user_not_found" };
  if (pre.existing) return replay(input, pre);

  return db.transaction(async (tx): Promise<ConsumeResult> => {
    // Lock order is always account first, then user, so two requests can never deadlock.
    // Holding the account row also serializes all requests of one account, which is what
    // keeps the shared account total exact.
    const accConsumed = await lockAccountUsage(tx, input.accountId, month);
    const usrConsumed = await lockUserUsage(tx, pre.userId, month);

    // Read plans AFTER taking the locks so we use the latest committed values, and
    // re-check the request id now that we hold the lock (two identical retries can race).
    const st = await readState(tx, input.accountId, input.userExternalId, input.requestId, month);
    if (!st) return { kind: "user_not_found" };
    if (st.existing) return replay(input, st);

    const accBefore = side(st.accPlan, accConsumed);
    const usrBefore = side(st.usrPlan, usrConsumed);
    const violations = evaluate(
      input.units,
      { limits: accBefore.limits, consumed: accBefore.consumed },
      { limits: usrBefore.limits, consumed: usrBefore.consumed },
    );
    const accepted = violations.length === 0;
    const primary = violations[0];

    if (accepted) {
      // One statement: both counters and the history row change together or not at all.
      await tx.execute(sql`
        WITH a AS (
          UPDATE account_usage SET consumed = consumed + ${input.units}
          WHERE account_id = ${input.accountId} AND month = ${month}
        ), u AS (
          UPDATE user_usage SET consumed = consumed + ${input.units}
          WHERE user_id = ${pre.userId} AND month = ${month}
        )
        INSERT INTO requests (account_id, user_id, request_id, units, month, accepted)
        VALUES (${input.accountId}, ${pre.userId}, ${input.requestId}, ${input.units}, ${month}, true)
      `);
    } else {
      await tx.insert(requests).values({
        accountId: input.accountId,
        userId: pre.userId,
        requestId: input.requestId,
        units: input.units,
        month,
        accepted: false,
        rejectionLevel: primary.level,
        rejectionRule: primary.rule,
      });
    }

    const delta = accepted ? input.units : 0;
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
                primary.level === "account" ? accBefore.limits : usrBefore.limits,
                primary.level === "account" ? accBefore.consumed : usrBefore.consumed,
              ),
            }
          : null,
        violations,
        account: side(st.accPlan, accConsumed + delta),
        user: side(st.usrPlan, usrConsumed + delta),
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
