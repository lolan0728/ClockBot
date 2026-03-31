const path = require("path");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  Notification,
  screen
} = require("electron");

const {
  DEFAULT_AUTOMATION_ENGINE,
  SettingsService,
  sanitizePadConfig
} = require("./services/settings-service");
const { CredentialsService } = require("./services/credentials-service");
const { LogService } = require("./services/log-service");
const { SchedulerService, toDateKey } = require("./services/scheduler-service");
const { PunchService } = require("./services/punch-service");
const { getPadConfigError, isPadAvailable } = require("./services/pad-automation");

const ACTION_LABELS = {
  clockIn: "Clock In",
  clockOut: "Clock Out"
};
const WINDOW_ICON_PATH = path.join(__dirname, "assets", "icon.ico");
const TRAY_ICON_PATH = path.join(__dirname, "assets", "tray-icon.png");
const TRAY_MENU_SHOW_WINDOW_ICON_PATH = path.join(__dirname, "assets", "tray-menu-show-window.png");
const TRAY_MENU_START_ICON_PATH = path.join(__dirname, "assets", "tray-menu-start.png");
const TRAY_MENU_START_DISABLED_ICON_PATH = path.join(__dirname, "assets", "tray-menu-start-disabled.png");
const TRAY_MENU_STOP_ICON_PATH = path.join(__dirname, "assets", "tray-menu-stop.png");
const TRAY_MENU_STOP_DISABLED_ICON_PATH = path.join(__dirname, "assets", "tray-menu-stop-disabled.png");
const TRAY_MENU_QUIT_ICON_PATH = path.join(__dirname, "assets", "tray-menu-quit.png");

let mainWindow = null;
let logWindow = null;
let tray = null;
let settingsService = null;
let credentialsService = null;
let logService = null;
let schedulerService = null;
let punchService = null;
let runtimeCredentials = null;
let savedCredentials = null;
let draftCredentials = {
  username: "",
  password: ""
};
let isQuitting = false;
let isRunning = false;
let latestRun = null;
let latestPadProgress = null;
let monitoringStartedAt = null;
let monitoringEnabled = false;
let dailyState = createDailyState();
const TRAY_MENU_ICONS = Object.freeze({
  showWindow: loadTrayMenuIcon(TRAY_MENU_SHOW_WINDOW_ICON_PATH, `
    <rect x="2.5" y="3.5" width="11" height="8.5" rx="1.5" />
    <path d="M2.5 5.5h11" />
  `),
  startMonitoring: loadTrayMenuIcon(TRAY_MENU_START_ICON_PATH, `
    <path d="M5 3.75 12 8 5 12.25Z" fill="rgba(255,255,255,0.92)" stroke="none" />
  `),
  startMonitoringDisabled: loadTrayMenuIcon(TRAY_MENU_START_DISABLED_ICON_PATH, `
    <path d="M5 3.75 12 8 5 12.25Z" fill="rgba(145,154,163,0.96)" stroke="none" />
  `),
  stopMonitoring: loadTrayMenuIcon(TRAY_MENU_STOP_ICON_PATH, `
    <rect x="4" y="4" width="8" height="8" rx="1.4" fill="rgba(255,255,255,0.92)" stroke="none" />
  `),
  stopMonitoringDisabled: loadTrayMenuIcon(TRAY_MENU_STOP_DISABLED_ICON_PATH, `
    <rect x="4" y="4" width="8" height="8" rx="1.4" fill="rgba(145,154,163,0.96)" stroke="none" />
  `),
  quit: loadTrayMenuIcon(TRAY_MENU_QUIT_ICON_PATH, `
    <path d="M4 4l8 8M12 4 4 12" />
  `)
});

function lockWindowZoom(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.setZoomFactor(1);
  targetWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
}

function createDailyState() {
  return {
    dateKey: toDateKey(new Date()),
    clockIn: {
      status: "Pending",
      message: "Waiting for the scheduled time.",
      lastRunAt: null
    },
    clockOut: {
      status: "Pending",
      message: "Waiting for the scheduled time.",
      lastRunAt: null
    }
  };
}

