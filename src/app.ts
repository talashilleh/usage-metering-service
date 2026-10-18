import Fastify from "fastify";
import { ZodError } from "zod";
import { accountRoutes } from "./api/accounts.js";
import { consumeRoutes } from "./api/consume.js";
import { planRoutes } from "./api/plans.js";
import { usageRoutes } from "./api/usage.js";
import { userRoutes } from "./api/users.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Request validation failed.",
        details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong." });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.register(accountRoutes);
  app.register(planRoutes);
  app.register(userRoutes);
  app.register(consumeRoutes);
  app.register(usageRoutes);

  return app;
}
