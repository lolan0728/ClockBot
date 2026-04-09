const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright-core");
const { getSystemLocation } = require("./system-location-service");
const { DEFAULT_ATTENDANCE_URL } = require("./settings-service");
const {
  getBrowserLabel,
  getBrowserProfileState,
  sanitizeBrowserPreference
} = require("./browser-service");

const LOGIN_LABEL = "\u30ed\u30b0\u30a4\u30f3";
const CLOCK_IN_LABEL = "\u51fa\u52e4";
const CLOCK_OUT_LABEL = "\u9000\u52e4";
const LOCATION_TIMEOUT_TEXT = "\u4f4d\u7f6e\u60c5\u5831\u53d6\u5f97\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f";
const ATTENDANCE_WAIT_TIMEOUT_MS = 90000;
const PLAYWRIGHT_PROFILE_ENV = "CLOCKBOT_PLAYWRIGHT_PROFILE_DIR";
const CHROME_PROFILE_DIRECTORY_ENV = "CLOCKBOT_CHROME_PROFILE_DIRECTORY";
const WRAPPER_ROOT_DIRECTORY_NAME = "browser-profile-wrappers";
const WRAPPER_DIRECTORY_NAMES = Object.freeze({
  chrome: "chrome-daily-profile-wrapper-v2",
  edge: "edge-daily-profile-wrapper"
});
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

function findBrowserExecutable(browserPreference) {
  const envOverride = typeof process.env.CLOCKBOT_BROWSER_PATH === "string"
    ? process.env.CLOCKBOT_BROWSER_PATH.trim()
    : "";

  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  const browserState = getBrowserProfileState(browserPreference);
  if (browserState && browserState.executablePath) {
    return browserState.executablePath;
  }

  return null;
}

function getClockBotRootDirectory(baseDirectory) {
  if (typeof baseDirectory === "string" && baseDirectory.trim()) {
    return baseDirectory.trim();
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ClockBot");
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || process.cwd(), "ClockBot");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ClockBot");
}

function getSessionSnapshotDirectory(baseDirectory) {
  return path.join(getClockBotRootDirectory(baseDirectory), "browser-session-snapshots");
}

function sanitizeFileSegment(segment) {
  const sanitized = String(segment || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");

  return sanitized || "default";
}

function getSessionSnapshotPath(baseDirectory, browserPreference, profileDirectoryName, siteOrigin) {
  const origin = new URL(siteOrigin);
  return path.join(
    getSessionSnapshotDirectory(baseDirectory),
    `${sanitizeFileSegment(browserPreference)}-${sanitizeFileSegment(profileDirectoryName)}-${sanitizeFileSegment(origin.hostname)}.json`
  );
}

function normalizeStorageEntries(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return [];
  }

  return Object.entries(candidate)
    .filter(([key]) => typeof key === "string" && key)
    .map(([name, value]) => ({
      name,
      value: String(value)
    }));
}

function readSessionSnapshot(snapshotPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

    if (Array.isArray(parsed)) {
      return {
        cookies: parsed,
        localStorage: [],
        sessionStorage: []
      };
    }

    return {
      cookies: Array.isArray(parsed?.cookies) ? parsed.cookies : [],
      localStorage: Array.isArray(parsed?.localStorage)
        ? parsed.localStorage
        : normalizeStorageEntries(parsed?.localStorage),
      sessionStorage: Array.isArray(parsed?.sessionStorage)
        ? parsed.sessionStorage
        : normalizeStorageEntries(parsed?.sessionStorage)
    };
  } catch (_error) {
    return {
      cookies: [],
      localStorage: [],
      sessionStorage: []
    };
  }
}

