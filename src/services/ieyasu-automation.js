const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright-core");
const { getSystemLocation } = require("./system-location-service");
const { DEFAULT_ATTENDANCE_URL } = require("./settings-service");

const LOGIN_LABEL = "\u30ed\u30b0\u30a4\u30f3";
const CLOCK_IN_LABEL = "\u51fa\u52e4";
const CLOCK_OUT_LABEL = "\u9000\u52e4";
const LOCATION_TIMEOUT_TEXT = "\u4f4d\u7f6e\u60c5\u5831\u53d6\u5f97\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f";
const ATTENDANCE_WAIT_TIMEOUT_MS = 90000;
const LOGIN_CONTROL_SELECTORS = [
  "button",
  "input[type='button']",
  "input[type='submit']"
];
const ATTENDANCE_CONTROL_SELECTORS = [
  ...LOGIN_CONTROL_SELECTORS,
  "a",
  "[role='button']",
  ".btn",
  ".button",
  "[onclick]"
];

function resolveAttendanceTarget(attendanceUrl) {
  try {
    const parsed = new URL(typeof attendanceUrl === "string" && attendanceUrl.trim()
      ? attendanceUrl.trim()
      : DEFAULT_ATTENDANCE_URL);

    return {
      loginUrl: parsed.toString(),
      siteOrigin: parsed.origin
    };
  } catch (error) {
    const fallback = new URL(DEFAULT_ATTENDANCE_URL);
    return {
      loginUrl: fallback.toString(),
      siteOrigin: fallback.origin
    };
  }
}

function findBrowserExecutable() {
  const envOverride = typeof process.env.CLOCKBOT_BROWSER_PATH === "string"
    ? process.env.CLOCKBOT_BROWSER_PATH.trim()
    : "";

  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  let candidates;

  if (process.platform === "darwin") {
    const homeApplications = path.join(os.homedir(), "Applications");
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(homeApplications, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      path.join(homeApplications, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
      path.join(homeApplications, "Chromium.app", "Contents", "MacOS", "Chromium")
    ];
  } else if (process.platform === "win32") {
    candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ];
  } else {
    candidates = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/microsoft-edge",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium"
    ];
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getProfileDirectory() {
  let root;

  if (process.platform === "darwin") {
    root = path.join(os.homedir(), "Library", "Application Support");
  } else if (process.platform === "win32") {
    root = process.env.APPDATA || process.cwd();
  } else {
    root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  }

  const profileDirectory = path.join(root, "ClockBot", "automation-profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  return profileDirectory;
}

function isAlreadyClosedError(error) {
  const message = error && error.message ? error.message : "";
  return message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed");
}

function isBrowserDisconnectedError(error) {
  return isAlreadyClosedError(error);
}

async function closeQuietly(closeOperation, log, scope) {
  try {
    await closeOperation();
  } catch (error) {
    if (!isAlreadyClosedError(error)) {
      log.warn(`Ignored cleanup error while closing ${scope}.`, {
        message: error && error.message ? error.message : String(error)
      });
    }
  }
}

async function findFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count();

    if (count < 1) {
      continue;
    }

    try {
      if (await locator.isVisible()) {
        return locator;
      }
    } catch (error) {
      // Ignore invalid or detached locators and continue searching.
    }
  }

  return null;
}

async function clickVisibleControlByText(page, texts) {
  return page.evaluate(({ buttonTexts, selectors }) => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
    const target = nodes.find((node) => {
      if (!isVisible(node)) {
        return false;
      }

      const text = (node.innerText || node.value || "").trim();
      return buttonTexts.some((candidate) => text.includes(candidate));
    });

    if (!target) {
      return false;
    }

    target.click();
    return true;
  }, {
    buttonTexts: texts,
    selectors: LOGIN_CONTROL_SELECTORS
  });
}

async function hasVisibleControlByText(page, texts) {
  return page.evaluate(({ buttonTexts, selectors }) => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    return Array.from(document.querySelectorAll(selectors.join(","))).some((node) => {
      if (!isVisible(node)) {
        return false;
      }

      const text = (node.innerText || node.value || "").trim();
      return buttonTexts.some((candidate) => text.includes(candidate));
    });
  }, {
    buttonTexts: texts,
    selectors: LOGIN_CONTROL_SELECTORS
  });
}

async function getVisibleControlTexts(page) {
  try {
    return await page.evaluate((selectors) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      return Array.from(document.querySelectorAll(selectors.join(",")))
        .filter((node) => isVisible(node))
        .map((node) => (node.innerText || node.value || "").trim())
        .filter(Boolean)
        .slice(0, 20);
    }, LOGIN_CONTROL_SELECTORS);
  } catch (error) {
    return [];
  }
}

