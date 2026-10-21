// Example application: a tiny "document processing" app that uses the metering service.
// It holds the account API key on the server side (never in the browser) and calls the
// service on behalf of its users. The business action itself is simulated.
import http from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL ?? "http://localhost:3000";
const PORT = Number(process.env.PORT ?? 8080);
const DATA_FILE = process.env.DATA_FILE ?? path.join(here, "demo.json");
// The Docker Compose demo binds to localhost only. Set DEMO_PASSWORD if exposing it.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

function authorized(req) {
  if (!DEMO_PASSWORD) return true; // local-only default; see docker-compose.yml
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Basic ")) return false;
  const value = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const colon = value.indexOf(":");
  if (colon < 0) return false;
  const password = value.slice(colon + 1);
  const actual = Buffer.from(password);
  const expected = Buffer.from(DEMO_PASSWORD);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let apiKey = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body, key = apiKey) {
  const headers = {};
  if (key) headers["x-api-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function waitForApi() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(API + "/health");
      if (r.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(1000);
  }
  throw new Error("The metering service did not become ready in time.");
}

async function createDemoAccount() {
  const acc = await call("POST", "/accounts", { name: "Demo Document Co", planName: "Starter" }, null);
  apiKey = acc.body.apiKey;

  const plans = (await call("GET", "/plans")).body.plans;
  const basic = plans.find((p) => p.name === "Basic");
  const premium = plans.find((p) => p.name === "Premium");

  // A small custom account plan so the shared limit is easy to reach in a demo.
  const small = await call("POST", "/plans", {
    name: "Demo Small",
    type: "account",
    monthlyAllowance: 200,
    maxPerRequest: 100,
  });
  await call("PUT", "/account/plan", { planId: small.body.id });

  await call("POST", "/users", { externalId: "alice", planId: basic.id });
  await call("POST", "/users", { externalId: "bob", planId: premium.id });

  await writeFile(DATA_FILE, JSON.stringify({ apiKey }));
  console.log("Demo account created.");
}

async function bootstrap() {
  await waitForApi();
  try {
    const saved = JSON.parse(await readFile(DATA_FILE, "utf8"));
    const r = await call("GET", "/account", undefined, saved.apiKey);
    if (r.status === 200) {
      apiKey = saved.apiKey;
      console.log("Using the saved demo account.");
      return;
    }
  } catch {
    /* no saved account yet */
  }
  await createDemoAccount();
}

const ready = bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const routes = {
  "GET /api/state": async () => {
    const [account, usage, plans, history] = await Promise.all([
      call("GET", "/account"),
      call("GET", "/usage"),
      call("GET", "/plans"),
      call("GET", "/requests?pageSize=8"),
    ]);
    return {
      status: 200,
      body: {
        account: account.body,
        usage: usage.body,
        plans: plans.body.plans,
        history: history.body.items,
        apiUrl: API,
        apiKeyHint: apiKey.slice(0, 7) + "…",
      },
    };
  },

  // "Process a document": ask the service for permission first, then (simulated) do the work.
  "POST /api/process": async (b) => {
    const requestId = b.requestId || `doc-${randomUUID()}`;
    const r = await call("POST", "/consume", { userId: b.userId, units: Number(b.units), requestId });
    return { status: r.status, body: r.body };
  },

  "POST /api/user-plan": async (b) => call("PUT", `/users/${encodeURIComponent(b.userId)}/plan`, { planId: b.planId }),
  "POST /api/account-plan": async (b) => call("PUT", "/account/plan", { planId: b.planId }),
  "POST /api/create-plan": async (b) =>
    call("POST", "/plans", {
      name: b.name,
      type: b.type,
      monthlyAllowance: Number(b.monthlyAllowance),
      maxPerRequest: Number(b.maxPerRequest),
    }),
  "POST /api/edit-plan": async (b) =>
    call("PUT", `/plans/${b.planId}`, {
      monthlyAllowance: Number(b.monthlyAllowance),
      maxPerRequest: Number(b.maxPerRequest),
    }),

  "POST /api/reset": async () => {
    await rm(DATA_FILE, { force: true });
    await createDemoAccount();
    return { status: 200, body: { ok: true } };
  },
};

const server = http.createServer(async (req, res) => {
  try {
    await ready;
    const url = new URL(req.url, "http://localhost");
    if (!authorized(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Metering Demo"', "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(here, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: "not_found" });

    const body = req.method === "POST" ? await readJson(req) : {};
    const out = await handler(body);
    return send(res, out.status, out.body);
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: "client_error", message: String(err.message ?? err) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Example app on http://localhost:${PORT}`));
