import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { plans, users } from "../db/schema.js";
import { isUniqueViolation } from "../db/errors.js";
import { findAssignablePlan, getPredefinedPlan } from "../services/plans.js";
import { requireApiKey } from "./auth.js";

const createUserBody = z.object({
  externalId: z.string().trim().min(1).max(200),
  planId: z.string().uuid().optional(),
});

const changePlanBody = z.object({ planId: z.string().uuid() });

async function findUser(accountId: string, externalId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId)))
    .limit(1);
  return user;
}

async function describeUser(user: typeof users.$inferSelect) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, user.userPlanId));
  return {
    externalId: user.externalId,
    plan: {
      id: plan.id,
      name: plan.name,
      monthlyAllowance: plan.monthlyAllowance,
      maxPerRequest: plan.maxPerRequest,
    },
  };
}

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.post("/users", async (req, reply) => {
    const account = req.account!;
    const body = createUserBody.parse(req.body);

    const plan = body.planId
      ? await findAssignablePlan(account.id, body.planId, "user")
      : await getPredefinedPlan("Basic", "user");

    if (!plan) {
      return reply.code(404).send({ error: "plan_not_found", message: "No such user plan for this account." });
    }

    try {
      const [user] = await db
        .insert(users)
        .values({ accountId: account.id, externalId: body.externalId, userPlanId: plan.id })
        .returning();
      return reply.code(201).send(await describeUser(user));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: "user_exists", message: "This user already exists." });
      }
      throw err;
    }
  });

  app.get("/users/:externalId", async (req, reply) => {
    const { externalId } = req.params as { externalId: string };
    const user = await findUser(req.account!.id, externalId);
    if (!user) return reply.code(404).send({ error: "user_not_found", message: "User not found." });
    return describeUser(user);
  });

  app.put("/users/:externalId/plan", async (req, reply) => {
    const account = req.account!;
    const { externalId } = req.params as { externalId: string };
    const body = changePlanBody.parse(req.body);

    const user = await findUser(account.id, externalId);
    if (!user) return reply.code(404).send({ error: "user_not_found", message: "User not found." });

    const plan = await findAssignablePlan(account.id, body.planId, "user");
    if (!plan) {
      return reply.code(404).send({ error: "plan_not_found", message: "No such user plan for this account." });
    }

    // Changing the plan does not touch usage counters, so consumed units are preserved.
    const [updated] = await db
      .update(users)
      .set({ userPlanId: plan.id })
      .where(eq(users.id, user.id))
      .returning();
    return describeUser(updated);
  });
}
