# Shelly Plus Uni gate state -> Home Assistant

Reads the gate direction signal on **INPUT 0 / IN1**, measures the time between
successive ON transitions, classifies it as **opening** or **closing**, and
exposes the gate state to Home Assistant via the REST API.

This is a replacement for the Node-RED flow in
[`flow.json`](flow.json). The script is
[`gate_frequency_mqtt.js`](gate_frequency_mqtt.js) (the filename is historical;
it now measures an interval, not a frequency).

| Gate movement | ON-to-ON interval |
| --- | --- |
| Closing | 300-700 ms |
| Opening | 800-1200 ms |
| Stopped | no transitions |

## What the Node-RED flow actually does

The flow is:

```
binary_sensor.hek_input_0_input (only transitions to "on")
  -> interval-length, format = milliseconds
  -> 300..700 ms  -> "closing"
  -> 800..1200 ms -> "opening"
  -> input on  for 5 s -> "open"
  -> input off for 5 s -> "closed"
```

So `300/700` and `800/1200` are **milliseconds between ON transitions**, not Hz.
The `interval-length` node only receives messages for ON transitions, so it
measures the same thing as one full signal period.

The flow also has two details that this script intentionally does not copy:

- Both direction branches go through a `delay` node in rate-limit mode: at most
  one direction update every **20 seconds**, with the rest dropped.
- The `open` and `closed` paths use an `api-current-state` node with
  `halt_if: "opening"` / `"closing"`. In practice this can block the final
  `open`/`closed` update, because the status is usually already
  `opening`/`closing` when movement finishes.

## How this script differs

| | Node-RED flow | This script |
| --- | --- | --- |
| Input | HA binary sensor, ON transitions | `input:0`, every state change |
| Measurement | ms between ON messages | ms between ON transitions |
| Closing | 300-700 ms | 300-700 ms (with 20 ms slack) |
| Opening | 800-1200 ms | 800-1200 ms (with 20 ms slack) |
| Direction updates | max one per 20 s | immediate |
| Fully open | ON for 5 s | ON stable for 4.5 s |
| Fully closed | OFF for 5 s | OFF stable for 5 s |
| Final-state guard | `halt_if` current status | stable input level |
| Output | HA `sensor.hek_status` | Home Assistant REST API |

The 4.5 s open confirmation is a safety margin. If the open level is a pulse of
about 5 s, checking at exactly 5 s can miss it.

## How it works

- `input:0` is configured as a **switch** at startup.
- A status handler records state changes as they happen.
- A 20 ms poll reads the input directly. This is important: the Input component
  rate-limits change notifications (80 per 60 seconds), while a status read is
  not rate-limited. The poll guarantees that every level change is seen even
  when notifications are throttled.
- On every transition the script records the time. When the transition is to
  `openLevel`, it computes the time since the previous transition to
  `openLevel`. That is the ON-to-ON interval.
- The interval is classified every `sampleMs` (250 ms).
- A missed ON edge doubles one interval. While closing, a doubled interval
  (about 2 x 560 = 1120 ms) falls into the opening range, which used to make
  the direction flip between `closing` and `opening` every other interval.
  The script now ignores a long interval when it is about twice the last
  closing interval and immediately follows one, and it needs
  `reversalConfirmIntervals` consecutive intervals to reverse an already
  active direction. Starting a movement from idle is still reported on the
  first interval.
- When the alternating signal stops, the input level gives the final position:
  - **Fully open:** the input holds its ON level. After `openConfirmMs`
    (4.5 s) with no edges, the script reports `open`.
  - **Fully closed:** the input stays OFF. After `closedConfirmMs` (5 s) with
    no edges, the script reports `closed`.

No COUNT IN input, jumper or extra hardware is used.

## Device setup

1. Wire the gate signal to **IN1 / INPUT 0**. The input is active-low on the
   Plus Uni (triggered below about 1.5 V). Do not connect 12/24 V or mains
   directly; use an optocoupler or level shifter if needed.
2. In the Shelly web UI, open **Settings -> Inputs** and set IN1 / Input 1 to
   **Switch** and enable it. The script also tries to set this automatically.
3. Create a **Long-Lived Access Token** in Home Assistant (Profile → Long-Lived Access Tokens) and add it to `CONFIG.haToken` in the script.
4. Create a new script, paste `gate_frequency_mqtt.js`, save and start it.
5. Enable **Run on startup** in the script list so it survives reboots.
6. Open the script console. The log should say:

   ```
   gate: measuring ON-to-ON interval on input:0
   gate: closing 300-700 ms, opening 800-1200 ms, openLevel=true
   gate: input:0 configured as switch
   ```

If the log says a reboot is required after the input type change, reboot once.

## Home Assistant

The script updates a single sensor via the Home Assistant REST API:

- Entity: `CONFIG.haStateEntity` (default: `sensor.gate_state`)
- State values: `unknown`, `opening`, `closing`, `open`, `closed`
- Attributes: `motion`, `interval_ms`, `last_direction`, `source`, `updated_at`

The sensor is created/updated automatically by Home Assistant when the script posts to `/api/states/`. You can add it to your dashboard as-is.

## Configuration

All settings are at the top of the script:

