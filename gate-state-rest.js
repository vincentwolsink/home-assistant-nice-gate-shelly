/*
 * Shelly Plus Uni - gate state from INPUT 0 -> Home Assistant
 *
 * This replaces the Node-RED flow in flow.json.
 *
 * Measures ON-to-ON interval to detect opening/closing, and exposes
 * gate state to Home Assistant via the REST API.
 *
 * Wiring:
 *   Gate signal -> IN1 / input:0, configured as a switch.
 *   The input is active-low (triggered below 1.5 V). Do not feed 12/24 V
 *   directly into it; use an optocoupler/level shifter if necessary.
 */

var CONFIG = {
  // INPUT 0 / IN1.
  inputId: 0,

  // input:0 must be a switch so it reports state=true/false.
  inputType: "switch",

  // Input level that means "fully open". The interval is measured between
  // transitions to this level. Set to false if the input is inverted.
  openLevel: true,

  // Fallback poll interval, in milliseconds.
  pollMs: 20,

  // How often the level timers are evaluated, in milliseconds.
  sampleMs: 250,

  // ON-to-ON interval ranges, in milliseconds (same as the Node-RED flow).
  closingMinMs: 300,
  closingMaxMs: 700,
  openingMinMs: 800,
  openingMaxMs: 1200,

  // Tolerance around the range edges, in milliseconds.
  rangeSlackMs: 20,

  // Intervals longer than this are not movement.
  idleIntervalMs: 2000,

  // Consecutive intervals needed to start moving in a direction from idle.
  confirmIntervals: 1,

  // Consecutive intervals needed to reverse an already active direction.
  // A missed ON edge doubles one interval. While closing, the doubled value
  // (about 2 x 560 = 1120 ms) falls into the opening range, so a single
  // missed edge must not be allowed to flip the direction.
  reversalConfirmIntervals: 2,

  // The gate holds the open level for about 5 seconds after movement.
  // Use slightly less than 5 s so a 5 s pulse is not missed.
  openConfirmMs: 4500,

  // The closed level is steady, so it can use the full 5 s.
  closedConfirmMs: 5000,

  // Home Assistant REST API
  haUrl: "http://homeassistant.local:8123",
  haToken: "", // Long-Lived Access Token
  haStateEntity: "sensor.gate_state"
};

var state = "unknown";        // unknown|opening|closing|open|closed
var motion = "idle";          // idle|opening|closing
var lastDirection = null;     // opening|closing|null
var candidate = null;
var candidateCount = 0;
var lastIntervalMs = 0;
var lastClosingIntervalMs = 0;
var lastPulseMs = 0;          // duration of the last open-level pulse
var lastGapMs = 0;            // duration of the last non-open level
var prevRaw = null;           // class of the previous interval
var lastOnEdgeMs = -1;        // -1 = no ON edge seen yet
var levelSinceMs = 0;         // when the current input level started
var lastInputState = null;
var totalEdges = 0;
var totalIntervals = 0;
var newInterval = false;
var lastEvalMs = 0;
var lastHaPublished = "";
var haBatchTimer = null;
var haBatchPending = false;
var inputWarned = false;

function log(msg) {
  console.log("gate: " + msg);
}

function nowMs() {
  return Shelly.getUptimeMs();
}

function haPublishState(val) {
  if (!CONFIG.haToken) return;

  if (haBatchTimer !== null) {
    haBatchPending = true;
    return;
  }

  haBatchPending = true;
  haBatchTimer = Timer.set(100, false, function() {
    haBatchTimer = null;
    if (!haBatchPending) return;
    haBatchPending = false;
    haSendState();
  });
}

function haSendState() {
  if (!CONFIG.haToken) return;

  var val = state;

  if (val === lastHaPublished) {
    return;
  }

  try {
    var url = CONFIG.haUrl + "/api/states/" + CONFIG.haStateEntity;
    var body = JSON.stringify({
      state: String(val),
      attributes: {
        motion: motion,
        interval_ms: Math.round(lastIntervalMs),
        last_direction: lastDirection,
        source: "shelly_gate_script",
        updated_at: Shelly.getUptimeMs()
      }
    });

    Shelly.call(
      "HTTP.Request",
      {
        method: "POST",
        url: url,
        headers: {
          "Authorization": "Bearer " + CONFIG.haToken,
          "Content-Type": "application/json"
        },
        body: body,
        timeout: 5000
      },
      function(result, errorCode, errorMessage) {
        if (errorCode) {
          log("HA HTTP failed: " + errorCode + " " + (errorMessage || ""));
        } else {
          lastHaPublished = val;
        }
      }
    );
  } catch (e) {
    log("HA publish error: " + e);
  }
}

