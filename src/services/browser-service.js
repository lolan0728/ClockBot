const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_BROWSER_PREFERENCE = "chrome";
const VALID_BROWSER_PREFERENCES = new Set([
  "chrome",
  "edge"
]);

const BROWSER_LABELS = Object.freeze({
  chrome: "Chrome",
  edge: "Edge"
});

function sanitizeBrowserPreference(candidate) {
  if (typeof candidate !== "string") {
    return DEFAULT_BROWSER_PREFERENCE;
  }

  const normalized = candidate.trim().toLowerCase();
  return VALID_BROWSER_PREFERENCES.has(normalized)
    ? normalized
    : DEFAULT_BROWSER_PREFERENCE;
}

function getUserDataRoot(browserPreference) {
  const browser = sanitizeBrowserPreference(browserPreference);

  if (process.platform === "darwin") {
    return browser === "edge"
      ? path.join(os.homedir(), "Library", "Application Support", "Microsoft Edge")
      : path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }

  if (process.platform === "win32") {
    return browser === "edge"
      ? path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data")
      : path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  }

  return browser === "edge"
    ? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "microsoft-edge")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "google-chrome");
}

function getExecutableCandidates(browserPreference) {
  const browser = sanitizeBrowserPreference(browserPreference);

  if (process.platform === "darwin") {
    const homeApplications = path.join(os.homedir(), "Applications");
    if (browser === "edge") {
      return [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        path.join(homeApplications, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge")
      ];
    }

    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(homeApplications, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
    ];
  }

  if (process.platform === "win32") {
    if (browser === "edge") {
      return [
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")
      ];
    }

    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
    ];
  }

  if (browser === "edge") {
    return [
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/microsoft-edge"
    ];
  }

  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium"
  ];
}

function findExecutablePath(browserPreference) {
  return getExecutableCandidates(browserPreference).find((candidate) => (
    Boolean(candidate) && fs.existsSync(candidate)
  )) || null;
}

function getBrowserAvailability() {
  return {
    chrome: buildBrowserState("chrome"),
    edge: buildBrowserState("edge")
  };
}

function buildBrowserState(browserPreference) {
  const browser = sanitizeBrowserPreference(browserPreference);
  const executablePath = findExecutablePath(browser);
  const userDataRoot = getUserDataRoot(browser);
  const localStatePath = path.join(userDataRoot, "Local State");
  const requestedProfileDirectoryName = readLastUsedProfileDirectory(localStatePath);
  const selectedProfilePath = path.join(userDataRoot, requestedProfileDirectoryName);
  const fallbackProfilePath = path.join(userDataRoot, "Default");
  const profilePath = fs.existsSync(selectedProfilePath)
    ? selectedProfilePath
    : (fs.existsSync(fallbackProfilePath) ? fallbackProfilePath : null);

  return {
    id: browser,
    label: getBrowserLabel(browser),
    available: Boolean(executablePath),
    executablePath,
    userDataRoot,
    localStatePath,
    profileAvailable: Boolean(profilePath),
    profileDirectoryName: profilePath ? path.basename(profilePath) : requestedProfileDirectoryName,
    profilePath
  };
}

function hasAnySupportedBrowser(browserAvailability = getBrowserAvailability()) {
  return Object.values(browserAvailability).some((browser) => browser.available);
}

function getBrowserLabel(browserPreference) {
  const browser = sanitizeBrowserPreference(browserPreference);
  return BROWSER_LABELS[browser];
}

function readLastUsedProfileDirectory(localStatePath) {
  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const lastUsed = typeof localState?.profile?.last_used === "string"
      ? localState.profile.last_used.trim()
      : "";

    if (lastUsed) {
      return lastUsed;
    }
  } catch (_error) {
    // Fall back to Default when Local State is unavailable or malformed.
  }

  return "Default";
}

function getBrowserProfileState(browserPreference) {
  const browser = sanitizeBrowserPreference(browserPreference);
  const availability = getBrowserAvailability()[browser];

  if (!availability || !availability.available) {
    return null;
  }

  const profileDirectoryName = readLastUsedProfileDirectory(availability.localStatePath);
  const profilePath = availability.profilePath;
  const resolvedProfileDirectoryName = availability.profileDirectoryName || profileDirectoryName;

  return {
    ...availability,
    profileDirectoryName: resolvedProfileDirectoryName,
    profilePath
  };
}

module.exports = {
  DEFAULT_BROWSER_PREFERENCE,
  VALID_BROWSER_PREFERENCES,
  BROWSER_LABELS,
  sanitizeBrowserPreference,
  getBrowserAvailability,
  hasAnySupportedBrowser,
  getBrowserLabel,
  getBrowserProfileState
};