function createTrayMenuIcon(svgBody) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
      <g stroke="rgba(255,255,255,0.92)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none">
        ${svgBody}
      </g>
    </svg>
  `;

  return nativeImage
    .createFromDataURL(`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`)
    .resize({ width: 16, height: 16 });
}

function loadTrayMenuIcon(iconPath, fallbackSvgBody) {
  const image = nativeImage.createFromPath(iconPath);

  if (!image.isEmpty()) {
    return image.resize({ width: 16, height: 16 });
  }

  return createTrayMenuIcon(fallbackSvgBody);
}

function resetDailyState() {
  dailyState = createDailyState();
  latestRun = null;
  latestPadProgress = null;
  logService.info("Reset daily task state for the new day.");
  refreshPendingMessages();
  broadcastState();
}

function ensureCurrentDayState() {
  const today = toDateKey(new Date());

  if (dailyState.dateKey !== today) {
    dailyState = createDailyState();
    latestRun = null;
    refreshPendingMessages();
  }
}

function getCurrentSettings() {
  return settingsService ? settingsService.getSettings() : null;
}

function getAutomationEngine(settings) {
  return settings && settings.automationEngine === "pad"
    ? "pad"
    : DEFAULT_AUTOMATION_ENGINE;
}

function getAutomationEngineBlockingReason(settings) {
  const effectiveSettings = settings || getCurrentSettings();

  if (!effectiveSettings) {
    return null;
  }

  if (getAutomationEngine(effectiveSettings) !== "pad") {
    return null;
  }

  return getPadConfigError(effectiveSettings.padConfig);
}

function isAutomationEngineReady(settings) {
  return !getAutomationEngineBlockingReason(settings);
}

function isPadConfiguredReady(settings) {
  const effectiveSettings = settings || getCurrentSettings();
  return isPadAvailable() && !getPadConfigError(effectiveSettings ? effectiveSettings.padConfig : null);
}

function buildStateSnapshot() {
  ensureCurrentDayState();
  const settings = getCurrentSettings();

  return {
    settings,
    credentialsReady: Boolean(runtimeCredentials && runtimeCredentials.username && runtimeCredentials.password),
    activeCredentials: {
      username: runtimeCredentials ? runtimeCredentials.username : "",
      hasPassword: Boolean(runtimeCredentials && runtimeCredentials.password)
    },
    storedCredentials: credentialsService ? credentialsService.getPublicState() : { username: "", hasPassword: false },
    isRunning,
    monitoringStartedAt,
    monitoringEnabled,
    logWindowVisible: Boolean(logWindow && !logWindow.isDestroyed() && logWindow.isVisible()),
    dailyState,
    latestRun,
    latestPadProgress,
    logs: logService.getEntries(),
    schedulePreview: schedulerService.getSchedulePreview(),
    padReady: isPadConfiguredReady(settings),
    capabilities: {
      padAvailable: isPadAvailable()
    }
  };
}

function sendStateToWindow(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (targetWindow.webContents.isLoading()) {
    return;
  }

  targetWindow.webContents.send("clockbot:state-changed", buildStateSnapshot());
}

function broadcastState() {
  sendStateToWindow(mainWindow);
  sendStateToWindow(logWindow);

  if (tray) {
    const tooltip = monitoringEnabled ? "ClockBot monitoring is active." : "ClockBot monitoring is stopped.";
    tray.setToolTip(tooltip);
    tray.setContextMenu(buildTrayMenu());
  }
}

function createTrayImage() {
  const image = nativeImage.createFromPath(TRAY_ICON_PATH);

  if (!image.isEmpty()) {
    return image.resize({ width: 16, height: 16 });
  }

  return nativeImage.createFromPath(WINDOW_ICON_PATH);
}

function normalizeDraftCredentials(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return {
      username: "",
      password: ""
    };
  }

  return {
    username: String(candidate.username || "").trim(),
    password: String(candidate.password || "")
  };
}

function canUseDraftCredentialsForMonitoring() {
  if (draftCredentials.username && draftCredentials.password) {
    return true;
  }

  return Boolean(
    savedCredentials &&
    savedCredentials.username &&
    savedCredentials.password &&
    draftCredentials.username &&
    draftCredentials.username === savedCredentials.username
  );
}

function showNotification(title, body) {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title,
    body
  });
  notification.show();
}

function updateActionState(action, status, message) {
  dailyState[action] = {
    ...dailyState[action],
    status,
    message,
    lastRunAt: new Date().toISOString()
  };

  latestRun = {
    action,
    actionLabel: ACTION_LABELS[action],
    status,
    message,
    timestamp: new Date().toISOString()
  };
}

function updateActionProgress(action, progress) {
  if (!progress) {
    return;
  }

  const nextMessage = progress.message || progress.stage || `${ACTION_LABELS[action]} is running...`;
  const timestamp = progress.updatedAt || new Date().toISOString();

  dailyState[action] = {
    ...dailyState[action],
    status: "Running",
    message: nextMessage,
    lastRunAt: timestamp
  };

  latestPadProgress = {
    action,
    stage: progress.stage || "",
    message: progress.message || "",
    timestamp
  };

  latestRun = {
    action,
    actionLabel: ACTION_LABELS[action],
    status: "Running",
    message: nextMessage,
    timestamp
  };
}

function refreshPendingMessages() {
  const settings = settingsService ? settingsService.getSettings() : null;

  if (dailyState.clockIn.status === "Pending") {
    dailyState.clockIn.message = settings && monitoringEnabled && runtimeCredentials
      ? `Monitoring is active. Waiting for ${settings.morningTime}.`
      : "Monitoring is stopped. Click Start Monitoring to arm this action.";
  }

  if (dailyState.clockOut.status === "Pending") {
    dailyState.clockOut.message = settings && monitoringEnabled && runtimeCredentials
      ? `Monitoring is active. Waiting for ${settings.eveningTime}.`
      : "Monitoring is stopped. Click Start Monitoring to arm this action.";
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function startMonitoringSession(inputCredentials = {}, options = {}) {
  const resolvedCredentials = resolveCredentials(inputCredentials);
  const automationError = getAutomationEngineBlockingReason();

  if (!resolvedCredentials) {
    const source = options.source || "app";
    const message = source === "tray"
      ? "Saved credentials are required before monitoring can start from the tray."
      : "Username and password are both required.";
    logService.warn(message, { source });
    throw new Error(message);
  }

  if (automationError) {
    logService.warn(automationError, {
      source: options.source || "app",
      automationEngine: getAutomationEngine(getCurrentSettings())
    });
    throw new Error(automationError);
  }

  ensureCurrentDayState();
  runtimeCredentials = resolvedCredentials;
  monitoringEnabled = true;
  monitoringStartedAt = new Date().toISOString();
  schedulerService.start();
  refreshPendingMessages();

  try {
    savedCredentials = credentialsService.save(resolvedCredentials);
    logService.info("Credentials were saved securely for future sessions.");
  } catch (error) {
    logService.warn("Secure credential storage was unavailable, so credentials were kept only in memory.", {
      message: error && error.message ? error.message : String(error)
    });
  }

  latestRun = {
    action: "monitoring",
    actionLabel: "Monitoring",
    status: "Ready",
    message: `Monitoring started. Today's schedule is ${settingsService.getSettings().morningTime} and ${settingsService.getSettings().eveningTime}.`,
    timestamp: monitoringStartedAt
  };
  latestPadProgress = null;
  logService.info("Credentials stored in memory for the current session.");
  broadcastState();
  return buildStateSnapshot();
}