var haBatchTimer = null;
var haBatchPending = false;

function haQueueUpdate() {
  if (!CONFIG.haEnabled && !CONFIG.haWebhookEnabled) return;

  haBatchPending = true;

  if (haBatchTimer !== null) {
    return;
  }

  haBatchTimer = Timer.set(100, false, function() {
    haBatchTimer = null;
    if (!haBatchPending) return;
    haBatchPending = false;
    haSendBatch();
  });
}

function haSendBatch() {
  var ms = Math.round(lastIntervalMs);
  var hz = Math.round(intervalFrequency());

  if (CONFIG.haWebhookEnabled && CONFIG.haWebhookUrl) {
    try {
      var body2 = JSON.stringify({
        state: state,
        motion: motion,
        interval: ms,
        frequency: hz,
        entities: {
          state: CONFIG.haStateEntity,
          motion: CONFIG.haMotionEntity,
          interval: CONFIG.haIntervalEntity,
          frequency: CONFIG.haFrequencyEntity
        },
        source: "shelly_gate_script",
        uptime_ms: nowMs()
      });

      Shelly.call(
        "HTTP.Request",
        {
          method: "POST",
          url: CONFIG.haWebhookUrl,
          headers: {
            "Content-Type": "application/json"
          },
          body: body2,
          timeout: 5000
        },
        function(result, errorCode, errorMessage) {
          if (errorCode) {
            log("HA webhook failed: " + errorCode + " " + (errorMessage || ""));
          }
        }
      );
      return;
    } catch (e) {
      log("HA webhook error: " + e);
    }
  }

  if (CONFIG.haEnabled && CONFIG.haToken) {
    var entities = [
      { entity: CONFIG.haStateEntity, value: state },
      { entity: CONFIG.haMotionEntity, value: motion },
      { entity: CONFIG.haIntervalEntity, value: ms },
      { entity: CONFIG.haFrequencyEntity, value: hz }
    ];

    for (var i = 0; i < entities.length; i++) {
      (function(ent) {
        try {
          var url = CONFIG.haUrl + "/api/states/" + ent.entity;
          var body = JSON.stringify({
            state: String(ent.value),
            attributes: {
              source: "shelly_gate_script",
              updated_at: Shelly.getUptimeMs()
            }
          });

          Shelly.call(
            "HTTP.Request",
            {
              method: "POST",
              url: url,
              headers: {
                "Authorization": "Bearer " + CONFIG.haToken,
                "Content-Type": "application/json"
              },
              body: body,
              timeout: 5000
            },
            function(result, errorCode, errorMessage) {
              if (errorCode) {
                log("HA HTTP failed: " + errorCode + " " + (errorMessage || ""));
              }
            }
          );
        } catch (e) {
          log("HA publish error: " + e);
        }
      })(entities[i]);
    }
  }
}

function haPublish(entity, stateVal) {
  haQueueUpdate();
}

function storageGet(key) {
  try {
    if (typeof Script !== "undefined" && Script.storage) {
      return Script.storage.getItem(key);
    }
  } catch (e) {}
  return null;
}

function storageSet(key, value) {
  try {
    if (typeof Script !== "undefined" && Script.storage) {
      Script.storage.setItem(key, String(value));
    }
  } catch (e) {}
}

function restoreState() {
  var s = storageGet("gate_state");
  var d = storageGet("gate_direction");

  if (s === "open" || s === "closed" || s === "unknown") {
    state = s;
  }

  if (d === "opening" || d === "closing") {
    lastDirection = d;
  }

  log("restored state=" + state + ", direction=" + String(lastDirection));
}

function saveState() {
  storageSet("gate_state", state);
  storageSet("gate_direction", lastDirection || "");
}

function publishState(force) {
  haPublishState(state);
}

