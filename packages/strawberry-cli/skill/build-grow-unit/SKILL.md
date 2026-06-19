---
name: build-grow-unit
description: >
  Compose a Gorshok-v4 cultivation unit end to end via strawberry-cli: create the unit
  container, add its user-defined IO endpoints (full id <unit_id>.<name>), atomically
  apply the controller dataflow graph (create + wire in one rollback-safe frame, idempotent
  re-bind), push the working schedule (real-day scheduler), and optionally set the
  per-unit Control Box HMI blob. Use when asked to build/create/wire a grow unit,
  add IO endpoints to a unit, apply or edit a controller graph, push a unit schedule, or set
  a Control Box on a Gorshok / strawberry-fw board.
---

# build-grow-unit

Build a complete, wired cultivation unit on a live board, in the canonical order:

```
unit container  ->  IO endpoints  ->  controller graph  ->  schedule  ->  (optional) Control Box
```

Everything is driven through `strawberry-cli` (the thin front end over the shared
`@avatarsd-llc/strawberry-client` WS+protobuf core). This skill never re-implements the
wire protocol — it issues CLI verbs and reads them back.

## Prerequisites (do these first; do not skip)

- **An authenticated session to the target board.** Run the `strawberry-reach-and-auth` skill
  first: discover the board, confirm it **by MAC** (DHCP leases drift — a stale IP looks like a
  crash but isn't; e.g. `aa:bb:cc:dd:ee:ff`), HMAC login, and persist the token to a
  **0600** token file. Every command below takes `--host <ip>` and an authenticated session
  (token file or `$STRAWBERRY_PASSWORD`).
- **Know the board's capabilities.** A unit's controllers must wire to endpoints that resolve to
  real hardware (or to virtual feeds). Run `strawberry query capabilities --host $HOST --json`
  and `strawberry query device_config --host $HOST --json` so you only wire pins the board can
  back. Gate every controller against what the hardware actually has.
- **Discover the vocabulary, don't guess it.** The CLI command tree is generated from the
  library's live protobuf enums. Read it once and take exact verb/flag/enum names from it:

  ```bash
  strawberry help --json
  ```

  In particular, the grow `--kind`, `io-add --role/--dtype`, and `schedule` column-kind values
  come from live enums — read them from `help --json` rather than hard-coding the spellings.

Set a host variable for the rest of the skill (replace with the MAC-confirmed IP):

```bash
HOST=192.0.2.177            # the ws://<ip>/ws target, confirmed by MAC
UNIT=grow.1                 # the unit id you are building (the identity)
```

## Field reference (ground truth — `strawberry-fw/components/proto/messages.proto`)

This is the firmware contract the CLI flags map onto. Cite it when shaping JSON files.

- **Unit identity is the string `id`** (`GrowUnit.id`, field 24). `id` like `grow.1`.
  `--kind` is a `GrowKind`: `GROW_KIND_SUBSTRATE=0`, `HYDRO_PURE=1`, `HYDRO_SUBSTRATE=2`,
  `AERO=3`, `AQUAPONIC=4`, `AQUARIUM=5`, `WATER=6` (water-station SM base),
  `CUSTOM=7` (bare unit: no scheduler/health/status LED). `--active` sets `GrowUnit.active`
  (`messages.proto:1454-1510`).
- **Endpoint = `GrowUserIoDesc`** (`messages.proto:1554-1566`). `name` is `[a-z][a-z0-9_]*`,
  `< 24` chars; the **full io_layer id is `<unit_id>.<name>`** (e.g. `grow.1.air_temp`).
  `role` = `0 input / 1 output / 2 virtual`; `dtype` = `0 bool / 1 i32 / 2 u32 / 3 f32`;
  `unit` is a `<= 7` char engineering-unit hint; `flags` carries `IO_FLAG_MQTT_EXPOSED` (the
  `--mqtt` opt-in). **`scope=board` is firmware-refused with `ERR_UNSUPPORTED`** — unit-scope only.
- **Controller node = `ControllerCreate`** (`messages.proto:1676-1682`): `kind` (string, e.g.
  `pid`), `instance_id` (string), `params` (opaque bytes — the CLI/lib packs the kind's params
  struct; layout is the firmware/UI build contract in `web-ui/.../controller-kinds.ts`), and
  `inputs`/`outputs` arrays of `ControllerBinding{ slot, io_id }` (`messages.proto:1674`).
- **`CtrlGraphApply`** (`messages.proto:1693-1695`) lands `nodes[]` **atomically**: the server
  creates every node, *then* binds (forward references within the chunk resolve), and **rolls the
  whole chunk back on a hard create failure**. **Idempotent** — a node whose `instance_id`
  already exists is **re-bound, not re-created**. Success emits a `CtrlGraphChanged` push on
  `TOPIC_CONTROLLERS`.
- **`GrowScheduleSet`** (`messages.proto:1541-1550`): `id` = target unit, `params[]` = columns
  (`ParamDef`: `key` joins `grow.<i>.scheduler.<key>`, `kind` 0=VALUE / 1=PHOTOPERIOD),
  `stages[]` = rows (`GrowProfileStage`: `name`, `values[]` aligned index-for-index with
  `params`, `duration_s`, `flags` bit0=infinite/bit1=manual-advance), `derived_mask` = exposed
  `SCHED_DERIVED_*` outputs. Omitting the schedule keeps the unit's current one. Real-day
  scheduler — run-state/anchor (Start/Pause) stay unit-authoritative.
- **`ControlBoxSet`** (`messages.proto:1574-1576`): per-unit opaque JSON blob; the
  **firmware stores it but never decodes it** — the web UI owns the structure. Empty `data`
  clears the unit's boxes.

## Steps

### 1. Create (or update) the unit container

The unit is the container the endpoints, controllers, and schedule attach to. Creating it first
is mandatory — endpoints and graph nodes that reference an unknown unit are rejected.

```bash
strawberry grow unit-set --host $HOST --id $UNIT --name 'Basil' --kind GROW_KIND_HYDRO_PURE --active
```

`grow unit-set` is upsert: re-running it with the same `--id` updates name/kind/active in place.
Read it back:

```bash
strawberry query grow_config --host $HOST --json   # the unit appears with active/id/name/kind
```

**Gate:** `query grow_config` lists `$UNIT` with the expected `id`, `name`, `kind`, `active`.

### 2. Add the unit's IO endpoints

Endpoints are the pins controllers wire to. Add one per `io-add` (full id becomes
`$UNIT.<name>`). Endpoints are **unit-scoped only** (`scope=board` is firmware-refused). Match
each example below to a real or virtual signal; gate hardware-backed ones to capabilities.

```bash
# A process-value input the PID reads (f32, degrees C), exposed to Home-Assistant MQTT:
strawberry grow io-add --host $HOST --unit $UNIT --name air_temp --role input  --dtype f32 --unit-hint C --mqtt
# A control-effort output the PID drives (f32, 0..1 PWM duty):
strawberry grow io-add --host $HOST --unit $UNIT --name heater   --role output --dtype f32 --unit-hint ''
```

List / remove:

```bash
strawberry grow io-list   --host $HOST --unit $UNIT --json
strawberry grow io-remove --host $HOST --unit $UNIT --name heater
```

**Gate:** `grow io-list` shows every endpoint the graph will bind to. A `graph-apply` that binds
a slot to a missing `io_id` is what the rollback protects against — add endpoints **before** the
graph so binds resolve.

### 3. Apply the controller dataflow graph (atomic)

Author the whole graph as one dependency-ordered JSON chunk and land it in a single atomic frame.
**Prefer `graph-apply` over incremental wiring** for a fresh unit: it creates all nodes, then
binds (forward refs resolve), and rolls back on any hard failure. Re-running is safe — existing
`instance_id`s are re-bound, not duplicated (idempotent).

```bash
strawberry controllers graph-apply --host $HOST --nodes examples/graph.json
```

`examples/graph.json` (a minimal real graph: a PID reading `air_temp`, driving `heater`):

```json
{
  "nodes": [
    {
      "kind": "pid",
      "instance_id": "grow.1.pid_heat",
      "params": { "setpoint_default": 24.0, "kp": 0.8, "ki": 0.02, "kd": 0.0 },
      "inputs":  [ { "slot": 0, "io_id": "grow.1.air_temp" } ],
      "outputs": [ { "slot": 0, "io_id": "grow.1.heater" } ]
    }
  ]
}
```

Notes that keep the apply atomic and correct:

- `inputs`/`outputs` slot numbers are the kind's declared slots (see the kind's
  `inputs[]`/`outputs[]` in `web-ui/.../controller-kinds.ts`; e.g. `pid` slot 0 in = process value,
  slot 0 out = control effort). Leave a slot **unbound** (omit it) to use the param default.
