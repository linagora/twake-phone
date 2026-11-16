# SIP load bench (phase 1)

A tool, not a test: it measures how much of the SIP stack (`docker/docker-compose.sip.yml`) holds, and says what showed
strain first. Phase 1 has two scenarios. Calls with sound (phase 2) are not here.

1. **Registrations held**, over a WebSocket (primary, as browsers) and over UDP. Steps of phones (250, 500, 1000, 2000,
   4000, 8000), `Expires: 60`, refresh every 30 s, held 75 s after the last phone registered (two refreshes at least).
   What OpenSIPS holds is read from its MI (`usrloc` statistic `location-contacts`, the minimum of the samples taken
   during the hold), not from the 200 answers.
2. **Calls per second**, extension to extension: INVITE with an SDP (plain RTP to a silent port), the callee answers 200
   at once, 2 s held, BYE. Steps of 5, 10, 20, 40, 80, 160 calls/s for 30 s. After each step, rtpengine's sessions are
   counted 5 s and 40 s after the last BYE.

A step passes when at least 99 % of the phones are held (or calls set up) and p95 is under 1 s (REGISTER to 200 with the
401 round; INVITE to 200 with the 407 round). The scenario stops at the first step that fails: "gave out first".

## What runs

Only PostgreSQL, rtpengine and OpenSIPS (no Gateway, Wazo, LiveKit, Meet). Everything is at the compose defaults except
rtpengine's port range (`docker-compose.bench.yml`: 36000-60000 instead of 30000-30400, which holds about a hundred
calls). The CI's reduced caps (`MEET_CALLS_ALL` and others of the `sip-e2e` job) are not used. The effective settings
(OpenSIPS environment and rendered `udp_workers`/`tcp_workers`, rtpengine ports, PostgreSQL `max_connections`,
`ulimit -n` of the containers and of the generator) are printed in the result. A step that fails on one of them (for
example OpenSIPS's `tcp_max_connections`, not set by the script) is a setting, not a capacity: say it so.

## Generator

The phones are played by worker threads (`BENCH_WORKERS`, 2 by default) in `load.mjs`; `sip.mjs` is the SIP, with the
RFC 3261 retransmissions over UDP (Timer A and E), counted. Each step reports the event-loop utilisation and lag of the
threads: above 85 % busy or a p99 lag over 100 ms, the step is marked **generator-bound** and its failure says nothing
of the stack ("at least the step before"). Per step also: CPU (cores) and RSS of opensips, rtpengine, postgres and node
(from `/proc`; RSS adds shared memory once per process), kernel UDP `InErrors`/`RcvbufErrors` (`/proc/net/snmp`; the
generator and the stack share the host's counters), and the three most frequent `ERROR` lines of the stack's logs.

## Run

On a Linux host (the stack uses the host network):

```
docker compose -f docker/docker-compose.sip.yml -f docker/bench/docker-compose.bench.yml up --build --wait opensips
yarn install --frozen-lockfile && npx tsc -b packages/provider-opensips
ulimit -n 65536; node docker/bench/bench.mjs
```

On GitHub: `gh workflow run ci.yml --ref <branch> -f bench=true` (job `bench` of `ci.yml`; it replaces the other jobs for
that dispatch). It runs each scenario 3 times, uploads `bench-result.json` and `bench-result.md`, and writes the summary
to the job. Environment: `BENCH_SCENARIOS` (`reg-ws,reg-udp,calls`), `BENCH_REPEATS`, `BENCH_WORKERS`,
`BENCH_REG_STEPS`, `BENCH_CALL_RATES`, `BENCH_CALL_SECONDS`, `BENCH_REG_HOLD_SEC`, `BENCH_JSON`.

The bench writes `subscriber` rows `700000`+ and removes them at the end.
