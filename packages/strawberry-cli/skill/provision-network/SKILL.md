---
name: provision-network
description: >
  Join a Gorshok-v4 board to the operator network: set Wi-Fi STA credentials, optionally enable
  Home-Assistant MQTT auto-discovery, then (for fleet-managed boards) provision the WireGuard
  client from a wg-quick .conf and poll until the peer comes up. Moves the board off SoftAP onto
  the LAN/overlay. Use when asked to set Wi-Fi/SSID, configure Home Assistant/MQTT, join a board
  to WireGuard/the fleet/the overlay, or get a board onto the network.
---

# provision-network — join the board to the LAN + overlay

Take an **authenticated** board off SoftAP and onto the operator LAN, optionally onto the
Home-Assistant MQTT bus and the WireGuard overlay. Every operation here goes through
`strawberry-cli`, the headless front end over the shared `@avatarsd-llc/strawberry-client` library
(the one WS+protobuf core). This skill supersedes the hand-rolled
`strawberry-fw/tools/wg_provision.py`.

## Prerequisites

1. **You have an authenticated, resumable session.** Run the `reach-and-auth` skill first. You
   need a `$HOST` (the `ws://<ip>/ws` confirmed **by MAC** — DHCP leases drift, so a known IP is
   not enough) and a 0600 `--token-file` so the session survives the reconnects that a Wi-Fi
   switch causes.
2. **The board's MAC is known** (e.g. `aa:bb:cc:dd:ee:ff`). The moment the board joins a new
   network its DHCP IP changes; you re-find it **by MAC**, not by remembering the old IP.
3. **Inputs to hand:**
   - Wi-Fi: target `--ssid` and `--wifi-pass`.
   - (Optional) Home Assistant: `--mqtt-uri`, and `--mqtt-user` / `--mqtt-pass` / `--prefix`.
   - (Fleet only) a **wg-quick `.conf`** with `[Interface]` (`PrivateKey`, `Address`) and
     `[Peer]` (`PublicKey`, `Endpoint`, `AllowedIPs`, optional `PersistentKeepalive`).
4. **Learn the vocabulary, don't guess it.** The CLI tree is generated from the library's live
   protobuf enums:
   ```bash
   strawberry help --json
   ```
   Take exact flag names from there if anything below has drifted.

Set a shell var for the session so every command is copy-pasteable:

```bash
HOST=ws://192.0.2.177/ws        # the MAC-confirmed target from reach-and-auth
TOK=./board.token               # the 0600 token file from reach-and-auth
MAC=aa:bb:cc:dd:ee:ff           # used to re-find the board after the IP moves
CIDR=192.0.2.0/24               # operator LAN to re-scan after Wi-Fi join
```

## Non-negotiables

- **Re-resolve by MAC after Wi-Fi joins.** Switching SSID/subnet changes the DHCP IP; the old
  `$HOST` goes stale and looks like a crash but isn't (`device-hil-facts`).
- **Keep WS clients <= 2.** The C6 httpd wedges with more concurrent clients — close the watch
  loop before opening another session.
- **Resume, don't re-login.** After any reconnect, replay the stored token
  (`strawberry auth resume`) rather than logging in fresh.
- **Plaintext secrets never cross the wire** for auth (HMAC). Note this does **not**
  apply to provisioning payloads: the Wi-Fi PSK, MQTT password and WireGuard private key are sent
  as field values inside the authenticated, framed `WifiSet`/`HaSet`/`WgSet` messages — keep the
  `.conf` and any password files out of shell history and at mode 0600.

---

## Step 1 — Wi-Fi STA credentials (`WifiSet`)

Push the station credentials. The board stores them in NVS and attempts to join.

```bash
strawberry net wifi --host "$HOST" --ssid "MyLab-2G" --wifi-pass "$(cat ./wifi.pass)"
```

Expect an `Ack`. (`WifiSet{ssid,password}` -> `Ack(20)`.) On a fresh board you are talking to it
over its SoftAP; once it joins the new SSID, the SoftAP session drops — that is expected.