- `params` is a per-kind object; the CLI/lib packs it into the `ControllerCreate.params` bytes
  using the kind's layout. Unknown/garbage param keys are a contract error — take the keys from
  the kind definition.
- `instance_id` should be unit-prefixed (`$UNIT.<name>`) so removing the unit cleans it up and the
  orphan invariant holds (every `grow.<id>.*` controller must belong to an **active** unit).

For incremental edits there are individual verbs — `controllers create/bind/destroy/list/
set-target/set-params/set-enabled/acknowledge`. If you must wire incrementally over WS rather than
one atomic frame, **bound the burst to ~6 controllers per batch** (the WS send drops acks under
heavier bursts).

**Gate:** `strawberry controllers list --host $HOST --json` shows every node bound (no
unresolved slots), and a `CtrlGraphChanged` push was emitted (subscribe `TOPIC_CONTROLLERS` /
`strawberry record --topics controllers` if you want to capture it).

### 4. Push the working schedule

The schedule is the column/row table the real-day scheduler runs. `params` = columns,
`stages` = rows (each `values[]` aligned to `params`), `derived_mask` = which `SCHED_DERIVED_*`
outputs to expose.

```bash
strawberry grow schedule-set --host $HOST --unit $UNIT --schedule examples/schedule.json
```

`examples/schedule.json` (two VALUE columns + one PHOTOPERIOD column, three stages):