function setState(newState) {
  if (state === newState) return;

  state = newState;
  saveState();
  publishState(false);
  log("state -> " + state);
}

function setMotion(newMotion) {
  if (motion === newMotion) return;

  motion = newMotion;
  haPublishState(state);
}

function onHaConnect() {
  log("HA connected/published");
  haPublishState(state);
}

function classify(intervalMs) {
  var slack = CONFIG.rangeSlackMs > 0 ? CONFIG.rangeSlackMs : 0;

  if (intervalMs <= 0 || intervalMs > CONFIG.idleIntervalMs) {
    return "idle";
  }

  if (intervalMs >= (CONFIG.openingMinMs - slack) &&
      intervalMs <= (CONFIG.openingMaxMs + slack)) {
    return "opening";
  }

  if (intervalMs >= (CONFIG.closingMinMs - slack) &&
      intervalMs <= (CONFIG.closingMaxMs + slack)) {
    return "closing";
  }

  return "unknown";
}

function onInputState(newState) {
  if (typeof newState !== "boolean") return;

  // The first state only establishes a baseline; it is not an edge.
  if (lastInputState === null) {
    lastInputState = newState;
    return;
  }

  if (newState === lastInputState) return;

  var t = nowMs();
  var levelMs = t - levelSinceMs;
  lastInputState = newState;
  levelSinceMs = t;
  totalEdges++;

  // Measure the distance between transitions to the open level. This is the
  // same ON-to-ON interval that interval-length measured in Node-RED.
  if (newState === CONFIG.openLevel) {
    lastGapMs = levelMs;

    if (lastOnEdgeMs >= 0) {
      var ms = t - lastOnEdgeMs;

      if (ms > 0) {
        lastIntervalMs = ms > CONFIG.idleIntervalMs ? 0 : ms;
        totalIntervals++;
        newInterval = true;
      }
    }

    lastOnEdgeMs = t;
  } else {
    lastPulseMs = levelMs;
  }
}

function handleSample() {
  var t = nowMs();
  var inputOpen = lastInputState !== null &&
    lastInputState === CONFIG.openLevel;
  var levelMs = t - levelSinceMs;

  // Stable position after movement. The ON and OFF levels are held for
  // about 5 seconds at the end of travel.
  if (inputOpen && levelMs >= CONFIG.openConfirmMs) {
    if (state !== "open" || motion !== "idle") {
      candidate = null;
      candidateCount = 0;
      newInterval = false;
      lastIntervalMs = 0;
      setMotion("idle");
      lastDirection = "opening";
      setState("open");
      return;
    }
  } else if (!inputOpen && levelMs >= CONFIG.closedConfirmMs) {
    if (state !== "closed" || motion !== "idle") {
      candidate = null;
      candidateCount = 0;
      newInterval = false;
      lastIntervalMs = 0;
      setMotion("idle");
      lastDirection = "closing";
      setState("closed");
      return;
    }
  }

  // Direction comes from the ON-to-ON interval.
  if (newInterval) {
    newInterval = false;

    var raw = classify(lastIntervalMs);

    if (raw === "closing") {
      lastClosingIntervalMs = lastIntervalMs;
    }

    if (raw === "opening" || raw === "closing") {
      // A missed ON edge makes one interval twice as long. While closing, that
      // doubled value (about 2 x 560 = 1120 ms) lands in the opening range and
      // would otherwise flip the direction on every other interval.
      var doubled = raw === "opening" &&
        motion === "closing" &&
        prevRaw === "closing" &&
        lastClosingIntervalMs > 0 &&
        lastIntervalMs >= (lastClosingIntervalMs * 1.6) &&
        lastIntervalMs <= (lastClosingIntervalMs * 2.4);

      if (doubled) {
        log(
          "ignoring doubled interval " + Math.round(lastIntervalMs) +
          " ms (closing is " + Math.round(lastClosingIntervalMs) + " ms)"
        );
        candidate = null;
        candidateCount = 0;
      } else if (raw === motion) {
        // Already moving this way; nothing to confirm.
        candidate = raw;
        candidateCount = 0;
      } else {
        var needed = (motion === "idle")
          ? CONFIG.confirmIntervals
          : CONFIG.reversalConfirmIntervals;

        if (raw === candidate) {
          candidateCount++;
        } else {
          candidate = raw;
          candidateCount = 1;
        }

        if (candidateCount >= needed) {
          setMotion(raw);
          lastDirection = raw;
          setState(raw);
          log("motion " + raw + " at " + Math.round(lastIntervalMs) + " ms");
        }
      }
    } else {
      candidate = null;
      candidateCount = 0;
    }

    prevRaw = raw;
  }

  // no-op
}

