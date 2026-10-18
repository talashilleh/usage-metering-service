import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { consumeUnits } from "../services/consume.js";
import { requireApiKey } from "./auth.js";

const INT4_MAX = 2_147_483_647;

const consumeBody = z.object({
  userId: z.string().trim().min(1).max(200),
  units: z.number().int().positive().max(INT4_MAX),
  requestId: z.string().trim().min(1).max(200),
});

export async function consumeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  // A decision (accepted or rejected) is always HTTP 200; read the "accepted" field.
  // 4xx is only for bad input, unknown users, or a reused request id.
  app.post("/consume", async (req, reply) => {
    const body = consumeBody.parse(req.body);

    const result = await consumeUnits({
      accountId: req.account!.id,
      userExternalId: body.userId,
      units: body.units,
      requestId: body.requestId,
    });

    if (result.kind === "user_not_found") {
      return reply.code(404).send({ error: "user_not_found", message: "User not found in this account." });
    }
    if (result.kind === "request_id_conflict") {
      return reply.code(409).send({
        error: "request_id_reused",
        message: "This requestId was already used with a different user or units.",
      });
    }
    return result.decision;
  });
}