```json
{
  "params": [
    { "key": "target_temp", "label": "Air temp", "unit": "C",  "kind": 0, "expose_io": true },
    { "key": "target_rh",   "label": "Humidity", "unit": "%",  "kind": 0, "expose_io": true },
    { "key": "light",       "label": "Photoperiod",            "kind": 1 }
  ],
  "stages": [
    { "name": "Seedling", "duration_s": 1209600, "values": [22.0, 70.0, 21600, 64800] },
    { "name": "Veg",      "duration_s": 2419200, "values": [24.0, 60.0, 21600, 79200] },
    { "name": "Flower",   "duration_s": 0, "flags": 1, "values": [26.0, 50.0, 28800, 72000] }
  ],
  "derived_mask": 0
}
```

Shape rules (from `messages.proto:1402-1427`):

- A **VALUE** column (`kind:0`) contributes **one** cell per stage; a **PHOTOPERIOD** column
  (`kind:1`) contributes **two** cells (`begin_s`, `end_s` local seconds-of-day; `begin > end`
  wraps midnight). So each `stages[i].values` length = (#VALUE columns) + 2*(#PHOTOPERIOD columns),
  in column order.
- `duration_s` is the stage length in seconds; `flags` bit0 = infinite stage (the example's
  `Flower` runs until manually advanced), bit1 = manual-advance.
- Omitting `--schedule` entirely keeps the unit's current working schedule (a unit-set without a
  schedule does not wipe it).
- Start/Pause and the day anchor stay unit-authoritative — they are not part of `schedule-set`.

**Gate:** `query grow_config --json` shows the unit's `sched_params`/`sched_stages` matching what
you pushed; if a column set `expose_io:true`, the `grow.$UNIT.scheduler.<key>` endpoint appears in
`io-list`.

### 5. (Optional) Set the Control Box HMI blob

The Control Box is a per-unit opaque JSON blob the firmware **stores but never
decodes**; the web UI renders it as a soft HMI (sliders/buttons/steppers) that writes via `io set`
(not a controller kind). Set or clear it:

