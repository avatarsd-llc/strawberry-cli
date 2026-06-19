---
name: import-export
description: >
  Lossless save/restore of a Gorshok-v4 unit design or a whole-device envelope: export to JSON
  (redact secrets by default; the device key is never serialized), import by replaying
  GrowUnitSet + GrowUserIoAdd + CtrlGraphApply + GrowScheduleSet + ControlBoxSet in one ordered
  transaction. Clone a proven unit onto a fresh board. Use when asked to export/import/save/restore
  a unit or device design, clone a unit, or round-trip a configuration to JSON.
---

# import-export

> STUB — to be filled in by a later agent. Front-matter and scope are fixed.

## Goal

Round-trip a unit (or whole device) to JSON and back losslessly, with secrets redacted by default.

## CLI verbs

- `strawberry unit export --host <ip> --unit grow.1 [--file <F>]` ;
  `strawberry unit import --host <ip> [--as <NEW>] --file <F>` — a unit = GrowUnit + endpoints
  (persist/mqtt/can) + controller graph + schedule + Control Box.
- `strawberry device export --host <ip> [--include-secrets] [--file <F>]` ;
  `strawberry device import --host <ip> --file <F>` — redact-by-default envelope.

## Underlying wire (per ADR-0066 D9/H7/H8)

- **export** reads via `Query{WHAT_GROW_CONFIG}` + `ControllerListReq` + `GrowUserIoListReq` +
  `ControlBoxGet`.
- **import** replays `GrowUnitSet` + `GrowUserIoAdd` + `CtrlGraphApply` + `GrowScheduleSet` +
  `ControlBoxSet` as one ordered transaction.

## Non-negotiables

- **Secrets redacted by default**; the device key is **never** serialized.
- Import order is fixed and transactional.

## To document here

The export envelope schema (unit vs device); the redaction policy; the import replay order and
rollback behavior; how `--as <NEW>` re-IDs a cloned unit.
