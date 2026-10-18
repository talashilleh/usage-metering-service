import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://metering:metering@localhost:5433/metering";

// Each in-flight /consume transaction needs its own connection, so the pool size caps
// how many accounts can be processed in parallel. Postgres allows 100 by default.
export const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX ?? 20),
});
export const db = drizzle({ client: pool, schema });
