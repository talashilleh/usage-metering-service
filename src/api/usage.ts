import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { accountUsage, accounts, plans, requests, users, userUsage } from "../db/schema.js";
import { remainingUnits } from "../domain/rules.js";
import { currentMonthUtc } from "../services/consume.js";
import { requireApiKey } from "./auth.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM");

const usageQuery = z.object({
  month: month.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const historyQuery = z.object({
  month: month.optional(),
  userId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function sideOf(plan: { id: string; name: string; monthlyAllowance: number; maxPerRequest: number }, consumed: number) {
  return {
    plan: { id: plan.id, name: plan.name },
    limits: { monthlyAllowance: plan.monthlyAllowance, maxPerRequest: plan.maxPerRequest },
    consumed,
    remaining: remainingUnits(plan, consumed),
  };
}

export async function usageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  // Account totals plus every user's usage for a month (default: current UTC month).
  app.get("/usage", async (req) => {
    const account = req.account!;
    const q = usageQuery.parse(req.query);
    const m = q.month ?? currentMonthUtc();

    const [accPlan] = await db.select().from(plans).where(eq(plans.id, account.accountPlanId));
    const [accRow] = await db
      .select({ c: accountUsage.consumed })
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, account.id), eq(accountUsage.month, m)));

    const rows = await db
      .select({
        externalId: users.externalId,
        planId: plans.id,
        planName: plans.name,
        monthlyAllowance: plans.monthlyAllowance,
        maxPerRequest: plans.maxPerRequest,
        consumed: userUsage.consumed,
      })
      .from(users)
      .innerJoin(plans, eq(plans.id, users.userPlanId))
      .leftJoin(userUsage, and(eq(userUsage.userId, users.id), eq(userUsage.month, m)))
      .where(eq(users.accountId, account.id))
      .orderBy(users.externalId)
      .limit(q.limit)
      .offset(q.offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(users)
      .where(eq(users.accountId, account.id));

    return {
      month: m,
      account: sideOf(accPlan, accRow?.c ?? 0),
      users: rows.map((r) => ({
        userId: r.externalId,
        ...sideOf(
          { id: r.planId, name: r.planName, monthlyAllowance: r.monthlyAllowance, maxPerRequest: r.maxPerRequest },
          r.consumed ?? 0,
        ),
      })),
      usersTotal: total,
    };
  });

  // Which months have usage (for browsing previous months).
  app.get("/usage/months", async (req) => {
    const rows = await db
      .select({ month: accountUsage.month, consumed: accountUsage.consumed })
      .from(accountUsage)
      .where(eq(accountUsage.accountId, req.account!.id))
      .orderBy(desc(accountUsage.month));
    return { months: rows };
  });

  app.get("/users/:externalId/usage", async (req, reply) => {
    const account = req.account!;
    const { externalId } = req.params as { externalId: string };
    const q = z.object({ month: month.optional() }).parse(req.query);
    const m = q.month ?? currentMonthUtc();

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.accountId, account.id), eq(users.externalId, externalId)))
      .limit(1);
    if (!user) return reply.code(404).send({ error: "user_not_found", message: "User not found." });

    const [uPlan] = await db.select().from(plans).where(eq(plans.id, user.userPlanId));
    const [aPlan] = await db.select().from(plans).where(eq(plans.id, account.accountPlanId));
    const [uRow] = await db
      .select({ c: userUsage.consumed })
      .from(userUsage)
      .where(and(eq(userUsage.userId, user.id), eq(userUsage.month, m)));
    const [aRow] = await db
      .select({ c: accountUsage.consumed })
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, account.id), eq(accountUsage.month, m)));

    return { month: m, userId: externalId, user: sideOf(uPlan, uRow?.c ?? 0), account: sideOf(aPlan, aRow?.c ?? 0) };
  });

  // Request history, newest first, simple page/pageSize pagination.
  app.get("/requests", async (req) => {
    const account = req.account!;
    const q = historyQuery.parse(req.query);

    const conditions = [eq(requests.accountId, account.id)];
    if (q.month) conditions.push(eq(requests.month, q.month));
    if (q.userId) conditions.push(eq(users.externalId, q.userId));
    const where = and(...conditions);

    const items = await db
      .select({
        requestId: requests.requestId,
        userId: users.externalId,
        units: requests.units,
        month: requests.month,
        accepted: requests.accepted,
        rejectionLevel: requests.rejectionLevel,
        rejectionRule: requests.rejectionRule,
        createdAt: requests.createdAt,
      })
      .from(requests)
      .innerJoin(users, eq(users.id, requests.userId))
      .where(where)
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);

    const [{ total }] = await db
      .select({ total: count() })
      .from(requests)
      .innerJoin(users, eq(users.id, requests.userId))
      .where(where);

    return { page: q.page, pageSize: q.pageSize, total, items };
  });
}
