import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedPredefinedPlans } from "../src/db/seed.js";
import { pool } from "../src/db/index.js";

type App = ReturnType<typeof buildApp>;
let app: App;

export async function startApp() {
  await runMigrations();
  await seedPredefinedPlans();
  app = buildApp();
  app.log.level = "silent";
  await app.ready();
}

export async function stopApp() {
  await app.close();
  await pool.end();
}

export async function call(method: "GET" | "POST" | "PUT", url: string, key?: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: key ? { "x-api-key": key } : {},
    payload: body as object | undefined,
  });
  return { status: res.statusCode, body: res.json() as any };
}

let counter = 0;
export const uniq = (p: string) => `${p}-${Date.now()}-${counter++}`;

export async function newAccount(name = "Test Co") {
  const r = await call("POST", "/accounts", undefined, { name });
  return { id: r.body.id as string, key: r.body.apiKey as string };
}

export async function newUser(key: string, externalId: string, planId?: string) {
  return call("POST", "/users", key, planId ? { externalId, planId } : { externalId });
}

export async function newPlan(
  key: string,
  type: "account" | "user",
  monthlyAllowance: number,
  maxPerRequest: number,
  name = uniq("plan"),
) {
  const r = await call("POST", "/plans", key, { name, type, monthlyAllowance, maxPerRequest });
  return r.body as { id: string };
}

export async function useAccountPlan(key: string, planId: string) {
  return call("PUT", "/account/plan", key, { planId });
}

export async function consume(key: string, userId: string, units: number, requestId = uniq("req")) {
  return call("POST", "/consume", key, { userId, units, requestId });
}