async function getVisibleInteractiveControls(page) {
  try {
    return await page.evaluate((selectors) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const normalizeText = (text) => text.replace(/\s+/g, " ").trim();

      return Array.from(document.querySelectorAll(selectors.join(",")))
        .filter((node) => isVisible(node))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return {
            text: normalizeText(node.innerText || node.value || ""),
            tagName: node.tagName,
            className: node.className || "",
            disabled: Boolean(node.disabled),
            area: Math.round(rect.width * rect.height),
            backgroundColor: style.backgroundColor,
            color: style.color,
            borderColor: style.borderColor
          };
        })
        .filter((node) => node.text);
    }, ATTENDANCE_CONTROL_SELECTORS);
  } catch (error) {
    return [];
  }
}

async function getPageText(page) {
  try {
    return await page.evaluate(() => document.body ? document.body.innerText : "");
  } catch (error) {
    return "";
  }
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseCssColor(value) {
  const match = String(value || "").match(/rgba?\(([^)]+)\)/i);

  if (!match) {
    return null;
  }

  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  const [r, g, b, a = 1] = parts;

  if ([r, g, b, a].some((part) => Number.isNaN(part))) {
    return null;
  }

  return { r, g, b, a };
}

function getRelativeLuminance(color) {
  const transform = (channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return (0.2126 * transform(color.r)) +
    (0.7152 * transform(color.g)) +
    (0.0722 * transform(color.b));
}

function getFilledScore(button) {
  if (!button) {
    return -1;
  }

  const background = parseCssColor(button.backgroundColor);
  const foreground = parseCssColor(button.color);

  if (!background || !foreground) {
    return -1;
  }

  const backgroundLuminance = getRelativeLuminance(background);
  const foregroundLuminance = getRelativeLuminance(foreground);
  return (1 - backgroundLuminance) + foregroundLuminance + (background.a * 0.25);
}

function classifyButtonVisualState(button) {
  if (!button) {
    return "missing";
  }

  const background = parseCssColor(button.backgroundColor);
  const foreground = parseCssColor(button.color);

  if (!background || !foreground) {
    return "unknown";
  }

  const backgroundLuminance = getRelativeLuminance(background);
  const foregroundLuminance = getRelativeLuminance(foreground);

  if (backgroundLuminance > 0.82 && foregroundLuminance < 0.35) {
    return "inactive";
  }

  if (backgroundLuminance < 0.55 && foregroundLuminance > 0.72) {
    return "active";
  }

  return "unknown";
}

function selectAttendanceButton(controls, label) {
  const normalizedLabel = normalizeText(label);
  const candidates = controls.filter((control) => normalizeText(control.text).includes(normalizedLabel));

  if (!candidates.length) {
    return null;
  }

  const exactMatch = candidates
    .filter((control) => normalizeText(control.text) === normalizedLabel)
    .sort((left, right) => right.area - left.area)[0];

  if (exactMatch) {
    return exactMatch;
  }

  return candidates.sort((left, right) => right.area - left.area)[0];
}

function summarizeButtonState(button, state) {
  if (!button) {
    return {
      label: null,
      state: "missing"
    };
  }

  return {
    label: button.text,
    state,
    backgroundColor: button.backgroundColor,
    color: button.color,
    borderColor: button.borderColor
  };
}

function isResolvedButtonState(button) {
  return Boolean(button) &&
    button.state !== "missing" &&
    button.state !== "unknown";
}

function areAttendanceButtonsVisible(state) {
  return state.clockIn.state !== "missing" &&
    state.clockOut.state !== "missing";
}

function isAttendanceStateActionable(state, action) {
  const targetButton = action === "clockIn" ? state.clockIn : state.clockOut;
  return areAttendanceButtonsVisible(state) && isResolvedButtonState(targetButton);
}

function resolveAttendanceButtons(controls) {
  const clockInButton = selectAttendanceButton(controls, CLOCK_IN_LABEL);
  const clockOutButton = selectAttendanceButton(controls, CLOCK_OUT_LABEL);
  let clockInState = classifyButtonVisualState(clockInButton);
  let clockOutState = classifyButtonVisualState(clockOutButton);

  if (clockInButton && clockOutButton && (clockInState === "unknown" || clockOutState === "unknown")) {
    const clockInScore = getFilledScore(clockInButton);
    const clockOutScore = getFilledScore(clockOutButton);

    if (clockInScore >= 0 && clockOutScore >= 0 && Math.abs(clockInScore - clockOutScore) > 0.35) {
      if (clockInScore > clockOutScore) {
        clockInState = "active";
        if (clockOutState === "unknown") {
          clockOutState = "inactive";
        }
      } else {
        clockOutState = "active";
        if (clockInState === "unknown") {
          clockInState = "inactive";
        }
      }
    }
  }

  return {
    visibleControls: controls.map((control) => control.text),
    clockIn: summarizeButtonState(clockInButton, clockInState),
    clockOut: summarizeButtonState(clockOutButton, clockOutState)
  };
}

async function getAttendanceButtonState(page) {
  const controls = await getVisibleInteractiveControls(page);
  return resolveAttendanceButtons(controls);
}

async function clickAttendanceButton(page, action) {
  const label = action === "clockIn" ? CLOCK_IN_LABEL : CLOCK_OUT_LABEL;

  try {
    return await page.evaluate(({ selectors, targetLabel }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const normalizeText = (text) => text.replace(/\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
        .filter((node) => isVisible(node))
        .filter((node) => normalizeText(node.innerText || node.value || "").includes(targetLabel))
        .sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
        });

      const target = candidates[0];
      if (!target) {
        return false;
      }

      target.click();
      return true;
    }, {
      selectors: ATTENDANCE_CONTROL_SELECTORS,
      targetLabel: label
    });
  } catch (error) {
    return false;
  }
}

