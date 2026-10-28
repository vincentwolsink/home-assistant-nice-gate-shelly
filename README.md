# Shelly Plus Uni Gate State

This repository provides two Shelly script variants that measure the ON-to-ON interval of the gate direction signal on INPUT 0 / IN1, classify movement as opening or closing, and report the final gate position (`open`/`closed`) to Home Assistant.

- [`gate-state-mqtt.js`](gate-state-mqtt.js) — publishes state to MQTT topics (with optional JSON telemetry)
- [`gate-state-rest.js`](gate-state-rest.js) — publishes state directly to the Home Assistant REST API

Both scripts use the same detection logic. Choose the one that fits your Home Assistant setup.

## How it works

- **Input**: `input:0` must be configured as a `switch`. The script will attempt to configure this automatically on startup.
- **Edge detection**: A status handler captures state changes as they happen. A 20 ms poll also reads the input directly (to avoid Shelly's input change notification rate limit).
- **Interval measurement**: The time between transitions to the "open level" (`openLevel`, default `true`) is measured as the ON-to-ON interval. This interval is classified every 250 ms.
- **Direction classification**:
  - Closing: ~300-700 ms (configurable, with slack)
  - Opening: ~800-1200 ms (configurable, with slack)
  - Intervals longer than `idleIntervalMs` (default 2000 ms) are ignored
- **Missed edge protection**: If a single missed ON edge doubles an interval (e.g. a closing interval becomes ~1120 ms and would fall into the opening range), the script ignores that doubled interval and requires consecutive confirmations before reversing direction. Starting from idle still reports on the first valid interval.
- **Position detection**: When movement stops, the script watches the stable input level:
  - **Fully open**: Input holds the open level for `openConfirmMs` (default 4500 ms) → reports `open` (and sets motion to `idle`, last direction to `opening`)
  - **Fully closed**: Input holds the non-open level for `closedConfirmMs` (default 5000 ms) → reports `closed` (and sets motion to `idle`, last direction to `closing`)
- **State retention**: The last `state` and `lastDirection` are saved to `Script.storage` and restored after a reboot.

## Wiring

1. Wire the gate direction signal to **IN1 / INPUT 0**.
2. The input is active-low on the Shelly Plus Uni (triggered below ~1.5 V). Do **not** connect 12/24 V or mains directly. Use an optocoupler or level shifter if needed.
3. In the Shelly web UI, go to **Settings → Inputs** and set IN1 / Input 1 to **Switch** and enable it. Both scripts attempt to do this automatically.

## Setup

### Common

1. Create a new script in the Shelly web UI.
2. Paste either `gate-state-mqtt.js` or `gate-state-rest.js`.
3. Configure the script (see [Configuration](#configuration) below).
4. Save and start the script.
5. Enable **Run on startup** so it survives reboots.
6. Check the script console for startup logs (e.g. input configuration and detected ranges).

### For MQTT (`gate-state-mqtt.js`)

1. Ensure **MQTT** is enabled in the Shelly device settings and connected to your broker.
2. Set `CONFIG.topicPrefix` to your desired prefix (default: `gate`).
3. The script will publish retained state/motion/interval/frequency and optional JSON telemetry.

### For REST (`gate-state-rest.js`)

1. Create a **Long-Lived Access Token** in Home Assistant (**Profile → Long-Lived Access Tokens**).
2. Set `CONFIG.haToken` in the script.
3. Set `CONFIG.haUrl` if your Home Assistant instance is not at `http://homeassistant.local:8123`.
4. Set `CONFIG.haStateEntity` (default: `sensor.gate_state`).
5. The script will create/update entities via the Home Assistant REST API on state changes.

## Configuration

All settings are at the top of each script under `CONFIG`.

| Setting | Default (MQTT) | Default (REST) | Meaning |
| --- | --- | --- | --- |
| `inputId` | `0` | `0` | Input component id (`0` = IN1) |
| `inputType` | `"switch"` | `"switch"` | Must be `switch`; scripts set this automatically |
| `openLevel` | `true` | `true` | Input `state` value that means fully open. Set to `false` if inverted |
| `pollMs` | `20` | `20` | Input poll interval in ms (fallback/guaranteed reads) |
| `sampleMs` | `250` | `250` | How often interval and level are evaluated |
| `closingMinMs` / `closingMaxMs` | `300` / `700` | `300` / `700` | Closing ON-to-ON interval range (ms) |
| `openingMinMs` / `openingMaxMs` | `800` / `1200` | `800` / `1200` | Opening ON-to-ON interval range (ms) |
| `rangeSlackMs` | `20` | `20` | Tolerance around range edges (ms) |
| `idleIntervalMs` | `2000` | `2000` | Intervals longer than this are not movement |
| `confirmIntervals` | `1` | `1` | Intervals needed to start moving from idle |
| `reversalConfirmIntervals` | `2` | `2` | Consecutive intervals needed to reverse an active direction |
| `openConfirmMs` | `4500` | `4500` | Stable ON time before latching `open` |
| `closedConfirmMs` | `5000` | `5000` | Stable OFF time before latching `closed` |
| `topicPrefix` | `"gate"` | — | MQTT topic prefix (MQTT only) |
| `publishTelemetry` | `true` | — | Publish JSON telemetry to `<prefix>/telemetry` (MQTT only) |
| `telemetryMovingMs` / `telemetryIdleMs` | `5000` / `60000` | — | Telemetry publish intervals (MQTT only) |
| `haUrl` | — | `"http://homeassistant.local:8123"` | Home Assistant base URL (REST only) |
| `haToken` | — | `""` | Long-Lived Access Token from HA (REST only) |
| `haStateEntity` | — | `"sensor.gate_state"` | Entity ID to update (REST only) |

## Home Assistant integration

### MQTT variant
Topics (all retained except telemetry):

| Topic | Values | Description |
| --- | --- | --- |
| `<prefix>/state` | `unknown`, `opening`, `closing`, `open`, `closed` | Gate state |
| `<prefix>/motion` | `idle`, `opening`, `closing` | Current motion |
| `<prefix>/interval` | integer ms | Last ON-to-ON interval (0 when stopped) |
| `<prefix>/frequency` | integer Hz | Derived `1000 / interval` (0 when stopped) |
| `<prefix>/telemetry` | JSON (not retained) | Telemetry: `state`, `motion`, `direction`, `interval_ms`, `freq`, `pulse_ms`, `gap_ms`, `edges`, `intervals`, `uptime_ms` |

### REST variant
The script updates entities via `POST /api/states/`:

- Entity: `CONFIG.haStateEntity` (default: `sensor.gate_state`)
- State: `unknown`, `opening`, `closing`, `open`, `closed`
- Attributes: `motion`, `interval_ms`, `last_direction`, `source`, `updated_at`

Example Lovelace card:

```yaml
type: entity
entity: sensor.gate_state
name: Gate
icon: mdi:gate
```

## Calibrating the ranges

The default ranges are a starting point. Calibrate to your gate:

1. Open and close the gate fully while watching logs/telemetry/attributes for intervals.
2. Note typical closing and opening ON-to-ON intervals.
3. Update `closingMinMs`/`closingMaxMs` and `openingMinMs`/`openingMaxMs` accordingly.
4. If values are roughly half/double, trust the direct Shelly measurement over previous measurements.
5. If opening and closing appear swapped, swap the ranges or adjust labels.

## Position detection details

- `openLevel` is the input `state` value for the "open" level (default `true`). If inverted, set `openLevel` to `false` or use the input **Invert** setting.
- State is restored after reboot, but if reboot happens mid-movement it will return to `unknown` until movement resumes or the level is stable long enough.
- If the gate stops mid-travel and the signal settles at an intermediate level, it will eventually report `open` or `closed` based on that stable level (same behavior as level-based detection).

## Troubleshooting

| Issue | Fix |
| --- | --- |
| `input:0 has no state; it must be type 'switch'` | Set IN1/Input 1 to **Switch** and enable it in **Settings → Inputs**. |
| State stuck on `opening`/`closing` after stopping | Ensure the final level is stable for `openConfirmMs`/`closedConfirmMs`. If stopped mid-travel, it may not reach the open/closed level. |
| Interval ~double expected | A missed ON edge or signal not returning to idle between pulses. Check wiring/pulse shape. |
| `open` and `closed` swapped | Set `openLevel` to the opposite value or enable **Invert** in input settings. |
| Direction swapped | Swap `closingMinMs/MaxMs` and `openingMinMs/MaxMs`. |
| Direction flips while moving one way | Missed ON edge causing doubled interval to cross ranges. Check logs for `ignoring doubled interval`. Reduce `pollMs` (try 20 ms), improve wiring/ground/optocoupler, or consider a pulse stretcher for very short pulses. |
| No MQTT updates (MQTT variant) | Check MQTT is enabled/connected, `topicPrefix`, and broker connectivity. Look at script console logs. |
| No HA updates (REST variant) | Check `haToken`, `haUrl` reachability from the Shelly, entity name validity, and script console for HTTP errors. HA creates the entity on first POST. |
| Script stops/crashes | Shelly script engine aborts on uncaught errors. Check the script console for the first error. Scripts avoid `Array.shift()`, `Date`, and deeply nested callbacks for compatibility with older mJS firmware. |