function stopMonitoringSession() {
  monitoringEnabled = false;
  monitoringStartedAt = null;
  runtimeCredentials = null;
  schedulerService.stop();
  refreshPendingMessages();
  latestRun = {
    action: "monitoring",
    actionLabel: "Monitoring",
    status: "Stopped",
    message: "Monitoring has been stopped for this session.",
    timestamp: new Date().toISOString()
  };
  latestPadProgress = null;
  logService.info("Monitoring stopped for the current session.");
  broadcastState();
  return buildStateSnapshot();
}

async function toggleMonitoringFromTray() {
  try {
    if (monitoringEnabled) {
      stopMonitoringSession();
      showNotification("ClockBot", "Monitoring stopped.");
    } else {
      startMonitoringSession(draftCredentials, { source: "tray" });
      showNotification("ClockBot", "Monitoring started.");
    }
  } catch (error) {
    const message = error && error.message ? error.message : "Monitoring could not be changed from the tray.";
    showNotification("ClockBot", message);
    focusMainWindow();
  }
}

function buildTrayMenu() {
  const settings = getCurrentSettings();
  const monitoringReady = monitoringEnabled || (
    canUseDraftCredentialsForMonitoring() &&
    isAutomationEngineReady(settings)
  );
  const canToggleMonitoring = !isRunning && monitoringReady;
  const automationError = getAutomationEngineBlockingReason(settings);

  let monitoringLabel = monitoringEnabled ? "Stop" : "Start";
  let monitoringIcon = monitoringEnabled
    ? TRAY_MENU_ICONS.stopMonitoring
    : TRAY_MENU_ICONS.startMonitoring;

  if (isRunning) {
    monitoringLabel = monitoringEnabled ? "Stop (Busy)" : "Start (Busy)";
    monitoringIcon = monitoringEnabled
      ? TRAY_MENU_ICONS.stopMonitoringDisabled
      : TRAY_MENU_ICONS.startMonitoringDisabled;
  } else if (!monitoringEnabled && automationError) {
    monitoringLabel = "Start (Engine not ready)";
    monitoringIcon = TRAY_MENU_ICONS.startMonitoringDisabled;
  } else if (!monitoringEnabled && !monitoringReady) {
    monitoringLabel = "Start (Need credentials)";
    monitoringIcon = TRAY_MENU_ICONS.startMonitoringDisabled;
  }

  return Menu.buildFromTemplate([
    {
      label: "Show Window",
      icon: TRAY_MENU_ICONS.showWindow,
      click: () => {
        focusMainWindow();
      }
    },
    {
      label: monitoringLabel,
      icon: monitoringIcon,
      enabled: canToggleMonitoring,
      click: () => {
        void toggleMonitoringFromTray();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      icon: TRAY_MENU_ICONS.quit,
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function resolveCredentials(inputCredentials) {
  const enteredUsername = String(inputCredentials.username || "").trim();
  const enteredPassword = String(inputCredentials.password || "");
  const fallbackCredentials = savedCredentials;
  const username = enteredUsername || (fallbackCredentials ? fallbackCredentials.username : "");

  let password = enteredPassword;
  if (!password &&
    fallbackCredentials &&
    username &&
    fallbackCredentials.username === username) {
    password = fallbackCredentials.password;
  }

  return username && password
    ? { username, password }
    : null;
}

async function runAttendanceAction(action, metadata = { source: "manual" }) {
  if (isRunning) {
    const message = "Another automation run is already in progress.";
    logService.warn(message, metadata);
    return buildStateSnapshot();
  }

  const actionSettings = getCurrentSettings();
  const automationError = getAutomationEngineBlockingReason(actionSettings);

  if (automationError) {
    logService.warn(automationError, {
      ...metadata,
      automationEngine: getAutomationEngine(actionSettings)
    });
    updateActionState(action, "Failed", automationError);
    showNotification("ClockBot", automationError);
    broadcastState();
    return buildStateSnapshot();
  }

  const actionCredentials = monitoringEnabled && runtimeCredentials
    ? runtimeCredentials
    : resolveCredentials(metadata.credentials || {});

  if (!actionCredentials) {
    const message = "Enter your username and password first, or use the saved credentials for this username.";
    logService.warn(message, metadata);
    updateActionState(action, "Failed", message);
    showNotification("ClockBot", message);
    broadcastState();
    return buildStateSnapshot();
  }

  isRunning = true;
  latestPadProgress = null;
  updateActionState(action, "Running", `${ACTION_LABELS[action]} is starting...`);
  logService.info(`Starting ${action}.`, metadata);
  broadcastState();

  try {
    const result = await punchService.run(action, actionCredentials, actionSettings, {
      onProgress: (progress) => {
        updateActionProgress(action, progress);
        broadcastState();
      }
    });
    updateActionState(action, result.status, result.message);
    latestPadProgress = null;
    logService.info(`${ACTION_LABELS[action]} finished with status ${result.status}.`, {
      ...metadata,
      message: result.message
    });

    if (result.status === "Failed") {
      showNotification("ClockBot", `${ACTION_LABELS[action]} failed: ${result.message}`);
    } else {
      showNotification("ClockBot", `${ACTION_LABELS[action]}: ${result.message}`);
    }
  } catch (error) {
    const message = error && error.message ? error.message : "Unknown automation error.";
    updateActionState(action, "Failed", message);
    latestPadProgress = null;
    logService.error(`${ACTION_LABELS[action]} failed.`, {
      ...metadata,
      message
    });
    showNotification("ClockBot", `${ACTION_LABELS[action]} failed: ${message}`);
  } finally {
    isRunning = false;
    broadcastState();
  }

  return buildStateSnapshot();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 664,
    height: 980,
    useContentSize: true,
    minWidth: 664,
    minHeight: 760,
    maxWidth: 664,
    maxHeight: 1200,
    show: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    icon: WINDOW_ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: "#eef3ea",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => lockWindowZoom(mainWindow));

  mainWindow.on("close", (event) => {
    if (isQuitting || !settingsService.getSettings().minimizeToTray) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("hide", () => {
    if (logWindow && !logWindow.isDestroyed() && logWindow.isVisible()) {
      logWindow.hide();
    }

    broadcastState();
  });

  mainWindow.on("show", () => {
    broadcastState();
  });

  mainWindow.on("ready-to-show", () => {
    broadcastState();
  });
}

function createLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    return logWindow;
  }

  logWindow = new BrowserWindow({
    width: 620,
    height: 560,
    useContentSize: true,
    minWidth: 620,
    minHeight: 560,
    maxWidth: 620,
    maxHeight: 560,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    icon: WINDOW_ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: "#eef3ea",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1
    }
  });

  logWindow.loadFile(path.join(__dirname, "renderer", "logs.html"));
  logWindow.webContents.on("did-finish-load", () => lockWindowZoom(logWindow));

  logWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    logWindow.hide();
  });

  logWindow.on("show", () => {
    broadcastState();
  });

  logWindow.on("hide", () => {
    broadcastState();
  });

  logWindow.on("closed", () => {
    logWindow = null;
  });

  logWindow.on("ready-to-show", () => {
    sendStateToWindow(logWindow);
  });

  return logWindow;
}

function resizeMainWindowToContent(requestedHeight) {
  if (!mainWindow || mainWindow.isDestroyed() || typeof requestedHeight !== "number") {
    return;
  }

  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const minHeight = 760;
  const maxHeight = Math.min(1200, display.workArea.height);
  const nextHeight = Math.max(minHeight, Math.min(Math.ceil(requestedHeight), maxHeight));
  const bounds = mainWindow.getBounds();

  if (Math.abs(bounds.height - nextHeight) < 2) {
    return;
  }

  mainWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: nextHeight
  });

  if (logWindow && !logWindow.isDestroyed() && logWindow.isVisible()) {
    positionLogWindowNextToMainWindow();
  }
}

function positionLogWindowNextToMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || !logWindow || logWindow.isDestroyed()) {
    return;
  }

  const gap = 18;
  const mainBounds = mainWindow.getBounds();
  const logBounds = logWindow.getBounds();
  const display = screen.getDisplayMatching(mainBounds);
  const { x: workX, y: workY, width: workWidth, height: workHeight } = display.workArea;

  const fitsRight = mainBounds.x + mainBounds.width + gap + logBounds.width <= workX + workWidth;
  const fitsLeft = mainBounds.x - gap - logBounds.width >= workX;

  let x;
  if (fitsRight) {
    x = mainBounds.x + mainBounds.width + gap;
  } else if (fitsLeft) {
    x = mainBounds.x - gap - logBounds.width;
  } else {
    x = Math.min(
      Math.max(workX, mainBounds.x + mainBounds.width + gap),
      workX + workWidth - logBounds.width
    );
  }

  const y = Math.min(
    Math.max(workY, mainBounds.y),
    workY + workHeight - logBounds.height
  );

  logWindow.setPosition(Math.round(x), Math.round(y));
}

function toggleLogWindowVisibility() {
  const window = createLogWindow();

  if (window.isVisible()) {
    window.hide();
  } else {
    positionLogWindowNextToMainWindow();
    window.show();
    window.focus();
  }

  broadcastState();
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", () => {
    focusMainWindow();
  });
  tray.setToolTip("ClockBot");
}