async function waitForPostPunchState(page, action, log) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15000) {
    const state = await getAttendanceButtonState(page);

    if (action === "clockIn" &&
      state.clockIn.state === "inactive" &&
      state.clockOut.state === "active") {
      return state;
    }

    if (action === "clockOut" &&
      state.clockOut.state === "inactive" &&
      state.clockIn.state === "active") {
      return state;
    }

    await page.waitForTimeout(1000);
  }

  const state = await getAttendanceButtonState(page);
  log.warn("Attendance state did not transition after click.", {
    action,
    url: page.url(),
    buttonStateAfterClick: state
  });
  return null;
}

async function waitForAttendanceControls(page, log, action) {
  const startedAt = Date.now();
  let locationTimeoutObserved = false;
  let unresolvedButtonsLogged = false;
  let lastState = null;

  while (Date.now() - startedAt < ATTENDANCE_WAIT_TIMEOUT_MS) {
    const state = await getAttendanceButtonState(page);
    lastState = state;

    if (isAttendanceStateActionable(state, action)) {
      if (locationTimeoutObserved) {
        log.info("Attendance buttons became available after the page reported a location timeout.", {
          action,
          url: page.url(),
          buttonState: state
        });
      }

      return {
        state,
        locationTimeoutObserved,
        timedOut: false
      };
    }

    if (!unresolvedButtonsLogged &&
      areAttendanceButtonsVisible(state) &&
      !isAttendanceStateActionable(state, action)) {
      unresolvedButtonsLogged = true;
      log.warn("Attendance labels are visible, but their clickable state could not be resolved yet.", {
        action,
        url: page.url(),
        buttonState: state
      });
    }

    const pageText = await getPageText(page);
    if (!locationTimeoutObserved && pageText.includes(LOCATION_TIMEOUT_TEXT)) {
      locationTimeoutObserved = true;
      log.warn("The attendance page reported a location timeout, but ClockBot will keep waiting for the buttons to appear.", {
        action,
        url: page.url()
      });
    }

    await page.waitForTimeout(1000);
  }

  const state = lastState || await getAttendanceButtonState(page);
  log.warn("Attendance buttons did not become actionable before timeout.", {
    action,
    url: page.url(),
    buttonState: state,
    timeoutMs: ATTENDANCE_WAIT_TIMEOUT_MS,
    locationTimeoutObserved
  });

  return {
    state,
    locationTimeoutObserved,
    timedOut: true
  };
}

async function waitForLoginResult(page) {
  try {
    await Promise.race([
      page.waitForLoadState("networkidle", { timeout: 15000 }),
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 })
    ]);
  } catch (error) {
    // Some navigation paths do not complete with full network idle; fall through.
  }

  await page.waitForTimeout(1000);
}

async function readPotentialErrorMessage(page) {
  const candidates = [
    ".alert",
    ".error",
    ".flash",
    ".notice",
    ".validation-errors"
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();

    try {
      if (await locator.isVisible()) {
        const text = (await locator.innerText()).trim();
        if (text) {
          return text;
        }
      }
    } catch (error) {
      // Keep searching.
    }
  }

  return null;
}

