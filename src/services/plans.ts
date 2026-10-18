import { and, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { plans } from "../db/schema.js";

type PlanType = "account" | "user";

export async function getPredefinedPlan(name: string, type: PlanType) {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.isPredefined, true), eq(plans.type, type), eq(plans.name, name)))
    .limit(1);
  return plan;
}

// A plan must be predefined or owned by the same account, and of the right type.
export async function findAssignablePlan(accountId: string, planId: string, type: PlanType) {
  const [plan] = await db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.id, planId),
        eq(plans.type, type),
        or(eq(plans.isPredefined, true), eq(plans.accountId, accountId)),
      ),
    )
    .limit(1);
  return plan;
}
