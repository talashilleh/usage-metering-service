import { and, eq } from "drizzle-orm";
import { db } from "./index.js";
import { plans } from "./schema.js";

const PREDEFINED_PLANS = [
  { name: "Starter", type: "account", monthlyAllowance: 10_000, maxPerRequest: 100 },
  { name: "Pro", type: "account", monthlyAllowance: 100_000, maxPerRequest: 1_000 },
  { name: "Basic", type: "user", monthlyAllowance: 1_000, maxPerRequest: 20 },
  { name: "Premium", type: "user", monthlyAllowance: 10_000, maxPerRequest: 200 },
] as const;

export async function seedPredefinedPlans() {
  for (const plan of PREDEFINED_PLANS) {
    const existing = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.isPredefined, true), eq(plans.name, plan.name)))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(plans).values({ ...plan, isPredefined: true });
    }
  }
}
