import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://metering:metering@localhost:5433/metering";

export const pool = new pg.Pool({ connectionString });
export const db = drizzle({ client: pool, schema });