### Verify: poll `WifiState` until connected with a LAN IP

`WifiState` is `{ ssid, connected, ip, rssi }`. Poll until `connected == true` **and** `ip` is a
routable LAN address (not blank, not `0.0.0.0`, not link-local `169.254.x` — a link-local address
means DHCP did not lease, an environmental fault, not a board bug):

```bash
strawberry query wifi --host "$HOST" --json
```

If the session dropped because the IP moved, re-find the board and resume (see "Re-resolve" below)
before polling again. Give the join up to ~30 s; Wi-Fi association plus DHCP can take several
seconds.

**Gate:** `WifiState.connected == true` with a real LAN IP.

### Re-resolve by MAC + resume (do this whenever the IP moved)

```bash
# WS-probe the operator LAN; the firmware ships NO mDNS, so this is an IP sweep.
strawberry discover --cidr "$CIDR" --mac "$MAC" --json
# -> pick the row whose mac == $MAC, take its ip:
HOST=ws://<new-ip>/ws
# replay the stored token across the new socket (no re-login):
strawberry auth resume --host "$HOST" --token-file "$TOK" --json
```

`discover` opens each candidate and reads `WHAT_CAPABILITIES` + `WifiState`, reporting
`ip/mac/board_rev`; match on `$MAC`. From here `$HOST` is the new address for every later command.

---

## Step 2 — Home Assistant MQTT auto-discovery (optional, `HaSet`)

Only if the operator wants HA integration. Enable and point at the broker:

```bash
strawberry net ha --host "$HOST" \
  --enabled \
  --mqtt-uri  "mqtt://192.0.2.10:1883" \
  --mqtt-user "homeassistant" \
  --mqtt-pass "$(cat ./mqtt.pass)" \
  --prefix    "homeassistant"
```

Expect an `Ack`. (`HaSet{enabled,mqtt_uri,mqtt_user,mqtt_password,topic_prefix}` -> `Ack(20)`.)

To disable HA later, send it disabled (take the exact flag from `help --json`, typically
`--no-enabled` / `--enabled=false`):

```bash
strawberry net ha --host "$HOST" --no-enabled
```

### Verify: read `HaConfig`

`HaConfig` is `{ enabled, mqtt_uri, mqtt_user, topic_prefix, connected, last_error }` — note the
password is **never** echoed back. Confirm `enabled == true`, `connected == true`, and
`last_error` empty:

```bash
strawberry net info --host "$HOST"        # reads live WifiState + HaConfig
# or: strawberry query ha --host "$HOST" --json
```

A non-empty `last_error` (bad URI, auth failure, broker unreachable) means the broker rejected the
board — fix the URI/credentials and re-send `HaSet`.

**Gate (if HA requested):** `HaConfig.connected == true`, `last_error` empty.

---

## Step 3 — WireGuard overlay (fleet boards only, `WgSet`)

Skip this entirely for standalone boards. For fleet-managed boards, provision the device's
WireGuard **client** from a wg-quick `.conf`. The CLI parses `[Interface]`/`[Peer]` and **derives
the on-link netmask from the `AllowedIPs` subnet that contains the Interface `Address`** — so the
tunnel subnet is on-link via wg while the LAN keeps routing over Wi-Fi (matching the firmware's
`wg_client.c`).

### Pre-flight: validate the `.conf` before sending

The board will silently fail to hand-shake if the `.conf` is missing a peer field or the
`Address` is not inside any `AllowedIPs` subnet. Validate locally first with the bundled helper
(pure parse + netmask derivation, no network, mirrors the firmware logic):

```bash
node skills/provision-network/scripts/check-wg-conf.mjs ./strawberry-sd.conf
```

It prints the derived `local_ip / local_netmask -> peer_endpoint:port keepalive` line and exits
non-zero with a clear message if a required field is missing or the address is off-subnet. Fix the
`.conf` until it passes.

