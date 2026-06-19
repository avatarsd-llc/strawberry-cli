---
name: diagnose
description: >
  On-device health and observability pass for a Gorshok-v4 board: free-heap trend + min_free
  watermark, the 7-phase system stress, capacity-boundary probing, and JSONL recording of push
  streams (logs, stats, io, controllers) for offline dynamics. The standing per-iteration HIL
  check. Use when asked to diagnose/check board health, watch heap/min_free, run a stress or
  capacity test, or record live device telemetry to a file.
---

# diagnose

> STUB — to be filled in by a later agent. Front-matter and scope are fixed.

## Goal

Establish that the board is healthy under load and capture live dynamics for offline analysis.

## CLI verbs

- `strawberry diag heap --host <ip> [--seconds N] [--json]` — drives `Query{WHAT_STATS}` in a loop;
  reports free-heap trend and `min_free` watermark.
- `strawberry diag stress --host <ip> [--json]` — the 7-phase system stress (unit/controller churn
  while watching `min_free`).
- `strawberry diag boundary --host <ip> [--unit-cap N] [--json]` — capacity-boundary probe
  (push to `ERR_NO_MEM`, report ceiling).
- `strawberry record --host <ip> --topics <snapshot,stats,io,...> --out <FILE.jsonl> [--io-filter GLOB] [--io-decimate HZ] [--seconds N]`
  — subscribe to push streams and record JSONL (meta header, wall-clock = bootOffsetMs+ts_ms,
  StatsFast joined onto last full Stats). The IO topic is **off unless `--io-filter`** (20fps x 100+
  is a firehose).
- `strawberry query stats --host <ip> --json`.

## Non-negotiables

- Keep WS clients **<= 2** — the C6 httpd wedges with 3 concurrent clients.
- Healthy floor: `min_free` >= ~28K at peak, no UAF.
- Note the HWM-vs-min-free gotcha when reading watermarks.

## To document here

The heap-trend read; the 7 stress phases and their cleanup (STRESS-tagged); the boundary probe loop
and how to read the ceiling; the `record` JSONL format and reconnect/auth-expired meta lines.