| Setting | Meaning |
| --- | --- |
| `inputId` | Input component id (0 = IN1) |
| `inputType` | Must be `switch`; the script sets it at startup |
| `openLevel` | Input `state` value that means fully open (default `true`) |
| `pollMs` | Input poll interval (20 ms) |
| `sampleMs` | How often the interval and level are evaluated (250 ms) |
| `closingMinMs` / `closingMaxMs` | Closing interval range (300-700 ms) |
| `openingMinMs` / `openingMaxMs` | Opening interval range (800-1200 ms) |
| `rangeSlackMs` | Tolerance around the range edges (20 ms) |
| `idleIntervalMs` | Intervals longer than this are not movement (2000 ms) |
| `confirmIntervals` | Intervals needed to start a direction from idle (1) |
| `reversalConfirmIntervals` | Consecutive intervals needed to reverse an active direction (2) |
| `openConfirmMs` | Stable ON time before latching `open` (4500 ms) |
| `closedConfirmMs` | Stable OFF time before latching `closed` (5000 ms) |
| `haUrl` | Home Assistant base URL |
| `haToken` | Long-Lived Access Token from HA |
| `haStateEntity` | Entity ID to update (default: `sensor.gate_state`) |

## Calibrating the ranges

The ranges come from the Node-RED flow, but the Shelly reads the input directly
while the flow went through Home Assistant. Those two paths can differ.

1. Open and close the gate fully and watch the interval in the script console or HA attributes.
2. Note the typical interval while closing and while opening.
3. Put those ranges into `closingMinMs/MaxMs` and `openingMinMs/MaxMs`.

If the values are consistently about **half or double** the Node-RED values, the
old flow may have missed edges (for example because Home Assistant could not
keep up). Trust the Shelly measurement and adjust the ranges. The old flow's
300-700/800-1200 values are a starting point, not a calibration.

If opening and closing are swapped, either swap the ranges or swap the
`setState` labels in `handleSample`.

## Position detection

`openLevel` is the `state` value that means ON (default `true`). If your input
is inverted and `open`/`closed` are swapped, set `openLevel` to `false`. You can
also set the **Invert** option in the input settings instead.

The last stable state is stored with `Script.storage` and restored after a
reboot. A reboot during movement restores `unknown` until the next movement or
until the input level has been stable long enough.

If the gate is stopped mid-travel and the signal stops at a level, the script
will eventually report `open` or `closed` based on that level. The Node-RED flow
behaves the same way (ON for 5 s = open, OFF for 5 s = closed).

## Home Assistant example

The script updates the entity directly via REST API, so no MQTT configuration is needed. You can add it to Lovelace as a sensor card:

```yaml
type: entity
entity: sensor.gate_state
name: Gate
icon: mdi:gate
``` 

The motion, interval, and direction are available as attributes on the sensor.

## Troubleshooting

**`input:0 has no state; it must be type 'switch'`**

The input is in Button mode, or it is disabled. Set IN1 / Input 1 to **Switch**
and enable it in **Settings -> Inputs**.

**State stays on `opening` or `closing` after the gate stops**

- The final level must be stable for `openConfirmMs`/`closedConfirmMs`.
- If the gate stops mid-travel, the input may not settle at the open or closed
  level. This is a limitation of level-based position feedback.
- Check that the input is still receiving edges or noise.

**The interval is about double what you expect**

One transition was missed, or the signal does not return to the idle level
between pulses. The script measures ON-to-ON, so a missing ON pulse doubles the
interval. Check the wiring and the pulse shape.

**State stays on `opening` or `closing` after the gate stops**

- The final level must be stable for `openConfirmMs`/`closedConfirmMs`.
- If the gate stops mid-travel, the input may not settle at the open or closed
  level. This is a limitation of level-based position feedback.
- Check that the input is still receiving edges or noise.

**`open` and `closed` are swapped**

Set `openLevel` to the opposite value, or enable **Invert** in the input
settings.

**Direction is swapped (`opening` when closing)**

Swap the two ranges in `CONFIG`, or swap the state labels.

**Direction flips between `opening` and `closing` while the gate moves one way**

One ON edge was missed, so a single interval is about twice as long. During
closing this doubled value (about 1120 ms) lands in the opening range. The
script now logs `ignoring doubled interval ...` and keeps the current
direction. If the flips still happen:

- Check the interval values in the console/logs. A clean closing movement should repeat one value
  (for example 540-580 ms). If it alternates between that value and roughly
  twice it, the input is still losing edges.
- `pulse_ms` is how long the open level lasts and `gap_ms` is the rest of the period. If `pulse_ms` is short compared with
  `pollMs`, the poll can step over it.
- Reduce `pollMs` (20 ms) or improve the signal: a short ON pulse, a bad ground
  reference or a slow optocoupler can make the input miss transitions.
- If the ON pulse is very short, the input may need a hardware pulse stretcher
  (for example a retriggerable monostable or a small RC filter and Schmitt
  trigger).

**No updates to Home Assistant**

- Check that `haToken` is set correctly.
- Check that `haUrl` is reachable from the Shelly device.
- Look in the script console for HTTP errors.
- Ensure the entity name in `haStateEntity` is valid. Home Assistant will create it on first POST.

**Nothing works or the script stops**

The Shelly script engine aborts on uncaught runtime errors. Check the script
console for the first error. The script avoids `Array.shift()`, `Date`, and
deeply nested callbacks because they are unavailable or risky on older mJS
firmware.
