import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { seedPredefinedPlans } from "./db/seed.js";

await runMigrations();
await seedPredefinedPlans();

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
