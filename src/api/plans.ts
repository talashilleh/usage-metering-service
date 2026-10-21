import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { accounts, plans } from "../db/schema.js";
import { findAssignablePlan } from "../services/plans.js";
import { requireApiKey } from "./auth.js";

const INT4_MAX = 2_147_483_647;

const createPlanBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["account", "user"]),
  monthlyAllowance: z.number().int().min(0).max(INT4_MAX),
  maxPerRequest: z.number().int().min(1).max(INT4_MAX),
});

const updatePlanBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    monthlyAllowance: z.number().int().min(0).max(INT4_MAX).optional(),
    maxPerRequest: z.number().int().min(1).max(INT4_MAX).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Send at least one field to update." });

const uuid = z.string().uuid();

export async function planRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  // Predefined plans plus this account's own plans only.
  app.get("/plans", async (req) => {
    const rows = await db
      .select()
      .from(plans)
      .where(or(eq(plans.isPredefined, true), eq(plans.accountId, req.account!.id)));
    return { plans: rows };
  });

  app.post("/plans", async (req, reply) => {
    const body = createPlanBody.parse(req.body);
    const [plan] = await db
      .insert(plans)
      .values({ ...body, accountId: req.account!.id, isPredefined: false })
      .returning();
    return reply.code(201).send(plan);
  });

  // Takes effect on the next /consume call: consume reads plans from the DB every time.
  app.put("/plans/:id", async (req, reply) => {
    const account = req.account!;
    const { id } = req.params as { id: string };
    const body = updatePlanBody.parse(req.body);

    if (!uuid.safeParse(id).success) {
      return reply.code(404).send({ error: "plan_not_found", message: "Plan not found." });
    }

    const [plan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.id, id), or(eq(plans.isPredefined, true), eq(plans.accountId, account.id))))
      .limit(1);
    if (!plan) return reply.code(404).send({ error: "plan_not_found", message: "Plan not found." });
    if (plan.isPredefined) {
      return reply.code(403).send({ error: "predefined_plan_read_only", message: "Predefined plans cannot be changed." });
    }

    // Custom plans belong to one account. Serialize edits with /consume.
    return db.transaction(async (tx) => {
      await tx.select().from(accounts).where(eq(accounts.id, account.id)).for("update");
      const [updated] = await tx.update(plans)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(plans.id, plan.id), eq(plans.accountId, account.id)))
        .returning();
      return updated;
    });
  });

  // Switch the account's own plan. Usage already consumed this month is kept.
  app.put("/account/plan", async (req, reply) => {
    const account = req.account!;
    const { planId } = z.object({ planId: uuid }).parse(req.body);

    const plan = await findAssignablePlan(account.id, planId, "account");
    if (!plan) return reply.code(404).send({ error: "plan_not_found", message: "No such account plan." });

    await db.transaction(async (tx) => {
      await tx.select().from(accounts).where(eq(accounts.id, account.id)).for("update");
      await tx.update(accounts).set({ accountPlanId: plan.id }).where(eq(accounts.id, account.id));
    });
    return {
      id: account.id,
      name: account.name,
      plan: { id: plan.id, name: plan.name, monthlyAllowance: plan.monthlyAllowance, maxPerRequest: plan.maxPerRequest },
    };
  });
}