async function restoreSessionSnapshot(context, snapshotPath, siteOrigin, log) {
  const snapshot = readSessionSnapshot(snapshotPath);
  const { cookies, localStorage, sessionStorage } = snapshot;

  if (!cookies.length && !localStorage.length && !sessionStorage.length) {
    return;
  }

  try {
    if (cookies.length) {
      await context.addCookies(cookies);
    }

    if (localStorage.length || sessionStorage.length) {
      await context.addInitScript((storageSnapshot) => {
        const applyEntries = (storage, entries) => {
          for (const entry of entries) {
            if (!entry || typeof entry.name !== "string") {
              continue;
            }

            storage.setItem(entry.name, typeof entry.value === "string" ? entry.value : String(entry.value));
          }
        };

        if (window.location.origin !== storageSnapshot.origin) {
          return;
        }

        applyEntries(window.localStorage, storageSnapshot.localStorage);
        applyEntries(window.sessionStorage, storageSnapshot.sessionStorage);
      }, {
        origin: siteOrigin,
        localStorage,
        sessionStorage
      });
    }

    log.info("Restored saved browser session state.", {
      cookieCount: cookies.length,
      localStorageCount: localStorage.length,
      sessionStorageCount: sessionStorage.length,
      siteOrigin
    });
  } catch (error) {
    log.warn("Could not restore saved browser session state.", {
      siteOrigin,
      message: error && error.message ? error.message : String(error)
    });
  }
}

async function persistSessionSnapshot(context, page, snapshotPath, siteOrigin, log, options = {}) {
  const { silent = false } = options;

  try {
    const cookies = await context.cookies([siteOrigin]);

    let localStorage = [];
    let sessionStorage = [];

    if (page && !page.isClosed() && page.url().startsWith(siteOrigin)) {
      const storageState = await page.evaluate(() => ({
        localStorage: Object.entries(window.localStorage).map(([name, value]) => ({ name, value })),
        sessionStorage: Object.entries(window.sessionStorage).map(([name, value]) => ({ name, value }))
      }));

      localStorage = Array.isArray(storageState?.localStorage) ? storageState.localStorage : [];
      sessionStorage = Array.isArray(storageState?.sessionStorage) ? storageState.sessionStorage : [];
    }

    if (!cookies.length && !localStorage.length && !sessionStorage.length) {
      return;
    }

    const serializedSnapshot = JSON.stringify({
      cookies,
      localStorage,
      sessionStorage
    }, null, 2);

    let existingSnapshot = "";
    try {
      existingSnapshot = fs.readFileSync(snapshotPath, "utf8");
    } catch (_error) {
      existingSnapshot = "";
    }

    if (serializedSnapshot === existingSnapshot) {
      return;
    }

    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, serializedSnapshot);

    if (!silent) {
      log.info("Saved browser session state for reuse.", {
        cookieCount: cookies.length,
        localStorageCount: localStorage.length,
        sessionStorageCount: sessionStorage.length,
        siteOrigin
      });
    }
  } catch (error) {
    if (!silent) {
      log.warn("Could not save browser session state.", {
        siteOrigin,
        message: error && error.message ? error.message : String(error)
      });
    }
  }
}

function startSessionStateAutoSave(context, page, snapshotPath, siteOrigin, log) {
  let stopped = false;
  let intervalId = null;
  let pendingSave = Promise.resolve();

  const queueSave = () => {
    if (stopped) {
      return pendingSave;
    }

    pendingSave = pendingSave
      .then(async () => {
        if (stopped || !page || page.isClosed()) {
          return;
        }

        await persistSessionSnapshot(context, page, snapshotPath, siteOrigin, log, { silent: true });
      })
      .catch(() => {});

    return pendingSave;
  };

  const handleDomReady = () => {
    void queueSave();
  };

  const handleFrameNavigated = (frame) => {
    if (frame === page.mainFrame()) {
      void queueSave();
    }
  };

  page.on("domcontentloaded", handleDomReady);
  page.on("load", handleDomReady);
  page.on("framenavigated", handleFrameNavigated);

  intervalId = setInterval(() => {
    void queueSave();
  }, 1000);

  if (typeof intervalId.unref === "function") {
    intervalId.unref();
  }

  return async () => {
    stopped = true;

    if (intervalId) {
      clearInterval(intervalId);
    }

    page.off("domcontentloaded", handleDomReady);
    page.off("load", handleDomReady);
    page.off("framenavigated", handleFrameNavigated);
  };
}

function copyFileIfPresent(sourcePath, destinationPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return;
  }

  fs.copyFileSync(sourcePath, destinationPath);
}

function removePathWithoutFollowingLinks(targetPath) {
  let stats;

  try {
    stats = fs.lstatSync(targetPath);
  } catch (_error) {
    return;
  }

  if (stats.isSymbolicLink()) {
    try {
      fs.rmSync(targetPath, { recursive: false, force: true });
    } catch (_error) {
      // Ignore link cleanup failures. Windows can briefly hold reparse points open.
    }
    return;
  }

  if (stats.isDirectory()) {
    try {
      for (const entry of fs.readdirSync(targetPath)) {
        removePathWithoutFollowingLinks(path.join(targetPath, entry));
      }
      fs.rmdirSync(targetPath);
    } catch (_error) {
      // Ignore locked files and partial cleanup failures.
    }
    return;
  }

  try {
    fs.unlinkSync(targetPath);
  } catch (_error) {
    // Ignore locked files and partial cleanup failures.
  }
}

