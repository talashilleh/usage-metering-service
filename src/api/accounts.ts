import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { accounts, plans } from "../db/schema.js";
import { generateApiKey, hashApiKey } from "../services/apiKeys.js";
import { getPredefinedPlan } from "../services/plans.js";
import { requireApiKey } from "./auth.js";

const createAccountBody = z.object({
  name: z.string().trim().min(1).max(100),
  planName: z.enum(["Starter", "Pro"]).default("Starter"),
});

export async function accountRoutes(app: FastifyInstance) {
  // Open endpoint (no key needed) because it is the one that issues the key.
  app.post("/accounts", async (req, reply) => {
    const body = createAccountBody.parse(req.body);

    const plan = await getPredefinedPlan(body.planName, "account");
    if (!plan) {
      return reply.code(500).send({ error: "plans_not_seeded", message: "Predefined plans are missing." });
    }

    const apiKey = generateApiKey();
    const [account] = await db
      .insert(accounts)
      .values({ name: body.name, apiKeyHash: hashApiKey(apiKey), accountPlanId: plan.id })
      .returning();

    return reply.code(201).send({
      id: account.id,
      name: account.name,
      plan: { id: plan.id, name: plan.name },
      apiKey,
      note: "Store this key now. It cannot be shown again.",
    });
  });

  app.get("/account", { preHandler: requireApiKey }, async (req) => {
    const account = req.account!;
    const [plan] = await db.select().from(plans).where(eq(plans.id, account.accountPlanId));
    return {
      id: account.id,
      name: account.name,
      plan: {
        id: plan.id,
        name: plan.name,
        monthlyAllowance: plan.monthlyAllowance,
        maxPerRequest: plan.maxPerRequest,
      },
    };
  });
}
