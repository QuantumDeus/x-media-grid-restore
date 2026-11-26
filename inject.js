(() => {
  "use strict";

  if (window.__X_MEDIA_GRID_RESTORE__) return;

  const VERSION = "0.2.2";
  const STATE_NAME = "__INITIAL_STATE__";
  const SETTINGS_PATH = "/1.1/help/settings.json";
  const RETRYABLE_STATUSES = new Set([502, 503, 504]);
  const RETRY_DELAYS_MS = [250, 750];
  const BOOTSTRAP_WINDOW_MS = 15000;
  const MAX_EVENTS = 80;
  const MAX_ERRORS = 20;
  const MAX_CONSOLE_MESSAGES_PER_LEVEL = 30;
  const LOG_PREFIX = "[X Media Grid Restore]";
  const consoleMessages = { info: 0, warn: 0, error: 0 };
  const FLAG_NAMES = [
    "responsive_web_profile_redesign_enabled",
    "rweb_media_carousel_enabled"
  ];

  // Local diagnostics only: never record page state, URLs, headers or response bodies.
  const diagnostics = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    flagsPatched: 0,
    stateAssignments: 0,
    stateDefinitions: 0,
    settingsAttempts: 0,
    settingsRetries: 0,
    lastSettingsStatus: null,
    lastError: null,
    bootstrap: {
      phase: "initializing",
      stateHook: "not-installed",
      settingsHook: "not-installed",
      stateObjectsSeen: 0,
      featureSwitchSeen: false,
      lastStateSource: null,
      completedAt: null,
      definitionHooksRestored: null,
      result: "pending"
    },
    flags: Object.fromEntries(FLAG_NAMES.map(name => [name, {
      seen: false,
      patches: 0,
      failedWrites: 0,
      lastObserved: null,
      locations: []
    }])),
    settings: { result: "not-requested", lastAttempt: null },
    errorCount: 0,
    errors: [],
    events: [],
    droppedEvents: 0,
    droppedErrors: 0,
    suppressedConsoleMessages: { info: 0, warn: 0, error: 0 }
  };

  Object.defineProperty(window, "__X_MEDIA_GRID_RESTORE__", {
    configurable: false,
    enumerable: false,
    value: diagnostics,
    writable: false
  });

  function timestamp() {
    return new Date().toISOString();
  }

  function pushBounded(list, item, limit, droppedKey) {
    if (list.length >= limit) {
      list.shift();
      diagnostics[droppedKey] += 1;
    }
    list.push(item);
  }

  function writeConsole(level, code, details) {
    // Separate budgets prevent routine INFO traffic from hiding warnings/errors.
    // Always show the single bootstrap summary, even if its budget is exhausted.
    try {
      const limitReached = consoleMessages[level] >= MAX_CONSOLE_MESSAGES_PER_LEVEL;
      if (limitReached && code !== "BOOTSTRAP_COMPLETED") {
        diagnostics.suppressedConsoleMessages[level] += 1;
        return;
      }
      consoleMessages[level] += 1;
      console[level](`${LOG_PREFIX} ${code}`, details);
      if (consoleMessages[level] === MAX_CONSOLE_MESSAGES_PER_LEVEL) {
        console[level](`${LOG_PREFIX} ${level.toUpperCase()} console limit reached; inspect window.__X_MEDIA_GRID_RESTORE__ for further diagnostics.`);
      }
    } catch {
      // Console output is optional and must never interrupt the extension.
    }
  }

  function recordEvent(level, code, stage, details = {}) {
    const entry = { at: timestamp(), level, code, stage, ...details };
    pushBounded(diagnostics.events, entry, MAX_EVENTS, "droppedEvents");
    // Errors are printed once by recordError with their full diagnostic details.
    if (level === "info" || level === "warn") writeConsole(level, code, entry);
  }

  // Use fixed messages and standard error types rather than raw exceptions, which
  // may include private URLs or page data. Keep only our own source coordinates.
  function describeError(error) {
    let type = "Error";
    let frames = [];
    try {
      const standardTypes = ["Error", "TypeError", "ReferenceError", "RangeError",
        "SyntaxError", "URIError", "EvalError", "AbortError", "NetworkError",
        "SecurityError", "InvalidStateError", "NotAllowedError", "TimeoutError"];
      if (standardTypes.includes(error?.name)) type = error.name;
      if (typeof error?.stack === "string") {
        frames = [...error.stack.matchAll(/(?:chrome-extension|moz-extension):\/\/[^\s)]+\/inject\.js:(\d+):(\d+)/g)]
          .slice(0, 5).map(match => `inject.js:${match[1]}:${match[2]}`);
      }
    } catch {
      // Diagnostics must not depend on being able to inspect a thrown value.
    }
    return { type, frames };
  }

  function recordError(stage, code, message, error, details = {}) {
    const entry = {
      at: timestamp(), stage, code, message, ...describeError(error), ...details
    };
    diagnostics.lastError = message;
    diagnostics.errorCount += 1;
    pushBounded(diagnostics.errors, entry, MAX_ERRORS, "droppedErrors");
    recordEvent("error", code, stage, details);
    writeConsole("error", code, entry);
  }

  function summarizeValue(value) {
    return typeof value === "boolean" ? value : value === undefined ? "undefined" :
      value === null ? "null" : `non-boolean:${typeof value}`;
  }

  function updateBootstrapResult() {
    const boot = diagnostics.bootstrap;
    const flags = Object.values(diagnostics.flags);
    if (!boot.stateObjectsSeen) boot.result = "state-not-observed";
    else if (!boot.featureSwitchSeen) boot.result = "feature-switch-not-observed";
    else if (flags.every(flag => !flag.seen)) boot.result = "flags-not-observed";
    else if (flags.some(flag => flag.failedWrites || flag.lastObserved === true ||
        (flag.seen && flag.lastObserved !== false))) boot.result = "flag-write-or-value-issue";
    else if (flags.some(flag => !flag.seen)) boot.result = "partial-flags-observed";
    else boot.result = "both-flags-observed-disabled";
  }

  function patchFlagContainer(container, path, source, visited) {
    if (!container || typeof container !== "object" || visited.has(container)) return;
    visited.add(container);

    for (const flagName of FLAG_NAMES) {
      const info = diagnostics.flags[flagName];
      let flag;
      let before;
      let stage = "flag.read";
      try {
        flag = container[flagName];
        if (flag === undefined || flag === null) continue;
        info.seen = true;
        if (!info.locations.includes(path) && info.locations.length < 12) info.locations.push(path);
        if (typeof flag !== "object") {
          const observed = `unexpected-shape:${typeof flag}`;
          if (info.lastObserved !== observed) {
            recordEvent("warn", "FLAG_UNEXPECTED_SHAPE", stage, { flag: flagName, path, source, observed });
          }
          info.lastObserved = observed;
          continue;
        }
        before = flag.value;
        if (before === false) {
          if (info.lastObserved !== false) {
            recordEvent("info", "FLAG_ALREADY_DISABLED", stage, { flag: flagName, path, source });
          }
          info.lastObserved = false;
          continue;
        }
        stage = "flag.write";
        flag.value = false;
        stage = "flag.verify";
        const after = flag.value;
        info.lastObserved = summarizeValue(after);
        if (after !== false) {
          info.failedWrites += 1;
          recordError(stage, "FLAG_WRITE_NOT_RETAINED", "Flag did not retain false after assignment.", null,
            { flag: flagName, path, source, before: summarizeValue(before), after: summarizeValue(after) });
          continue;
        }
        info.patches += 1;
        diagnostics.flagsPatched += 1;
        recordEvent("info", "FLAG_PATCHED", stage,
          { flag: flagName, path, source, before: summarizeValue(before), after: false });
      } catch (error) {
        if (stage !== "flag.read") info.failedWrites += 1;
        recordError(stage, "FLAG_ACCESS_FAILED", "Unable to read, write or verify the feature flag.", error,
          { flag: flagName, path, source });
      }
    }
  }

  function disableMediaRedesign(state, source) {
    try {
      if (!state || typeof state !== "object") return state;
      const boot = diagnostics.bootstrap;
      boot.lastStateSource = source;
      if (!boot.stateObjectsSeen) recordEvent("info", "STATE_OBSERVED", "bootstrap.state", { source });
      boot.stateObjectsSeen += 1;
      const featureSwitch = state.featureSwitch;
      if (!featureSwitch || typeof featureSwitch !== "object") {
        updateBootstrapResult();
        return state;
      }
      if (!boot.featureSwitchSeen) recordEvent("info", "FEATURE_SWITCH_OBSERVED", "bootstrap.scan", { source });
      boot.featureSwitchSeen = true;
      const visited = new WeakSet();
      patchFlagContainer(featureSwitch.defaultConfig, "featureSwitch.defaultConfig", source, visited);
      patchFlagContainer(featureSwitch.user?.config, "featureSwitch.user.config", source, visited);

      // Retain the original bounded scan depth. Use index-based labels for other
      // maps to avoid exposing arbitrary keys from X's bootstrap object.
      Object.values(featureSwitch).forEach((value, index) => {
        const path = `featureSwitch.map[${index}]`;
        patchFlagContainer(value, path, source, visited);
        if (value && typeof value === "object") {
          Object.values(value).forEach((nested, nestedIndex) => {
            patchFlagContainer(nested, `${path}.map[${nestedIndex}]`, source, visited);
          });
        }
      });
    } catch (error) {
      recordError("bootstrap.scan", "STATE_SCAN_FAILED", "Unable to scan the feature-switch state.", error, { source });
    }
    updateBootstrapResult();
    return state;
  }

  function wait(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  function isSettingsRequest(input, init) {
    try {
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      if (method !== "GET") return false;
      const rawUrl = typeof input === "string" ? input : input?.url;
      if (!rawUrl) return false;
      const url = new URL(rawUrl, location.href);
      return url.pathname === SETTINGS_PATH &&
        (url.hostname === "api.x.com" || url.hostname === "api.twitter.com");
    } catch {
      // Other fetch inputs are deliberately ignored, not reported as errors.
      return false;
    }
  }

  function installSettingsRetry() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") {
      diagnostics.bootstrap.settingsHook = "unavailable";
      recordEvent("warn", "FETCH_UNAVAILABLE", "settings.install");
      return;
    }

    window.fetch = async function (...args) {
      if (!isSettingsRequest(args[0], args[1])) return Reflect.apply(nativeFetch, this, args);
      let lastResponse;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        diagnostics.settingsAttempts += 1;
        diagnostics.settings.lastAttempt = attempt + 1;
        diagnostics.settings.result = "in-progress";
        diagnostics.lastSettingsStatus = null;
        recordEvent("info", "SETTINGS_ATTEMPT", "settings.fetch", { attempt: attempt + 1 });
        try {
          lastResponse = await Reflect.apply(nativeFetch, this, args);
          diagnostics.lastSettingsStatus = lastResponse.status;
        } catch (error) {
          const signal = args[1]?.signal || args[0]?.signal;
          const aborted = !!signal?.aborted;
          const retry = attempt < RETRY_DELAYS_MS.length && !aborted;
          diagnostics.settings.result = aborted ? "aborted" : retry ? "retrying" : "network-failure";
          recordError("settings.fetch", aborted ? "SETTINGS_ABORTED" : "SETTINGS_NETWORK_FAILURE",
            aborted ? "Settings request was aborted." : "Settings fetch rejected before receiving an HTTP response.",
            error, { attempt: attempt + 1, retry });
          if (!retry) throw error;
          diagnostics.settingsRetries += 1;
          recordEvent("info", "SETTINGS_RETRY", "settings.retry", { delayMs: RETRY_DELAYS_MS[attempt] });
          await wait(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        const status = lastResponse.status;
        const retry = RETRYABLE_STATUSES.has(status) && attempt < RETRY_DELAYS_MS.length;
        recordEvent(status >= 400 ? "warn" : "info", "SETTINGS_HTTP_RESPONSE", "settings.fetch",
          { attempt: attempt + 1, status, retry });
        if (!retry) {
          diagnostics.settings.result = status >= 400 ? "http-error" : "response-received";
          if (status >= 400) recordError("settings.fetch", "SETTINGS_HTTP_ERROR",
            "Settings endpoint returned an HTTP error.", null, { status, attempt: attempt + 1 });
          return lastResponse;
        }
        diagnostics.settings.result = "retrying";
        diagnostics.settingsRetries += 1;
        recordEvent("info", "SETTINGS_RETRY", "settings.retry", { status, delayMs: RETRY_DELAYS_MS[attempt] });
        await wait(RETRY_DELAYS_MS[attempt]);
      }
      return lastResponse;
    };
    diagnostics.bootstrap.settingsHook = "installed";
    recordEvent("info", "SETTINGS_HOOK_INSTALLED", "settings.install");
  }

  function invokeStateAccessor(accessor, receiver, args, source) {
    try {
      return Reflect.apply(accessor, receiver, args);
    } catch (error) {
      recordError("bootstrap.accessor", "STATE_ACCESSOR_FAILED", "Original state accessor threw an exception.", error, { source });
      throw error;
    }
  }

  function patchStateDescriptor(descriptor, source) {
    if (!descriptor || typeof descriptor !== "object") return descriptor;
    const patched = { ...descriptor };
    if ("value" in patched) patched.value = disableMediaRedesign(patched.value, source);
    if (typeof patched.get === "function") {
      const originalGet = patched.get;
      patched.get = function () {
        return disableMediaRedesign(invokeStateAccessor(originalGet, this, [], "descriptor.get"), "descriptor.get");
      };
    }
    if (typeof patched.set === "function") {
      const originalSet = patched.set;
      patched.set = function (value) {
        diagnostics.stateAssignments += 1;
        return invokeStateAccessor(originalSet, this, [disableMediaRedesign(value, "descriptor.set")], "descriptor.set");
      };
    }
    return patched;
  }

  function installStateHook() {
    const nativeDefineProperty = Object.defineProperty;
    const nativeReflectDefineProperty = Reflect.defineProperty;
    const objectDefinePropertyWrapper = function (target, property, descriptor) {
      if (target !== window || property !== STATE_NAME) return nativeDefineProperty(target, property, descriptor);
      diagnostics.stateDefinitions += 1;
      try {
        return nativeDefineProperty(target, property, patchStateDescriptor(descriptor, "Object.defineProperty"));
      } catch (error) {
        recordError("bootstrap.define", "OBJECT_DEFINE_FAILED", "Object.defineProperty failed for the state.", error);
        throw error;
      }
    };
    const reflectDefinePropertyWrapper = function (target, property, descriptor) {
      if (target !== window || property !== STATE_NAME) return nativeReflectDefineProperty(target, property, descriptor);
      diagnostics.stateDefinitions += 1;
      try {
        const result = nativeReflectDefineProperty(target, property, patchStateDescriptor(descriptor, "Reflect.defineProperty"));
        if (!result) recordError("bootstrap.define", "REFLECT_DEFINE_REJECTED", "Reflect.defineProperty returned false for the state.", null);
        return result;
      } catch (error) {
        recordError("bootstrap.define", "REFLECT_DEFINE_FAILED", "Reflect.defineProperty failed for the state.", error);
        throw error;
      }
    };

    function restoreDefinitionHooks() {
      const restored = { object: "replaced-by-other-code", reflect: "replaced-by-other-code" };
      for (const [target, wrapper, native, key] of [
        [Object, objectDefinePropertyWrapper, nativeDefineProperty, "object"],
        [Reflect, reflectDefinePropertyWrapper, nativeReflectDefineProperty, "reflect"]
      ]) {
        try {
          if (target.defineProperty === wrapper) {
            target.defineProperty = native;
            restored[key] = target.defineProperty === native ? "restored" : "failed";
          } else if (target.defineProperty === native) restored[key] = "native";
          if (restored[key] === "failed") recordError("bootstrap.cleanup", "HOOK_RESTORE_FAILED", "Definition hook could not be restored.", null, { hook: key });
        } catch (error) {
          restored[key] = "failed";
          recordError("bootstrap.cleanup", "HOOK_RESTORE_FAILED", "Definition hook restoration threw an exception.", error, { hook: key });
        }
      }
      diagnostics.bootstrap.definitionHooksRestored = restored;
    }

    try {
      Object.defineProperty = objectDefinePropertyWrapper;
      Reflect.defineProperty = reflectDefinePropertyWrapper;
    } catch (error) {
      restoreDefinitionHooks();
      diagnostics.bootstrap.stateHook = "failed";
      recordError("bootstrap.install", "DEFINITION_HOOK_INSTALL_FAILED", "Unable to install state definition hooks.", error);
      return;
    }

    try {
      const existingDescriptor = Object.getOwnPropertyDescriptor(window, STATE_NAME);
      if (existingDescriptor && existingDescriptor.configurable === false) {
        diagnostics.bootstrap.stateHook = "existing-nonconfigurable";
        recordEvent("warn", "STATE_NONCONFIGURABLE", "bootstrap.install");
        disableMediaRedesign(window[STATE_NAME], "existing.nonconfigurable");
      } else {
        let initialState;
        const originalGet = existingDescriptor?.get;
        const originalSet = existingDescriptor?.set;
        if (existingDescriptor && "value" in existingDescriptor) {
          initialState = disableMediaRedesign(existingDescriptor.value, "existing.value");
        } else if (typeof originalGet === "function") {
          initialState = disableMediaRedesign(invokeStateAccessor(originalGet, window, [], "existing.get"), "existing.get");
        }
        nativeDefineProperty(window, STATE_NAME, {
          configurable: true,
          enumerable: existingDescriptor?.enumerable ?? true,
          get() {
            if (typeof originalGet === "function") {
              initialState = disableMediaRedesign(invokeStateAccessor(originalGet, this, [], "state.get"), "state.get");
            }
            return initialState;
          },
          set(value) {
            diagnostics.stateAssignments += 1;
            initialState = disableMediaRedesign(value, "state.set");
            if (typeof originalSet === "function") invokeStateAccessor(originalSet, this, [initialState], "state.set");
          }
        });
        diagnostics.bootstrap.stateHook = "installed";
        recordEvent("info", "STATE_HOOK_INSTALLED", "bootstrap.install");
      }
    } catch (error) {
      diagnostics.bootstrap.stateHook = "definition-hooks-only";
      recordError("bootstrap.install", "STATE_HOOK_INSTALL_FAILED", "Unable to install the direct state accessor.", error);
    }

    setTimeout(() => {
      restoreDefinitionHooks();
      try {
        disableMediaRedesign(window[STATE_NAME], "bootstrap.final-check");
      } catch (error) {
        recordError("bootstrap.cleanup", "FINAL_STATE_CHECK_FAILED", "Unable to read state during the final bootstrap check.", error);
      }
      const boot = diagnostics.bootstrap;
      boot.phase = "completed";
      boot.completedAt = timestamp();
      updateBootstrapResult();
      recordEvent(boot.result === "both-flags-observed-disabled" ? "info" : "warn",
        "BOOTSTRAP_COMPLETED", "bootstrap.cleanup", {
          result: boot.result,
          flagsPatched: diagnostics.flagsPatched,
          stateAssignments: diagnostics.stateAssignments,
          stateDefinitions: diagnostics.stateDefinitions,
          errorCount: diagnostics.errorCount,
          definitionHooksRestored: boot.definitionHooksRestored
        });
    }, BOOTSTRAP_WINDOW_MS);
  }

  recordEvent("info", "INITIALIZATION_STARTED", "init", { version: VERSION });
  try {
    installSettingsRetry();
  } catch (error) {
    diagnostics.bootstrap.settingsHook = "failed";
    recordError("settings.install", "SETTINGS_HOOK_INSTALL_FAILED", "Unable to install settings fetch hook.", error);
  }
  try {
    installStateHook();
    diagnostics.bootstrap.phase = diagnostics.bootstrap.stateHook === "failed" ? "failed" : "observing";
  } catch (error) {
    diagnostics.bootstrap.phase = "failed";
    recordError("bootstrap.install", "BOOTSTRAP_INSTALL_FAILED", "Unexpected state hook initialization failure.", error);
  }
  recordEvent("info", "INITIALIZATION_FINISHED", "init", { phase: diagnostics.bootstrap.phase });
})();