function registerIpcHandlers() {
  ipcMain.handle("clockbot:get-state", () => buildStateSnapshot());

  ipcMain.handle("clockbot:save-settings", (_event, partialSettings) => {
    const currentSettings = getCurrentSettings();
    const nextSettings = {
      morningTime: partialSettings.morningTime,
      eveningTime: partialSettings.eveningTime,
      automationEngine: typeof partialSettings.automationEngine === "string"
        ? partialSettings.automationEngine
        : currentSettings.automationEngine
    };

    settingsService.save(nextSettings);
    if (monitoringEnabled) {
      schedulerService.refresh();
    }
    refreshPendingMessages();
    logService.info("Saved app settings.", nextSettings);
    broadcastState();
    return buildStateSnapshot();
  });

  ipcMain.handle("clockbot:save-pad-config", (_event, partialPadConfig) => {
    const nextPadConfig = sanitizePadConfig(partialPadConfig);
    settingsService.save({
      padConfig: nextPadConfig
    });
    logService.info("Saved PAD settings.", {
      workflowName: nextPadConfig.workflowName || null,
      environmentId: nextPadConfig.environmentId || null
    });
    broadcastState();
    return buildStateSnapshot();
  });

  ipcMain.handle("clockbot:start-monitoring", (_event, credentials) => {
    const hasCompleteProvidedCredentials = credentials &&
      typeof credentials === "object" &&
      String(credentials.username || "").trim() &&
      String(credentials.password || "");
    const canUseSavedPassword = credentials &&
      typeof credentials === "object" &&
      String(credentials.username || "").trim() &&
      !String(credentials.password || "") &&
      savedCredentials &&
      savedCredentials.username === String(credentials.username || "").trim() &&
      savedCredentials.password;

    if (!hasCompleteProvidedCredentials && !canUseSavedPassword) {
      const message = "Username and password are both required.";
      logService.warn(message);
      throw new Error(message);
    }

    return startMonitoringSession(credentials || {}, { source: "app" });
  });

  ipcMain.handle("clockbot:stop-monitoring", () => {
    return stopMonitoringSession();
  });

  ipcMain.handle("clockbot:run-action", (_event, payload) => {
    const action = typeof payload === "string" ? payload : payload.action;
    const credentials = payload && typeof payload === "object" ? payload.credentials || {} : {};
    return runAttendanceAction(action, { source: "manual", credentials });
  });

  ipcMain.handle("clockbot:toggle-log-window", () => {
    toggleLogWindowVisibility();
    return buildStateSnapshot();
  });

  ipcMain.handle("clockbot:clear-stored-credentials", () => {
    credentialsService.clear();
    savedCredentials = null;

    logService.info("Cleared saved credentials from secure storage.");
    broadcastState();
    return buildStateSnapshot();
  });

  ipcMain.on("clockbot:update-draft-credentials", (_event, credentials) => {
    draftCredentials = normalizeDraftCredentials(credentials);

    if (tray) {
      tray.setContextMenu(buildTrayMenu());
    }
  });

  ipcMain.handle("clockbot:close-window", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.close();
    }

    return true;
  });

  ipcMain.on("clockbot:resize-window-to-content", (event, requestedHeight) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (targetWindow === mainWindow) {
      resizeMainWindowToContent(requestedHeight);
    }
  });
}