async function ensureLoggedIn(page, credentials, log, loginUrl) {
  await page.goto(loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  const usernameField = await findFirstVisible(page, [
    "input[name='login_id']",
    "input[name='employee_code']",
    "input[name='email']",
    "input[type='email']",
    "input[type='text']"
  ]);

  const passwordField = await findFirstVisible(page, [
    "input[name='password']",
    "input[type='password']"
  ]);

  if (!usernameField || !passwordField) {
    log.info("Login form not found, assuming an existing session is already active.", {
      url: page.url(),
      visibleControls: await getVisibleControlTexts(page)
    });
    return;
  }

  await usernameField.fill(credentials.username);
  await passwordField.fill(credentials.password);

  const loginClicked = await clickVisibleControlByText(page, [LOGIN_LABEL, "Login"]);
  if (!loginClicked) {
    throw new Error("Could not find the login button.");
  }

  await waitForLoginResult(page);

  if (await hasVisibleControlByText(page, [LOGIN_LABEL, "Login"])) {
    const errorMessage = await readPotentialErrorMessage(page);
    throw new Error(errorMessage || "Login did not complete successfully.");
  }
}

async function performAttendanceAction({ action, credentials, attendanceUrl, log }) {
  const executablePath = findBrowserExecutable();

  if (!executablePath) {
    throw new Error("Could not find a local Chrome, Edge, or Chromium installation.");
  }

  const attendanceTarget = resolveAttendanceTarget(attendanceUrl);
  const context = await chromium.launchPersistentContext(getProfileDirectory(), {
    executablePath,
    headless: false
  });

  try {
    await context.grantPermissions(["geolocation"], { origin: attendanceTarget.siteOrigin });
    const systemLocation = await getSystemLocation(log);
    if (systemLocation) {
      await context.setGeolocation(systemLocation);
    }
    const existingPage = context.pages()[0];
    const page = existingPage || await context.newPage();

    log.info(`Opening IEYASU login page for ${action}.`);
    await ensureLoggedIn(page, credentials, log, attendanceTarget.loginUrl);

    const attendanceWaitResult = await waitForAttendanceControls(page, log, action);
    const attendanceState = attendanceWaitResult.state;
    log.info(`Login flow reached ${page.url()}.`, {
      action,
      visibleControls: attendanceState.visibleControls,
      locationTimeoutObserved: attendanceWaitResult.locationTimeoutObserved
    });

    if (attendanceWaitResult.timedOut && !isAttendanceStateActionable(attendanceState, action)) {
      throw new Error(attendanceWaitResult.locationTimeoutObserved
        ? "The attendance buttons did not become available even though the page finished with a location timeout message."
        : "The attendance buttons did not become available before the timeout.");
    }

    if (action === "clockIn" &&
      attendanceState.clockIn.state === "inactive" &&
      attendanceState.clockOut.state === "active") {
      return {
        status: "Skipped",
        message: "Clock In appears to have been completed already."
      };
    }

    if (action === "clockOut" &&
      attendanceState.clockOut.state === "inactive" &&
      attendanceState.clockIn.state === "active") {
      return {
        status: "Skipped",
        message: "Clock Out is not available because the page is already back to Clock In."
      };
    }

    const targetState = action === "clockIn" ? attendanceState.clockIn.state : attendanceState.clockOut.state;
    if (targetState !== "active") {
      log.warn("Target action button is present but not in the active visual state.", {
        action,
        url: page.url(),
        buttonState: attendanceState
      });
      throw new Error(`The ${action} button is not currently active.`);
    }

    const actionClicked = await clickAttendanceButton(page, action);

    if (!actionClicked) {
      log.warn("Target action button was not found after login.", {
        action,
        url: page.url(),
        buttonState: attendanceState
      });
      throw new Error(`Could not find the ${action} button after login.`);
    }

    log.info(`Clicked ${action} control and waiting for a real state transition.`, {
      action,
      buttonStateBeforeClick: attendanceState
    });

    const confirmed = await waitForPostPunchState(page, action, log);

    if (!confirmed) {
      throw new Error(`The ${action} action did not produce a confirmed state change.`);
    }

    return {
      status: "Success",
      message: action === "clockIn" ? "Clock In completed successfully." : "Clock Out completed successfully."
    };
  } catch (error) {
    if (isBrowserDisconnectedError(error)) {
      throw new Error("The automation browser was closed before the attendance flow finished.");
    }

    throw error;
  } finally {
    await closeQuietly(() => context.close(), log, "browser context");
  }
}

module.exports = {
  performAttendanceAction
};
