import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { accounts } from "../db/schema.js";
import { hashApiKey } from "../services/apiKeys.js";

declare module "fastify" {
  interface FastifyRequest {
    account?: typeof accounts.$inferSelect;
  }
}

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {
  const key = req.headers["x-api-key"];

  if (typeof key !== "string" || key.length === 0) {
    return reply
      .code(401)
      .send({ error: "missing_api_key", message: "Send your API key in the x-api-key header." });
  }

  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.apiKeyHash, hashApiKey(key)))
    .limit(1);

  if (!account) {
    return reply.code(401).send({ error: "invalid_api_key", message: "API key is not valid." });
  }

  req.account = account;
}
