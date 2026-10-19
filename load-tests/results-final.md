# Load test results: final

- Date: 2026-10-18T19:59:29.200Z
- Machine: Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz (12 logical CPUs), 15.5 GB RAM, win32 10.0.26100
- Node: v24.21.0, tool: autocannon, target: http://localhost:3000
- Per scenario: 50 parallel connections for 10 seconds, 1 unit per request
- The service and Postgres run in Docker on the same machine as the load generator, so absolute numbers are conservative.

| Scenario | Requests/sec | Latency avg (ms) | p50 | p97.5 | p99 | max | 2xx | errors |
|---|---|---|---|---|---|---|---|---|
| A. One account, 50 users, everything accepted | 120 | 408.0 | 432 | 702 | 784 | 1072 | 1204 | 0 |
| B. 20 accounts x 5 users, everything accepted | 214 | 231.8 | 225 | 312 | 352 | 512 | 2137 | 0 |
| C. One account capped at 1000 units, most requests rejected | 147 | 335.1 | 280 | 561 | 586 | 657 | 1473 | 0 |
| D. Retries: the same requestIds again and again | 414 | 119.9 | 116 | 142 | 152 | 397 | 4135 | 0 |

## Correctness checks after each run

**A. One account, 50 users, everything accepted**: All requests share one account row, so they are serialized by its lock.
- first account: total 1254, sum of users 1254
- PASS: account total equals the sum of its users
- PASS: account never above its allowance

**B. 20 accounts x 5 users, everything accepted**: Different accounts do not lock each other, so work can run in parallel.
- first account: total 114, sum of users 114
- PASS: every account total equals the sum of its users
- PASS: no account above its allowance

**C. One account capped at 1000 units, most requests rejected**: Correctness under pressure: no more than 1000 units may ever be accepted.
- first account: total 1000, sum of users 1000
- PASS: never more than 1000 units accepted
- PASS: cap was reached: exactly 1000 units accepted
- PASS: account total equals the sum of its users

**D. Retries: the same requestIds again and again**: Replayed decisions: nothing may be counted twice.
- first account: total 50, sum of users 50
- PASS: each of the 50 request ids counted exactly once (total = 50)

**All correctness checks passed under load.**
