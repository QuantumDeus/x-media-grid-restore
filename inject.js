(() => {
  "use strict";

  const FLAG_NAMES = [
    "responsive_web_profile_redesign_enabled",
    "rweb_media_carousel_enabled"
  ];

  function disableMediaRedesign(state) {
    const featureSwitch = state?.featureSwitch;
    const configs = [
      featureSwitch?.defaultConfig,
      featureSwitch?.user?.config
    ];

    for (const config of configs) {
      if (!config) continue;

      for (const flagName of FLAG_NAMES) {
        const flag = config[flagName];
        if (flag && typeof flag === "object") {
          flag.value = false;
        }
      }
    }

    return state;
  }

  let initialState;

  try {
    const existingDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "__INITIAL_STATE__"
    );

    if (existingDescriptor && "value" in existingDescriptor) {
      initialState = disableMediaRedesign(existingDescriptor.value);
    }

    Object.defineProperty(window, "__INITIAL_STATE__", {
      configurable: true,
      enumerable: true,
      get() {
        return initialState;
      },
      set(value) {
        initialState = disableMediaRedesign(value);
      }
    });

    Object.defineProperty(window, "__X_MEDIA_GRID_RESTORE__", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({ version: "0.1.0" }),
      writable: false
    });
  } catch {
    // Fail closed: leave X untouched if its bootstrap object cannot be patched.
  }
})();