```bash
strawberry box set --host $HOST --unit $UNIT --data examples/control-box.json
strawberry box get --host $HOST --unit $UNIT --json     # read it back
strawberry box set --host $HOST --unit $UNIT            # empty data clears the unit's boxes
```

The structure is the web-UI's concern; for headless builds, round-trip whatever the SPA exported.

## Verify success (read-back assertions)

A convenience verifier is bundled — it drives the CLI and asserts the invariants:

```bash
./verify-unit.sh $HOST $UNIT
```

It checks, all via `strawberry ... --json`:

1. `query grow_config` → the unit exists, is active, has the expected kind, and its
   `sched_params`/`sched_stages` are populated.
2. `grow io-list` → every endpoint the graph binds to is present.
3. `controllers list` → every graph node exists and is bound (no unresolved slots).
4. **No orphans:** every `grow.$UNIT.*` endpoint belongs to an **active** unit (the firmware
   invariant — see `strawberry-fw/tools/verify_orphans.py`, which this supersedes). Run
   `strawberry query io_struct --json` and assert no `grow.<id>.*` whose `<id>` is not an active
   unit (an orphan leaks io_layer slots toward the 511 ceiling).

For live dynamics after the unit is wired, record a short window:

```bash
strawberry record --host $HOST --topics stats,io,controllers --out run.jsonl --seconds 30
```

## One-shot alternative

If you have a proven unit design JSON (a `GrowUnit` + endpoints + controller graph + schedule +
optional Control Box), import it in one ordered transaction instead of steps 1–5
(skill: `strawberry-import-export`):

```bash
strawberry unit import --host $HOST --file design.json [--as grow.2]
```

Import replays `GrowUnitSet + GrowUserIoAdd + CtrlGraphApply + GrowScheduleSet + ControlBoxSet` in
order. `--as` clones the design under a new unit id.

## Cleanup / rollback

- **A partial build:** because `graph-apply` is atomic, a failed apply leaves no half-graph — fix
  the JSON and re-apply (idempotent). Endpoints added in step 2 before a failed graph are *not*
  rolled back; remove stragglers with `grow io-remove`.
- **Remove the whole unit:** `strawberry grow unit-remove --host $HOST --id $UNIT`. This must also
  clean the unit's persisted controllers — confirm with the orphan check afterward (a removal that
  forgets to re-serialise the registry resurrects ownerless controllers on next boot, the exact
  bug `verify_orphans.py` guards against).
- **Wipe all grow state on the board** (units/schedules/profiles + the persisted controller graph;
  Wi-Fi/system settings survive): `strawberry reboot --host $HOST --grow-erase`. **Destructive and
  reboots the unit — get human sign-off first**, then re-auth with the stored token and validate
  the reboot dwell+3x (`system_mode=NORMAL`, pushes resumed).

## Non-negotiables

- Order is **unit → endpoints → graph → schedule → box**. Endpoints must exist before the graph
  binds to them.
- Endpoints are **unit-scoped only**; `scope=board` is firmware-refused (`ERR_UNSUPPORTED`).
- Prefer the **atomic `graph-apply`** (rollback-safe, idempotent re-bind) over incremental wiring.
  If you do wire incrementally over WS, bound bursts to **~6 controllers/batch**.
- Keep WS clients **<= 2** (the C6 httpd wedges with more concurrent clients).
- Take `--kind`, `--role`, `--dtype`, and schedule column kinds from `strawberry help --json` /
  the proto, not from memory.
- Verify with read-backs (`query grow_config`, `controllers list`, the orphan check) — never claim
  the unit is built without them.

## See also

- Orchestrator: `strawberry-setup-board` (this is its step 7).
- First step: `strawberry-reach-and-auth` (you need an authed session before any command here).
- One-shot path: `strawberry-import-export`.
- Health pass after building: `strawberry-diagnose`.
- Firmware contract: the canonical `proto/messages.proto` shipped in `@avatarsd-llc/strawberry-client` — covers unit identity, the real-day scheduler, and the Control Box blob.