function pollInput() {
  var t = nowMs();
  var evaluate = (t - lastEvalMs) >= CONFIG.sampleMs;

  if (evaluate) {
    lastEvalMs = t;
  }

  var st;

  try {
    st = Shelly.getComponentStatus("input", CONFIG.inputId);
  } catch (e) {
    if (!inputWarned) {
      log("cannot read input:" + CONFIG.inputId + " (" + e + ")");
      inputWarned = true;
    }
    return;
  }

  if (!st) {
    if (!inputWarned) {
      log("input:" + CONFIG.inputId + " is not available");
      inputWarned = true;
    }
    return;
  }

  if (typeof st.state !== "boolean") {
    if (!inputWarned) {
      log(
        "input:" + CONFIG.inputId +
        " has no state; it must be type 'switch'"
      );
      inputWarned = true;
    }
  } else {
    inputWarned = false;
    onInputState(st.state);
  }

  if (evaluate) {
    handleSample();
  }
}

function onInputConfigSet(result, errorCode, errorMessage) {
  if (errorCode) {
    log("Input.SetConfig failed (" + errorCode + "): " + errorMessage);
    return;
  }

  if (result && result.restart_required) {
    log(
      "input:" + CONFIG.inputId +
      " changed; a reboot is required"
    );
  } else {
    log(
      "input:" + CONFIG.inputId + " configured as " +
      CONFIG.inputType
    );
  }
}

function onInputConfig(cfg, errorCode, errorMessage) {
  if (errorCode || !cfg) {
    log(
      "input:" + CONFIG.inputId + " not found" +
      (errorCode ? " (" + errorMessage + ")" : "")
    );
    return;
  }

  if (cfg.type === CONFIG.inputType && cfg.enable === true) {
    log("input:" + CONFIG.inputId + " configured as " + cfg.type);
    return;
  }

  var patch = {};

  if (cfg.type !== CONFIG.inputType) {
    patch.type = CONFIG.inputType;
  }

  if (cfg.enable !== true) {
    patch.enable = true;
  }

  log("configuring input:" + CONFIG.inputId + " " + JSON.stringify(patch));

  Shelly.call(
    "Input.SetConfig",
    { id: CONFIG.inputId, config: patch },
    onInputConfigSet
  );
}

function configureInput() {
  Shelly.call("Input.GetConfig", { id: CONFIG.inputId }, onInputConfig);
}

function start() {
  var info = Shelly.getDeviceInfo();
  log("starting on " + info.app + " firmware " + (info.ver || info.fw_id));
  log("measuring ON-to-ON interval on input:" + CONFIG.inputId);
  log(
    "closing " + CONFIG.closingMinMs + "-" + CONFIG.closingMaxMs +
    " ms, opening " + CONFIG.openingMinMs + "-" + CONFIG.openingMaxMs +
    " ms, openLevel=" + CONFIG.openLevel
  );

  if (!CONFIG.haToken) {
    log("WARNING: CONFIG.haToken not set - Home Assistant updates disabled");
  } else {
    log("Home Assistant updates enabled for " + CONFIG.haStateEntity);
    haPublishState(state);
  }

  restoreState();

  // Level timing starts now, so an already-open/closed gate is reported
  // after the confirm interval instead of immediately.
  levelSinceMs = nowMs();

  // Primary edge source: input status changes.
  Shelly.addStatusHandler(function (event) {
    if (event.component !== "input:" + CONFIG.inputId) return;

    if (event.delta && typeof event.delta.state === "boolean") {
      onInputState(event.delta.state);
    }
  });

  // Let the component tree settle after boot before changing input config.
  Timer.set(2000, false, configureInput);

  // Fallback poll + periodic evaluation.
  Timer.set(CONFIG.pollMs, true, pollInput);
}

start();