function createProfileLink(linkPath, targetPath) {
  if (fs.existsSync(linkPath)) {
    removePathWithoutFollowingLinks(linkPath);
  }

  fs.symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function getWrapperRootBase(baseDirectory) {
  return path.join(getClockBotRootDirectory(baseDirectory), WRAPPER_ROOT_DIRECTORY_NAME);
}

function getPersistentWrapperRoot(baseDirectory, browserPreference) {
  const wrapperName = WRAPPER_DIRECTORY_NAMES[browserPreference] || `${browserPreference}-daily-profile-wrapper`;
  return path.join(getWrapperRootBase(baseDirectory), wrapperName);
}

function resolveRealPath(candidatePath) {
  try {
    return fs.realpathSync.native
      ? fs.realpathSync.native(candidatePath)
      : fs.realpathSync(candidatePath);
  } catch (_error) {
    return null;
  }
}

function isLinkPointingToTarget(linkPath, targetPath) {
  try {
    const stats = fs.lstatSync(linkPath);
    if (!stats.isSymbolicLink()) {
      return false;
    }

    const resolvedLinkPath = resolveRealPath(linkPath);
    const resolvedTargetPath = resolveRealPath(targetPath);

    return Boolean(
      resolvedLinkPath &&
      resolvedTargetPath &&
      path.normalize(resolvedLinkPath).toLowerCase() === path.normalize(resolvedTargetPath).toLowerCase()
    );
  } catch (_error) {
    return false;
  }
}

function ensurePersistentWrapperProfileRoot(baseDirectory, browserPreference, browserProfileState) {
  const wrapperRoot = getPersistentWrapperRoot(baseDirectory, browserPreference);

  fs.mkdirSync(wrapperRoot, { recursive: true });

  const localStatePath = path.join(wrapperRoot, "Local State");
  copyFileIfPresent(browserProfileState.localStatePath, localStatePath);

  const linkedProfilePath = path.join(wrapperRoot, browserProfileState.profileDirectoryName);
  if (fs.existsSync(linkedProfilePath) && !isLinkPointingToTarget(linkedProfilePath, browserProfileState.profilePath)) {
    removePathWithoutFollowingLinks(linkedProfilePath);
  }

  if (!fs.existsSync(linkedProfilePath)) {
    createProfileLink(linkedProfilePath, browserProfileState.profilePath);
  }

  return wrapperRoot;
}

function prepareWrapperProfileRoot(baseDirectory, browserPreference) {
  const browser = sanitizeBrowserPreference(browserPreference);
  const browserProfileState = getBrowserProfileState(browser);

  if (!browserProfileState || !browserProfileState.available || !browserProfileState.executablePath) {
    throw new Error(`Could not find ${getBrowserLabel(browser)} on this PC.`);
  }

  if (!browserProfileState.profilePath) {
    throw new Error(`Open ${browserProfileState.label} once to create your daily browser profile first.`);
  }

  const wrapperRoot = ensurePersistentWrapperProfileRoot(baseDirectory, browser, browserProfileState);

  return {
    browserLabel: browserProfileState.label,
    executablePath: browserProfileState.executablePath,
    persistentProfileRoot: wrapperRoot,
    profileDirectoryName: browserProfileState.profileDirectoryName
  };
}

function resolveProfileLaunchTarget(baseDirectory, browserPreference) {
  const envOverride = typeof process.env[PLAYWRIGHT_PROFILE_ENV] === "string"
    ? process.env[PLAYWRIGHT_PROFILE_ENV].trim()
    : "";
  const executablePath = findBrowserExecutable(browserPreference);

  if (!executablePath) {
    throw new Error(`Could not find ${getBrowserLabel(browserPreference)} on this PC.`);
  }

  if (envOverride) {
    ensureWritableDirectory(envOverride);
    return {
      browserLabel: getBrowserLabel(browserPreference),
      executablePath,
      persistentProfileRoot: envOverride,
      profileDirectoryName: null
    };
  }

  return prepareWrapperProfileRoot(baseDirectory, browserPreference);
}

function ensureWritableDirectory(directoryPath, options = {}) {
  const { throwOnFailure = true } = options;

  try {
    fs.mkdirSync(directoryPath, { recursive: true });
    const probePath = path.join(
      directoryPath,
      `.clockbot-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    fs.writeFileSync(probePath, "");
    fs.unlinkSync(probePath);
    return true;
  } catch (error) {
    if (!throwOnFailure) {
      return false;
    }

    throw error;
  }
}

function getProfileDirectoryLaunchArguments(persistentProfileRoot, profileDirectoryName) {
  const requestedProfileDirectory = typeof process.env[CHROME_PROFILE_DIRECTORY_ENV] === "string"
    ? process.env[CHROME_PROFILE_DIRECTORY_ENV].trim()
    : "";
  const resolvedProfileDirectory = requestedProfileDirectory || profileDirectoryName;

  if (!resolvedProfileDirectory) {
    return [];
  }

  const requestedProfilePath = path.join(persistentProfileRoot, resolvedProfileDirectory);
  if (!fs.existsSync(requestedProfilePath)) {
    console.warn(
      `Configured browser profile directory "${resolvedProfileDirectory}" does not exist under ${persistentProfileRoot}; ` +
      `falling back to Chromium default profile selection.`
    );
    return [];
  }

  return [`--profile-directory=${resolvedProfileDirectory}`];
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

async function performAttendanceAction({ action, credentials, attendanceUrl, browserPreference, baseDirectory, log }) {
  const attendanceTarget = resolveAttendanceTarget(attendanceUrl);
  const resolvedBrowserPreference = sanitizeBrowserPreference(browserPreference);
  const launchTarget = resolveProfileLaunchTarget(baseDirectory, resolvedBrowserPreference);
  const sessionSnapshotPath = getSessionSnapshotPath(
    baseDirectory,
    resolvedBrowserPreference,
    launchTarget.profileDirectoryName || "Default",
    attendanceTarget.siteOrigin
  );
  const launchArguments = getProfileDirectoryLaunchArguments(
    launchTarget.persistentProfileRoot,
    launchTarget.profileDirectoryName
  );

  log.info(`Launching ${launchTarget.browserLabel} with the daily browser profile.`, {
    action,
    browserPreference: resolvedBrowserPreference,
    profileDirectoryName: launchTarget.profileDirectoryName || null,
    persistentProfileRoot: launchTarget.persistentProfileRoot
  });

  const context = await chromium.launchPersistentContext(launchTarget.persistentProfileRoot, {
    executablePath: launchTarget.executablePath,
    headless: false,
    ...(launchArguments.length ? { args: launchArguments } : {})
  });
  let stopSessionStateAutoSave = async () => {};

  try {
    await context.grantPermissions(["geolocation"], { origin: attendanceTarget.siteOrigin });
    const systemLocation = await getSystemLocation(log);
    if (systemLocation) {
      await context.setGeolocation(systemLocation);
    }
    await restoreSessionSnapshot(context, sessionSnapshotPath, attendanceTarget.siteOrigin, log);
    const existingPage = context.pages()[0];
    const page = existingPage || await context.newPage();
    stopSessionStateAutoSave = startSessionStateAutoSave(
      context,
      page,
      sessionSnapshotPath,
      attendanceTarget.siteOrigin,
      log
    );
    await persistSessionSnapshot(context, page, sessionSnapshotPath, attendanceTarget.siteOrigin, log);

    log.info(`Opening IEYASU login page for ${action}.`);
    await ensureLoggedIn(page, credentials, log, attendanceTarget.loginUrl);
    await persistSessionSnapshot(context, page, sessionSnapshotPath, attendanceTarget.siteOrigin, log);

    const attendanceWaitResult = await waitForAttendanceControls(page, log, action);
    const attendanceState = attendanceWaitResult.state;
    await persistSessionSnapshot(context, page, sessionSnapshotPath, attendanceTarget.siteOrigin, log);
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

    await persistSessionSnapshot(context, page, sessionSnapshotPath, attendanceTarget.siteOrigin, log);

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
    await stopSessionStateAutoSave();
    await closeQuietly(() => context.close(), log, "browser context");
  }
}

module.exports = {
  performAttendanceAction
};