function wireServices() {
  const userDataPath = app.getPath("userData");
  settingsService = new SettingsService(userDataPath);
  settingsService.load();
  credentialsService = new CredentialsService(userDataPath);
  savedCredentials = credentialsService.load();
  draftCredentials = {
    username: savedCredentials && savedCredentials.username ? savedCredentials.username : "",
    password: ""
  };
  logService = new LogService(userDataPath);
  punchService = new PunchService(logService, {
    baseDirectory: userDataPath
  });
  schedulerService = new SchedulerService({
    getSettings: () => settingsService.getSettings(),
    onTrigger: (action, metadata) => runAttendanceAction(action, metadata),
    onMissed: async (action, metadata) => {
      const minutesLate = Math.round(metadata.delayMs / 60000);
      const message = `${ACTION_LABELS[action]} was skipped because the app resumed ${minutesLate} minutes late.`;
      updateActionState(action, "Skipped", message);
      logService.warn(message, metadata);
      showNotification("ClockBot", message);
      broadcastState();
    },
    onDayChanged: () => resetDailyState(),
    log: logService
  });

  logService.on("entry", () => {
    broadcastState();
  });
}

function ensureSingleInstance() {
  const hasLock = app.requestSingleInstanceLock();

  if (!hasLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return true;
}

if (!ensureSingleInstance()) {
  process.exit(0);
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("ClockBot");
  }
  wireServices();
  createWindow();
  createTray();
  registerIpcHandlers();
  logService.info("ClockBot started.");
  broadcastState();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (schedulerService) {
    schedulerService.stop();
  }
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