### Apply

```bash
strawberry wg apply --host "$HOST" --conf ./strawberry-sd.conf
```

Expect an `Ack`. (`WgSet{enabled,private_key,peer_public_key,local_ip,local_netmask,peer_endpoint,peer_port,keepalive_s}`
-> `Ack(20)`. The private key is write-only: it is accepted but **never** echoed in `WgConfig`.)

### Verify: watch `WgStatus` until the peer is UP

`WgStatus` is `{ state, enabled, configured, last_err, retry_count, state_since_s }` where `state`
is a `WgState`:

| state | `WgState`            | meaning |
|------:|----------------------|---------|
| 0     | `WGSTATE_DISABLED`   | tunnel off |
| 1     | `WGSTATE_IDLE`       | enabled, waiting on STA link / wall clock / config |
| 2     | `WGSTATE_CONNECTING` | tunnel up locally, handshake pending |
| 3     | `WGSTATE_UP`         | **peer handshake complete — success** |
| 4     | `WGSTATE_RETRYING`   | last attempt failed, backing off |

Poll until `state == up`, with a watch window:

```bash
strawberry wg status --host "$HOST" --watch 60     # polls WHAT_WG_STATUS until UP or timeout
```

A WireGuard tunnel needs the board's wall clock set and STA link up first, so allow up to ~60 s.
If it sticks in `RETRYING`, read `last_err` (an `esp_err_t` of the last failed bring-up) — a
non-zero value plus a rising `retry_count` usually means a wrong `Endpoint`/port, an unreachable
peer, or a clock not yet synced.

Optionally read back the stored config (no secret):

```bash
strawberry query wireguard --host "$HOST" --json    # WgConfig: enabled, has_private_key, peer_public_key, local_ip, ...
```

**Gate (fleet boards):** `WgStatus.state == up` within the watch window.

> Note: once the tunnel is up, fleet management may prefer to reach the board over its **overlay**
> IP (the `local_ip` from the `.conf`) rather than the LAN IP. If you switch `$HOST` to the
> overlay address, resume the token again against the new address.

---

## Cleanup / rollback

- **Disable the WireGuard tunnel** (sends `WgSet{enabled=false}`, clearing the peer):
  ```bash
  strawberry wg disable --host "$HOST"
  strawberry wg status  --host "$HOST" --json     # confirm state == disabled
  ```
- **Disable HA** (stops MQTT auto-discovery):
  ```bash
  strawberry net ha --host "$HOST" --no-enabled
  ```
- **Wi-Fi rollback** has a catch: if the new SSID is wrong, the board may be unreachable on the
  LAN. Re-resolve by MAC first; if it never joined, fall back to its **SoftAP** (it re-raises the
  AP when STA fails to associate) and re-send `WifiSet` with corrected credentials. A
  `factory-reset` (a destructive, sign-off-gated step — see the `flash-ota`/`setup-board` skills)
  is the last resort to clear bad NVS network config.

## Done when

- [ ] `WifiState.connected == true` with a routable LAN IP (not `0.0.0.0`, not `169.254.x`).
- [ ] `$HOST` re-resolved by MAC after the IP moved; token resumed (no re-login).
- [ ] (If HA requested) `HaConfig.connected == true`, `last_error` empty.
- [ ] (If fleet) the `.conf` passed `check-wg-conf.mjs`, `WgSet` acked, and `WgStatus.state == up`.
- [ ] WS clients kept <= 2 throughout (watch loops closed before opening new sessions).

## See also

- `reach-and-auth` — the mandatory predecessor (discover + HMAC login + token persist).
- `config-hardware` — subsystem flags + hardware calibration, runs after the board is on the LAN.
- `setup-board` — the orchestrator that sequences this skill between `reach-and-auth` and
  `flash-ota`.
- Library: `@avatarsd-llc/strawberry-client`. Superseded tool:
  `strawberry-fw/tools/wg_provision.py`.
