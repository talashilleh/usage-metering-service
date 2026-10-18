// Load test for the usage metering service.
// Usage:  node load-tests/run.mjs <label>        (example: baseline, optimized)
// Needs the service running (docker compose up -d --build) and `npm i -D autocannon`.
// Writes load-tests/results-<label>.md so the evidence can be committed.
import autocannon from "autocannon";
import os from "node:os";
import { writeFile } from "node:fs/promises";

const API = process.env.API_URL ?? "http://localhost:3000";
const label = process.argv[2] ?? "run";
const DURATION = Number(process.env.DURATION ?? 10); // seconds per scenario
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50); // parallel clients
const BIG = 2_000_000_000;

async function api(method, path, key, body) {
  const headers = {};
  if (key) headers["x-api-key"] = key;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

async function makeAccount({ accountAllowance, users }) {
  const acc = (await api("POST", "/accounts", null, { name: "load" })).body;
  const key = acc.apiKey;
  const accPlan = (await api("POST", "/plans", key, {
    name: "load-account", type: "account", monthlyAllowance: accountAllowance, maxPerRequest: 10,
  })).body;
  await api("PUT", "/account/plan", key, { planId: accPlan.id });
  const userPlan = (await api("POST", "/plans", key, {
    name: "load-user", type: "user", monthlyAllowance: BIG, maxPerRequest: 10,
  })).body;
  const ids = [];
  for (let i = 0; i < users; i++) {
    const id = `u${i}`;
    await api("POST", "/users", key, { externalId: id, planId: userPlan.id });
    ids.push(id);
  }
  return { key, users: ids, accountAllowance };
}

function consumeRequests(targets, mode = "unique") {
  let n = 0;
  const runId = Date.now().toString(36);
  return [
    {
      method: "POST",
      path: "/consume",
      setupRequest(req) {
        const t = targets[Math.floor(Math.random() * targets.length)];
        const ui = Math.floor(Math.random() * t.users.length);
        const requestId = mode === "replay" ? `fixed-${ui}` : `${runId}-${n++}`;
        req.headers = { "content-type": "application/json", "x-api-key": t.key };
        req.body = JSON.stringify({ userId: t.users[ui], units: 1, requestId });
        return req;
      },
    },
  ];
}

async function check(targets) {
  await new Promise((r) => setTimeout(r, 1000)); // let in-flight requests finish
  const rows = [];
  for (const t of targets) {
    const u = (await api("GET", "/usage?limit=200", t.key)).body;
    const sumUsers = u.users.reduce((s, x) => s + x.consumed, 0);
    rows.push({ account: u.account.consumed, sumUsers, allowance: t.accountAllowance });
  }
  return rows;
}

const scenarios = [
  {
    name: "A. One account, 50 users, everything accepted",
    note: "All requests share one account row, so they are serialized by its lock.",
    setup: async () => [await makeAccount({ accountAllowance: BIG, users: 50 })],
    verify: (rows) => [
      ["account total equals the sum of its users", rows.every((r) => r.account === r.sumUsers)],
      ["account never above its allowance", rows.every((r) => r.account <= r.allowance)],
    ],
  },
  {
    name: "B. 20 accounts x 5 users, everything accepted",
    note: "Different accounts do not lock each other, so work can run in parallel.",
    setup: async () => Promise.all(Array.from({ length: 20 }, () => makeAccount({ accountAllowance: BIG, users: 5 }))),
    verify: (rows) => [
      ["every account total equals the sum of its users", rows.every((r) => r.account === r.sumUsers)],
      ["no account above its allowance", rows.every((r) => r.account <= r.allowance)],
    ],
  },
  {
    name: "C. One account capped at 1000 units, most requests rejected",
    note: "Correctness under pressure: no more than 1000 units may ever be accepted.",
    setup: async () => [await makeAccount({ accountAllowance: 1000, users: 50 })],
    verify: (rows, result) => [
      ["never more than 1000 units accepted", rows.every((r) => r.account <= 1000)],
      [
        result["2xx"] >= 1000 + CONNECTIONS
          ? "cap was reached: exactly 1000 units accepted"
          : "cap not reached on this machine (too few requests), so only the upper bound was checked",
        result["2xx"] >= 1000 + CONNECTIONS ? rows.every((r) => r.account === 1000) : true,
      ],
      ["account total equals the sum of its users", rows.every((r) => r.account === r.sumUsers)],
    ],
  },
  {
    name: "D. Retries: the same requestIds again and again",
    note: "Replayed decisions: nothing may be counted twice.",
    setup: async () => {
      const t = await makeAccount({ accountAllowance: BIG, users: 50 });
      for (const u of t.users.map((_, i) => i)) {
        await api("POST", "/consume", t.key, { userId: `u${u}`, units: 1, requestId: `fixed-${u}` });
      }
      return [t];
    },
    mode: "replay",
    verify: (rows) => [
      ["each of the 50 request ids counted exactly once (total = 50)", rows.every((r) => r.account === 50 && r.sumUsers === 50)],
    ],
  },
];

async function main() {
  try {
    const h = await fetch(API + "/health");
    if (!h.ok) throw new Error("not ok");
  } catch {
    console.error(`Cannot reach the service at ${API}. Start it first: docker compose up -d --build`);
    process.exit(1);
  }

  const cpu = os.cpus();
  const lines = [];
  const log = (s = "") => { console.log(s); lines.push(s); };

  log(`# Load test results: ${label}`);
  log();
  log(`- Date: ${new Date().toISOString()}`);
  log(`- Machine: ${cpu[0].model.trim()} (${cpu.length} logical CPUs), ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM, ${os.platform()} ${os.release()}`);
  log(`- Node: ${process.version}, tool: autocannon, target: ${API}`);
  log(`- Per scenario: ${CONNECTIONS} parallel connections for ${DURATION} seconds, 1 unit per request`);
  log(`- The service and Postgres run in Docker on the same machine as the load generator, so absolute numbers are conservative.`);
  log();
  log("| Scenario | Requests/sec | Latency avg (ms) | p50 | p97.5 | p99 | max | 2xx | errors |");
  log("|---|---|---|---|---|---|---|---|---|");

  const details = [];
  let allPass = true;

  for (const s of scenarios) {
    const targets = await s.setup();
    const result = await autocannon({
      url: API,
      connections: CONNECTIONS,
      duration: DURATION,
      requests: consumeRequests(targets, s.mode),
    });
    const rows = await check(targets);
    const checks = s.verify(rows, result);
    if (checks.some(([, ok]) => !ok)) allPass = false;

    const r = result.requests;
    const l = result.latency;
    log(`| ${s.name} | ${Math.round(r.average)} | ${l.average.toFixed(1)} | ${l.p50} | ${l.p97_5} | ${l.p99} | ${l.max} | ${result["2xx"]} | ${result.errors + result.timeouts + result.non2xx} |`);
    details.push({ s, checks, rows });
  }

  log();
  log("## Correctness checks after each run");
  for (const { s, checks, rows } of details) {
    log();
    log(`**${s.name}**: ${s.note}`);
    const sample = rows[0];
    log(`- first account: total ${sample.account}, sum of users ${sample.sumUsers}`);
    for (const [what, ok] of checks) log(`- ${ok ? "PASS" : "FAIL"}: ${what}`);
  }
  log();
  log(allPass ? "**All correctness checks passed under load.**" : "**Some correctness checks FAILED.**");

  await writeFile(new URL(`./results-${label}.md`, import.meta.url), lines.join("\n") + "\n");
  console.log(`\nSaved load-tests/results-${label}.md`);
  process.exit(allPass ? 0 : 1);
}

main();
