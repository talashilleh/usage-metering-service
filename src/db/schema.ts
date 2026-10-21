import {
  pgTable, uuid, text, integer, boolean, timestamp,
  primaryKey, unique, index, check, jsonb, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  accountPlanId: uuid("account_plan_id")
    .notNull()
    .references((): AnyPgColumn => plans.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  // null = خطة جاهزة (predefined)، غير هيك الخطة بتتبع لحساب واحد
  accountId: uuid("account_id").references((): AnyPgColumn => accounts.id),
  name: text("name").notNull(),
  type: text("type", { enum: ["account", "user"] }).notNull(),
  monthlyAllowance: integer("monthly_allowance").notNull(),
  maxPerRequest: integer("max_per_request").notNull(),
  isPredefined: boolean("is_predefined").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("plans_monthly_nonnegative", sql`${t.monthlyAllowance} >= 0`),
  check("plans_max_request_positive", sql`${t.maxPerRequest} > 0`),
  check("plans_type_valid", sql`${t.type} IN ('account', 'user')`),
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    // المعرّف اللي بيستخدمه التطبيق المستدعي لهالمستخدم
    externalId: text("external_id").notNull(),
    userPlanId: uuid("user_plan_id").notNull().references(() => plans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.accountId, t.externalId)],
);

export const accountUsage = pgTable(
  "account_usage",
  {
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    month: text("month").notNull(), // مثل "2026-10" (UTC)
    consumed: integer("consumed").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.month] }),
    check("account_usage_nonnegative", sql`${t.consumed} >= 0`),
  ],
);

export const userUsage = pgTable(
  "user_usage",
  {
    userId: uuid("user_id").notNull().references(() => users.id),
    month: text("month").notNull(),
    consumed: integer("consumed").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.month] }),
    check("user_usage_nonnegative", sql`${t.consumed} >= 0`),
  ],
);

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    requestId: text("request_id").notNull(), // من الـ client، أساس الـ idempotency
    units: integer("units").notNull(),
    month: text("month").notNull(),
    accepted: boolean("accepted").notNull(),
    rejectionLevel: text("rejection_level", { enum: ["account", "user"] }),
    rejectionRule: text("rejection_rule", {
      enum: ["max_per_request", "monthly_allowance"],
    }),
    // Complete response as it was when processed; older decisions may have no snapshot.
    decisionSnapshot: jsonb("decision_snapshot").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.accountId, t.requestId),
    index("requests_account_created_idx").on(t.accountId, t.createdAt),
    check("requests_units_positive", sql`${t.units} > 0`),
  ],
);