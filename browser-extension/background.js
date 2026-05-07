(function installClockBotBackground() {
  const BRIDGE_BASE_URL = "http://127.0.0.1:38473";
  const BRIDGE_POLL_ALARM = "clockbot-bridge-poll";
  const DEFAULT_POLL_INTERVAL_MS = 1500;
  const BRIDGE_RETRY_INTERVAL_MS = 5000;
  const HEARTBEAT_ALARM_PERIOD_MINUTES = 1;
  const LOGIN_WAIT_TIMEOUT_MS = 15000;
  const ATTENDANCE_WAIT_TIMEOUT_MS = 90000;
  const POST_PUNCH_WAIT_TIMEOUT_MS = 15000;
  const TAB_LOAD_TIMEOUT_MS = 30000;
  const TAB_ERROR_PAGE_RECOVERY_LIMIT = 2;
  const TAB_ERROR_PAGE_RECOVERY_DELAY_MS = 1200;
  const TAB_CLOSE_DELAY_MS = 1800;
  const COMMAND_HEARTBEAT_INTERVAL_MS = 3000;
  const MESSAGE_RETRY_DELAY_MS = 250;
  const DEBUGGER_PROTOCOL_VERSION = "1.3";
  const IEYASU_URL_PATTERNS = ["https://*.ieyasu.co/*"];
  const CLIENT_ID_STORAGE_KEY = "clockbotClientId";

  const state = {
    initialized: false,
    clientId: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    isPolling: false,
    pollQueued: false,
    scheduledPollTimer: null,
    currentCommandId: null,
    mousePositions: Object.create(null)
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function sleep(timeoutMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * ((max - min) + 1)) + min;
  }

  function randomFloat(min, max) {
    return (Math.random() * (max - min)) + min;
  }

  function easeInOut(progress) {
    if (progress < 0.5) {
      return 2 * progress * progress;
    }

    return 1 - ((-2 * progress + 2) ** 2) / 2;
  }

  function getBezierPoint(start, controlOne, controlTwo, end, progress) {
    const inverse = 1 - progress;
    const x = (inverse ** 3 * start.x) +
      (3 * inverse * inverse * progress * controlOne.x) +
      (3 * inverse * progress * progress * controlTwo.x) +
      (progress ** 3 * end.x);
    const y = (inverse ** 3 * start.y) +
      (3 * inverse * inverse * progress * controlOne.y) +
      (3 * inverse * progress * progress * controlTwo.y) +
      (progress ** 3 * end.y);

    return { x, y };
  }

  function toErrorMessage(error) {
    if (!error) {
      return "Unknown ClockBot extension error.";
    }

    if (typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }

    return String(error);
  }

  function getActionLabel(action) {
    return action === "clockOut" ? "Clock Out" : "Clock In";
  }

  function parseUrlOrNull(candidate) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      return null;
    }

    try {
      return new URL(candidate.trim());
    } catch (_error) {
      return null;
    }
  }

  function isHttpUrl(candidate) {
    return /^https?:\/\//i.test(String(candidate || ""));
  }

  function isChromeErrorUrl(candidate) {
    return /^chrome-error:\/\//i.test(String(candidate || ""));
  }

  function isIeyasuUrl(candidate) {
    const parsed = parseUrlOrNull(candidate);
    return Boolean(parsed && /(^|\.)ieyasu\.co$/i.test(parsed.hostname));
  }

  function isResolvedButtonState(button) {
    return Boolean(button) &&
      button.state !== "missing" &&
      button.state !== "unknown";
  }

  function areAttendanceButtonsVisible(attendanceState) {
    return Boolean(attendanceState) &&
      attendanceState.clockIn &&
      attendanceState.clockOut &&
      attendanceState.clockIn.state !== "missing" &&
      attendanceState.clockOut.state !== "missing";
  }

  function isAttendanceStateActionable(attendanceState, action) {
    if (!attendanceState) {
      return false;
    }

    const targetButton = action === "clockOut"
      ? attendanceState.clockOut
      : attendanceState.clockIn;

    return areAttendanceButtonsVisible(attendanceState) && isResolvedButtonState(targetButton);
  }

  function hasValidTarget(target) {
    return Boolean(target) &&
      Number.isFinite(target.x) &&
      Number.isFinite(target.y);
  }

  function buildBridgeUrl(path) {
    return `${BRIDGE_BASE_URL}${path}`;
  }

  function withChromeCallback(executor) {
    return new Promise((resolve, reject) => {
      try {
        executor((result) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageGet(keys) {
    return withChromeCallback((callback) => {
      chrome.storage.local.get(keys, callback);
    });
  }

  function storageSet(items) {
    return withChromeCallback((callback) => {
      chrome.storage.local.set(items, callback);
    });
  }

  function tabsQuery(queryInfo) {
    return withChromeCallback((callback) => {
      chrome.tabs.query(queryInfo, callback);
    });
  }

  function tabsGet(tabId) {
    return withChromeCallback((callback) => {
      chrome.tabs.get(tabId, callback);
    });
  }

  function tabsCreate(createProperties) {
    return withChromeCallback((callback) => {
      chrome.tabs.create(createProperties, callback);
    });
  }

  function tabsUpdate(tabId, updateProperties) {
    return withChromeCallback((callback) => {
      chrome.tabs.update(tabId, updateProperties, callback);
    });
  }

  function tabsRemove(tabId) {
    return withChromeCallback((callback) => {
      chrome.tabs.remove(tabId, callback);
    });
  }

  function windowsUpdate(windowId, updateInfo) {
    return withChromeCallback((callback) => {
      chrome.windows.update(windowId, updateInfo, callback);
    });
  }

  function tabsSendMessage(tabId, message) {
    return withChromeCallback((callback) => {
      chrome.tabs.sendMessage(tabId, message, callback);
    });
  }

  function executeScript(injection) {
    return withChromeCallback((callback) => {
      chrome.scripting.executeScript(injection, callback);
    });
  }

  function attachTabDebugger(tabId) {
    return withChromeCallback((callback) => {
      chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, callback);
    });
  }

  function detachTabDebugger(tabId) {
    return withChromeCallback((callback) => {
      chrome.debugger.detach({ tabId }, callback);
    });
  }

  function sendDebuggerCommand(tabId, method, params = {}) {
    return withChromeCallback((callback) => {
      chrome.debugger.sendCommand({ tabId }, method, params, callback);
    });
  }

  async function getOrCreateClientId() {
    if (state.clientId) {
      return state.clientId;
    }

    const stored = await storageGet([CLIENT_ID_STORAGE_KEY]);
    const storedValue = typeof stored?.[CLIENT_ID_STORAGE_KEY] === "string"
      ? stored[CLIENT_ID_STORAGE_KEY].trim()
      : "";

    if (storedValue) {
      state.clientId = storedValue;
      return state.clientId;
    }

    state.clientId = crypto.randomUUID();
    await storageSet({
      [CLIENT_ID_STORAGE_KEY]: state.clientId
    });
    return state.clientId;
  }

  async function buildClientPayload(extra = {}) {
    return {
      clientId: await getOrCreateClientId(),
      extensionVersion: chrome.runtime.getManifest().version,
      browserVersion: navigator.userAgent,
      ...extra
    };
  }

  async function bridgeRequestJson(path, options = {}) {
    const response = await fetch(buildBridgeUrl(path), {
      method: options.method || "GET",
      headers: options.body ? {
        "Content-Type": "application/json"
      } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });

    const rawText = await response.text();
    let payload = {};

    if (rawText.trim()) {
      try {
        payload = JSON.parse(rawText);
      } catch (_error) {
        throw new Error(`Bridge returned invalid JSON for ${path}.`);
      }
    }

    if (!response.ok) {
      throw new Error(payload && typeof payload.error === "string" && payload.error
        ? payload.error
        : `Bridge request failed with status ${response.status}.`);
    }

    return payload;
  }

  async function postBridgeJson(path, payload, options = {}) {
    const retries = Number.isInteger(options.retries) ? options.retries : 0;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await bridgeRequestJson(path, {
          method: "POST",
          body: await buildClientPayload(payload)
        });
      } catch (error) {
        lastError = error;

        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
        }
      }
    }

    throw lastError || new Error(`Could not POST ${path}.`);
  }

  async function sendHello() {
    const response = await postBridgeJson("/extension/hello", {});
    const nextPollInterval = Number.parseInt(response?.pollIntervalMs, 10);

    if (Number.isFinite(nextPollInterval) && nextPollInterval > 0) {
      state.pollIntervalMs = clamp(nextPollInterval, 1000, 10000);
    }

    return response;
  }

  async function requestNextCommand() {
    const clientId = await getOrCreateClientId();
    return bridgeRequestJson(`/extension/commands/next?clientId=${encodeURIComponent(clientId)}`);
  }

  async function sendVisualCursorMessage(tabId, type, payload = {}) {
    try {
      await tabsSendMessage(tabId, {
        source: "clockbot",
        type,
        ...payload
      });
    } catch (_error) {
      // Visual cursor updates are best-effort only.
    }
  }

  function reportProgress(commandId, stage, message, extra = {}) {
    return postBridgeJson("/extension/progress", {
      commandId,
      stage,
      message,
      updatedAt: nowIso(),
      ...extra
    }).catch((error) => {
      console.warn("ClockBot progress update failed.", {
        commandId,
        stage,
        message,
        error: toErrorMessage(error)
      });
    });
  }

  function reportLog(level, message, context = {}) {
    return postBridgeJson("/extension/log", {
      level,
      message,
      context
    }).catch((error) => {
      console.warn("ClockBot bridge log failed.", {
        level,
        message,
        error: toErrorMessage(error)
      });
    });
  }

  function reportResult(commandId, payload) {
    return postBridgeJson("/extension/result", {
      commandId,
      status: payload.status,
      stage: payload.stage || "completed",
      message: payload.message
    }, {
      retries: 2
    });
  }

  function createCommandProgressReporter(commandId) {
    let latestStage = "";
    let latestMessage = "";
    let heartbeatTimer = null;

    const remember = (stage, message) => {
      if (typeof stage === "string" && stage.trim()) {
        latestStage = stage.trim();
      }

      if (typeof message === "string" && message.trim()) {
        latestMessage = message.trim();
      }
    };

    const report = async (stage, message, extra = {}) => {
      remember(stage, message);
      return reportProgress(commandId, latestStage, latestMessage, extra);
    };

    const start = () => {
      if (heartbeatTimer) {
        return;
      }

      heartbeatTimer = setInterval(() => {
        if (!latestStage && !latestMessage) {
          return;
        }

        void reportProgress(commandId, latestStage, latestMessage);
      }, COMMAND_HEARTBEAT_INTERVAL_MS);
    };

    const stop = () => {
      if (!heartbeatTimer) {
        return;
      }

      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    return {
      report,
      snapshot() {
        return {
          stage: latestStage,
          message: latestMessage
        };
      },
      start,
      stop
    };
  }

  function requestPoll(reason, delayMs = 0) {
    if (delayMs <= 0) {
      if (state.scheduledPollTimer) {
        clearTimeout(state.scheduledPollTimer);
        state.scheduledPollTimer = null;
      }

      queueMicrotask(() => {
        void runPollLoop(reason);
      });
      return;
    }

    if (state.scheduledPollTimer) {
      clearTimeout(state.scheduledPollTimer);
    }

    state.scheduledPollTimer = setTimeout(() => {
      state.scheduledPollTimer = null;
      void runPollLoop(reason);
    }, delayMs);
  }

  async function runPollLoop(reason) {
    if (state.isPolling) {
      state.pollQueued = true;
      return;
    }

    state.isPolling = true;

    try {
      do {
        state.pollQueued = false;
        await pollBridgeOnce(reason);
      } while (state.pollQueued);
    } finally {
      state.isPolling = false;
    }
  }

  async function pollBridgeOnce(reason) {
    if (state.currentCommandId) {
      return;
    }

    try {
      await sendHello();
    } catch (error) {
      console.warn("ClockBot bridge hello failed.", {
        reason,
        error: toErrorMessage(error)
      });
      requestPoll("bridge-retry", Math.max(state.pollIntervalMs, BRIDGE_RETRY_INTERVAL_MS));
      return;
    }

    let command = null;

    try {
      command = await requestNextCommand();
    } catch (error) {
      console.warn("ClockBot next-command polling failed.", {
        reason,
        error: toErrorMessage(error)
      });
      requestPoll("next-command-retry", Math.max(state.pollIntervalMs, BRIDGE_RETRY_INTERVAL_MS));
      return;
    }

    if (!command || !command.commandId) {
      requestPoll("idle", state.pollIntervalMs);
      return;
    }

    state.currentCommandId = command.commandId;

    try {
      await reportProgress(
        command.commandId,
        "command_received",
        `${getActionLabel(command.action)} received by the Chrome extension.`
      );

      const result = await executeCommand(command);
      await reportResult(command.commandId, result);
    } catch (error) {
      const message = toErrorMessage(error);
      const progressSnapshot = typeof executeCommand.lastProgressSnapshot === "function"
        ? executeCommand.lastProgressSnapshot()
        : { stage: "", message: "" };
      console.error("ClockBot command execution failed.", {
        commandId: command.commandId,
        stage: progressSnapshot.stage || null,
        progressMessage: progressSnapshot.message || null,
        message
      });

      await reportLog("error", "ClockBot command execution failed.", {
        commandId: command.commandId,
        action: command.action,
        stage: progressSnapshot.stage || "",
        progressMessage: progressSnapshot.message || "",
        message
      });

      try {
        await reportResult(command.commandId, {
          status: "Failed",
          stage: progressSnapshot.stage || "failed",
          message
        });
      } catch (resultError) {
        console.error("ClockBot could not report the failed result back to the bridge.", {
          commandId: command.commandId,
          error: toErrorMessage(resultError)
        });
      }
    } finally {
      state.currentCommandId = null;
      requestPoll("post-command", state.pollIntervalMs);
    }
  }

  async function focusTab(tab) {
    if (!tab || !Number.isInteger(tab.id)) {
      return tab;
    }

    try {
      await tabsUpdate(tab.id, {
        active: true
      });
    } catch (_error) {
      // Ignore focus failures for individual tabs.
    }

    if (Number.isInteger(tab.windowId)) {
      try {
        await windowsUpdate(tab.windowId, {
          focused: true
        });
      } catch (_error) {
        // Ignore window focus failures.
      }
    }

    return tabsGet(tab.id).catch(() => tab);
  }

  async function openOrReuseAttendanceTab(attendanceUrl) {
    const parsedAttendanceUrl = parseUrlOrNull(attendanceUrl);
    const allIeyasuTabs = await tabsQuery({
      url: IEYASU_URL_PATTERNS
    });

    if (parsedAttendanceUrl) {
      const exactTab = allIeyasuTabs.find((tab) => tab.url === parsedAttendanceUrl.toString());
      if (exactTab) {
        return focusTab(exactTab);
      }

      const originTab = allIeyasuTabs.find((tab) => {
        const parsedTabUrl = parseUrlOrNull(tab.url);
        return Boolean(parsedTabUrl && parsedTabUrl.origin === parsedAttendanceUrl.origin);
      });

      if (originTab) {
        return focusTab(originTab);
      }
    }

    if (allIeyasuTabs.length > 0 && !parsedAttendanceUrl) {
      return focusTab(allIeyasuTabs[0]);
    }

    if (!parsedAttendanceUrl) {
      throw new Error("ClockBot did not receive a usable attendance URL for Chrome Extension mode.");
    }

    return tabsCreate({
      url: parsedAttendanceUrl.toString(),
      active: true
    });
  }

  async function waitForInjectableTab(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
    return waitForInjectableTabWithRecovery(tabId, {
      timeoutMs
    });
  }

  async function recoverTabFromErrorPage(tabId, options = {}) {
    const attendanceUrl = typeof options.attendanceUrl === "string"
      ? options.attendanceUrl.trim()
      : "";
    const currentUrl = typeof options.currentUrl === "string"
      ? options.currentUrl.trim()
      : "";
    const progressReporter = options.progressReporter || null;
    const commandId = typeof options.commandId === "string"
      ? options.commandId
      : "";
    const recoveryAttempt = Number.isInteger(options.recoveryAttempt)
      ? options.recoveryAttempt
      : 1;

    if (!attendanceUrl || !isHttpUrl(attendanceUrl)) {
      throw new Error("ClockBot could not recover the IEYASU tab because the attendance URL is missing.");
    }

    await reportLog("warn", "ClockBot hit a Chrome error page and will reload the attendance tab.", {
      commandId,
      tabId,
      recoveryAttempt,
      currentUrl: currentUrl || null,
      attendanceUrl
    });

    if (progressReporter) {
      await progressReporter.report(
        "recovering_error_page",
        "Chrome opened an error page first, so ClockBot is reloading the attendance tab."
      );
    }

    await tabsUpdate(tabId, {
      url: attendanceUrl,
      active: true
    });
    await sleep(TAB_ERROR_PAGE_RECOVERY_DELAY_MS);
  }

  async function waitForInjectableTabWithRecovery(tabId, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : TAB_LOAD_TIMEOUT_MS;
    const attendanceUrl = typeof options.attendanceUrl === "string"
      ? options.attendanceUrl.trim()
      : "";
    const progressReporter = options.progressReporter || null;
    const commandId = typeof options.commandId === "string"
      ? options.commandId
      : "";
    const allowErrorPageRecovery = options.allowErrorPageRecovery !== false;
    const startedAt = Date.now();
    let lastTab = null;
    let recoveryAttempts = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const tab = await tabsGet(tabId);
      lastTab = tab;

      if (tab.status === "complete" && isHttpUrl(tab.url)) {
        return tab;
      }

      if (tab.status === "complete" &&
        isChromeErrorUrl(tab.url) &&
        allowErrorPageRecovery &&
        attendanceUrl &&
        recoveryAttempts < TAB_ERROR_PAGE_RECOVERY_LIMIT) {
        recoveryAttempts += 1;
        await recoverTabFromErrorPage(tabId, {
          attendanceUrl,
          progressReporter,
          commandId,
          currentUrl: tab.url,
          recoveryAttempt: recoveryAttempts
        });
        continue;
      }

      await sleep(250);
    }

    const lastKnownUrl = lastTab && typeof lastTab.url === "string"
      ? lastTab.url
      : "";
    throw new Error(
      `The IEYASU tab did not finish loading in time${lastKnownUrl ? ` (${lastKnownUrl})` : ""}.`
    );
  }

  async function pingContentScript(tabId) {
    try {
      const response = await tabsSendMessage(tabId, {
        source: "clockbot",
        type: "clockbot:ping"
      });

      return Boolean(response && response.ok);
    } catch (_error) {
      return false;
    }
  }

  function isErrorPageExecutionFailure(error) {
    return /showing error page/i.test(toErrorMessage(error));
  }

  async function ensureContentScript(tabId, options = {}) {
    const context = {
      attendanceUrl: typeof options.attendanceUrl === "string"
        ? options.attendanceUrl.trim()
        : "",
      progressReporter: options.progressReporter || null,
      commandId: typeof options.commandId === "string"
        ? options.commandId
        : ""
    };
    let tab = await waitForInjectableTabWithRecovery(tabId, context);

    if (!isIeyasuUrl(tab.url)) {
      throw new Error("ClockBot can only automate tabs on IEYASU.");
    }

    if (await pingContentScript(tabId)) {
      return;
    }

    try {
      await executeScript({
        target: {
          tabId
        },
        files: ["content-script.js"]
      });
    } catch (error) {
      if (!context.attendanceUrl || !isErrorPageExecutionFailure(error)) {
        throw error;
      }

      await recoverTabFromErrorPage(tabId, {
        attendanceUrl: context.attendanceUrl,
        progressReporter: context.progressReporter,
        commandId: context.commandId,
        currentUrl: tab && typeof tab.url === "string" ? tab.url : "",
        recoveryAttempt: TAB_ERROR_PAGE_RECOVERY_LIMIT + 1
      });

      tab = await waitForInjectableTabWithRecovery(tabId, {
        ...context,
        allowErrorPageRecovery: false
      });

      if (!isIeyasuUrl(tab.url)) {
        throw error;
      }

      await executeScript({
        target: {
          tabId
        },
        files: ["content-script.js"]
      });
    }

    await sleep(MESSAGE_RETRY_DELAY_MS);

    if (!await pingContentScript(tabId)) {
      throw new Error("The ClockBot content script did not respond after injection.");
    }
  }

  async function sendContentMessage(tabId, type, extra = {}, options = {}) {
    await ensureContentScript(tabId, options);

    const response = await tabsSendMessage(tabId, {
      source: "clockbot",
      type,
      ...extra
    });

    if (!response || response.ok === false) {
      throw new Error(response && response.error
        ? response.error
        : `ClockBot content script message failed: ${type}`);
    }

    return response;
  }

  async function tryInspectLoginState(tabId, options = {}) {
    try {
      return await sendContentMessage(tabId, "clockbot:inspect-login", {}, options);
    } catch (_error) {
      return null;
    }
  }

  async function tryInspectAttendanceState(tabId, options = {}) {
    try {
      return await sendContentMessage(tabId, "clockbot:inspect-attendance", {}, options);
    } catch (_error) {
      return null;
    }
  }

  async function tryReadErrorMessage(tabId, options = {}) {
    try {
      const response = await sendContentMessage(tabId, "clockbot:read-error-message", {}, options);
      return typeof response.message === "string" ? response.message.trim() : "";
    } catch (_error) {
      return "";
    }
  }

  function getWorkModeLabel(preference) {
    if (preference === "office") {
      return "出社";
    }

    if (preference === "outing") {
      return "外出";
    }

    return "在宅";
  }

  async function maybeSetClockInWorkMode(
    tabId,
    command,
    progressReporter,
    attendanceState,
    contentScriptOptions = {}
  ) {
    if (command.action !== "clockIn" || !command.clockInWorkModePreference) {
      return;
    }

    const preferredLabel = getWorkModeLabel(command.clockInWorkModePreference);
    const workModeControl = attendanceState && attendanceState.workModeControl
      ? attendanceState.workModeControl
      : null;

    if (workModeControl &&
      workModeControl.status === "found" &&
      workModeControl.currentLabel === preferredLabel) {
      return;
    }

    try {
      if (workModeControl &&
        workModeControl.status === "found" &&
        hasValidTarget(workModeControl.target)) {
        await progressReporter.report(
          "work_mode_opening",
          `Opening the Clock In work mode control before selecting ${preferredLabel}.`
        );

        await pressButtonHumanized(tabId, workModeControl.target, {
          hoverMinMs: 280,
          hoverMaxMs: 720,
          preClickPauseMinMs: 110,
          preClickPauseMaxMs: 240
        });

        await sleep(randomInt(140, 280));
      }

      const response = await sendContentMessage(
        tabId,
        "clockbot:set-work-mode",
        {
          preference: command.clockInWorkModePreference
        },
        contentScriptOptions
      );

      if (response.status === "applied") {
        await progressReporter.report(
          "work_mode_applied",
          `Set the Clock In work mode to ${preferredLabel} before clicking ${getActionLabel(command.action)}.`
        );
        return;
      }

      if (response.status === "already_selected" || response.status === "not_found") {
        return;
      }

      if (response.status === "option_missing") {
        await reportLog("warn", "ClockBot could not find the preferred Clock In work mode option.", {
          commandId: command.commandId,
          action: command.action,
          preference: command.clockInWorkModePreference,
          preferredLabel,
          currentLabel: response.currentLabel || "",
          options: Array.isArray(response.options) ? response.options : []
        });
        return;
      }

      await reportLog("warn", "ClockBot received an unexpected Clock In work mode response.", {
        commandId: command.commandId,
        action: command.action,
        preference: command.clockInWorkModePreference,
        preferredLabel,
        status: response.status || ""
      });
    } catch (error) {
      await reportLog("warn", "ClockBot could not apply the preferred Clock In work mode.", {
        commandId: command.commandId,
        action: command.action,
        preference: command.clockInWorkModePreference,
        preferredLabel,
        message: toErrorMessage(error)
      });
    }
  }

  async function ensureDebuggerAttached(tabId) {
    try {
      await attachTabDebugger(tabId);
    } catch (error) {
      const message = toErrorMessage(error);

      if (/another debugger is already attached/i.test(message)) {
        throw new Error("Another debugger is already attached to the IEYASU tab. Close DevTools and try again.");
      }

      if (/already attached/i.test(message)) {
        return;
      }

      throw error;
    }
  }

  async function detachDebuggerQuietly(tabId) {
    try {
      await detachTabDebugger(tabId);
    } catch (_error) {
      // Ignore detach failures during cleanup.
    } finally {
      delete state.mousePositions[tabId];
    }
  }

  async function maybeApplyGeolocation(tabId, location, progressReporter, commandId) {
    if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
      return;
    }

    try {
      await sendDebuggerCommand(tabId, "Emulation.setGeolocationOverride", {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: Number.isFinite(location.accuracy) ? location.accuracy : 100
      });

      await progressReporter.report(
        "location_applied",
        "Applied Windows location coordinates inside Chrome."
      );
    } catch (error) {
      await reportLog("warn", "ClockBot could not apply the requested geolocation override.", {
        commandId,
        message: toErrorMessage(error)
      });
    }
  }

  async function moveMouseHumanized(tabId, target) {
    const start = state.mousePositions[tabId] || {
      x: target.x + randomInt(-140, 140),
      y: target.y + randomInt(-90, 90)
    };
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const steps = clamp(Math.round(distance / 28), 8, 26);
    const safeDistance = Math.max(distance, 1);
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const perpendicular = {
      x: -dy / safeDistance,
      y: dx / safeDistance
    };
    const arcDirection = Math.random() < 0.5 ? -1 : 1;
    const baseArcOffset = clamp(distance * randomFloat(0.18, 0.34), 18, 120) * arcDirection;
    const controlOne = {
      x: start.x + (dx * randomFloat(0.18, 0.34)) + (perpendicular.x * baseArcOffset),
      y: start.y + (dy * randomFloat(0.18, 0.34)) + (perpendicular.y * baseArcOffset)
    };
    const controlTwo = {
      x: start.x + (dx * randomFloat(0.64, 0.82)) + (perpendicular.x * baseArcOffset * randomFloat(0.35, 0.82)),
      y: start.y + (dy * randomFloat(0.64, 0.82)) + (perpendicular.y * baseArcOffset * randomFloat(0.35, 0.82))
    };

    for (let index = 1; index <= steps; index += 1) {
      const progress = easeInOut(index / steps);
      const jitterScale = index === steps ? 0.4 : 1.8;
      const point = getBezierPoint(start, controlOne, controlTwo, target, progress);
      const x = Math.round(point.x + randomFloat(-jitterScale, jitterScale));
      const y = Math.round(point.y + randomFloat(-jitterScale, jitterScale));

      await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        buttons: 0
      });
      await sendVisualCursorMessage(tabId, "clockbot:visual-cursor-move", {
        x,
        y
      });

      await sleep(randomInt(14, 42));
    }

    state.mousePositions[tabId] = {
      x: target.x,
      y: target.y
    };
  }

  async function hoverTarget(tabId, target, options = {}) {
    if (!hasValidTarget(target)) {
      throw new Error("ClockBot did not receive clickable coordinates for the requested element.");
    }

    const hoverMinMs = Number.isFinite(options.hoverMinMs) ? options.hoverMinMs : 150;
    const hoverMaxMs = Number.isFinite(options.hoverMaxMs) ? options.hoverMaxMs : 600;
    const hoverX = Math.round(target.x);
    const hoverY = Math.round(target.y);

    await moveMouseHumanized(tabId, {
      x: hoverX,
      y: hoverY
    });

    state.mousePositions[tabId] = {
      x: hoverX,
      y: hoverY
    };

    await sendVisualCursorMessage(tabId, "clockbot:visual-cursor-hover", {
      x: hoverX,
      y: hoverY
    });

    await sleep(randomInt(hoverMinMs, hoverMaxMs));
  }

  async function focusFieldHumanized(tabId, target) {
    await hoverTarget(tabId, target, {
      hoverMinMs: 260,
      hoverMaxMs: 760
    });
    await clickTarget(tabId, target, {
      moveBeforeClick: false,
      hoverMinMs: 70,
      hoverMaxMs: 170
    });
    await sleep(randomInt(120, 260));
  }

  async function pressButtonHumanized(tabId, target, options = {}) {
    await hoverTarget(tabId, target, {
      hoverMinMs: Number.isFinite(options.hoverMinMs) ? options.hoverMinMs : 320,
      hoverMaxMs: Number.isFinite(options.hoverMaxMs) ? options.hoverMaxMs : 920
    });
    await clickTarget(tabId, target, {
      moveBeforeClick: false,
      hoverMinMs: Number.isFinite(options.preClickPauseMinMs) ? options.preClickPauseMinMs : 80,
      hoverMaxMs: Number.isFinite(options.preClickPauseMaxMs) ? options.preClickPauseMaxMs : 180
    });
    await sleep(randomInt(120, 280));
  }

  async function clickTarget(tabId, target, options = {}) {
    if (!hasValidTarget(target)) {
      throw new Error("ClockBot did not receive clickable coordinates for the requested element.");
    }

    const clickX = Math.round(target.x);
    const clickY = Math.round(target.y);
    const moveBeforeClick = options.moveBeforeClick !== false;
    const hoverMinMs = Number.isFinite(options.hoverMinMs) ? options.hoverMinMs : 150;
    const hoverMaxMs = Number.isFinite(options.hoverMaxMs) ? options.hoverMaxMs : 600;

    if (moveBeforeClick) {
      await hoverTarget(tabId, {
        x: clickX,
        y: clickY
      }, {
        hoverMinMs,
        hoverMaxMs
      });
    } else {
      await sleep(randomInt(hoverMinMs, hoverMaxMs));
    }

    await sendVisualCursorMessage(tabId, "clockbot:visual-cursor-press", {
      x: clickX,
      y: clickY
    });

    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickX,
      y: clickY,
      button: "left",
      buttons: 1,
      clickCount: 1
    });

    await sleep(randomInt(45, 120));

    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickX,
      y: clickY,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    await sendVisualCursorMessage(tabId, "clockbot:visual-cursor-release", {
      x: clickX,
      y: clickY
    });

    state.mousePositions[tabId] = {
      x: clickX,
      y: clickY
    };

    await sleep(randomInt(80, 220));
  }

  async function closeTabAfterCommand(tabId) {
    if (!Number.isInteger(tabId)) {
      return;
    }

    const hideLeadMs = 160;
    await sleep(Math.max(TAB_CLOSE_DELAY_MS - hideLeadMs, 0));
    await sendVisualCursorMessage(tabId, "clockbot:visual-cursor-hide");
    await sleep(hideLeadMs);

    try {
      await tabsRemove(tabId);
    } catch (_error) {
      // Ignore close failures if the tab is already gone.
    }
  }

  async function pressSelectAll(tabId) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 2
    });

    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      text: "a",
      unmodifiedText: "a",
      modifiers: 2
    });

    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    });

    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17
    });
  }

  async function pressBackspace(tabId) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });

    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });
  }

  async function typeTextHumanized(tabId, text) {
    const value = String(text == null ? "" : text);

    for (const character of value) {
      await sendDebuggerCommand(tabId, "Input.insertText", {
        text: character
      });

      await sleep(randomInt(40, 180));

      if (Math.random() < 0.12) {
        await sleep(randomInt(120, 260));
      }
    }
  }

  async function clearAndTypeIntoField(tabId, target, text) {
    await focusFieldHumanized(tabId, target);
    await sleep(randomInt(80, 180));
    await pressSelectAll(tabId);
    await sleep(randomInt(40, 120));
    await pressBackspace(tabId);
    await sleep(randomInt(60, 160));
    await typeTextHumanized(tabId, text);
    await sleep(randomInt(110, 260));
  }

  async function ensureLoggedIn(tabId, command, progressReporter) {
    const contentScriptOptions = {
      attendanceUrl: command.attendanceUrl,
      progressReporter,
      commandId: command.commandId
    };
    const loginState = await sendContentMessage(tabId, "clockbot:inspect-login", {}, contentScriptOptions);

    if (!loginState.loginRequired) {
      await progressReporter.report(
        "session_reused",
        "Detected an existing IEYASU session in the real Chrome tab."
      );
      return;
    }

    if (!command.credentials || !command.credentials.username || !command.credentials.password) {
      throw new Error("IEYASU login is required, but ClockBot does not have usable credentials.");
    }

    if (!hasValidTarget(loginState.usernameTarget) ||
      !hasValidTarget(loginState.passwordTarget) ||
      !hasValidTarget(loginState.loginButtonTarget)) {
      throw new Error("ClockBot found the IEYASU login page, but could not resolve all login controls.");
    }

    await progressReporter.report(
      "login_required",
      "IEYASU login form detected. Signing in through your everyday Chrome tab."
    );

    await clearAndTypeIntoField(tabId, loginState.usernameTarget, command.credentials.username);
    await clearAndTypeIntoField(tabId, loginState.passwordTarget, command.credentials.password);
    await pressButtonHumanized(tabId, loginState.loginButtonTarget, {
      hoverMinMs: 360,
      hoverMaxMs: 980,
      preClickPauseMinMs: 90,
      preClickPauseMaxMs: 190
    });

    await progressReporter.report(
      "login_submitted",
      "Login submitted. Waiting for IEYASU to finish loading."
    );

    await waitForLoginCompletion(tabId, contentScriptOptions);
  }

  async function waitForLoginCompletion(tabId, contentScriptOptions = {}) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < LOGIN_WAIT_TIMEOUT_MS) {
      try {
        await waitForInjectableTabWithRecovery(tabId, {
          ...contentScriptOptions,
          timeoutMs: 5000
        });
      } catch (_error) {
        await sleep(500);
        continue;
      }

      const errorMessage = await tryReadErrorMessage(tabId, contentScriptOptions);
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      const loginState = await tryInspectLoginState(tabId, contentScriptOptions);
      if (loginState && !loginState.loginRequired) {
        return;
      }

      const attendanceStateResponse = await tryInspectAttendanceState(tabId, contentScriptOptions);
      if (attendanceStateResponse && areAttendanceButtonsVisible(attendanceStateResponse.state)) {
        return;
      }

      await sleep(1000);
    }

    const finalErrorMessage = await tryReadErrorMessage(tabId, contentScriptOptions);
    if (finalErrorMessage) {
      throw new Error(finalErrorMessage);
    }

    const finalLoginState = await tryInspectLoginState(tabId, contentScriptOptions);
    if (finalLoginState && !finalLoginState.loginRequired) {
      return;
    }

    throw new Error("Login did not complete successfully.");
  }

  async function waitForAttendanceControls(tabId, command, progressReporter) {
    const contentScriptOptions = {
      attendanceUrl: command.attendanceUrl,
      progressReporter,
      commandId: command.commandId
    };
    const startedAt = Date.now();
    let locationTimeoutObserved = false;
    let unresolvedButtonsLogged = false;
    let lastState = null;
    let lastUrl = "";

    while (Date.now() - startedAt < ATTENDANCE_WAIT_TIMEOUT_MS) {
      const attendanceResponse = await sendContentMessage(
        tabId,
        "clockbot:inspect-attendance",
        {},
        contentScriptOptions
      );
      lastState = attendanceResponse.state;
      lastUrl = attendanceResponse.url || lastUrl;

      if (isAttendanceStateActionable(lastState, command.action)) {
        if (locationTimeoutObserved) {
          await reportLog("info", "Attendance buttons became available after a location timeout message.", {
            commandId: command.commandId,
            action: command.action,
            url: lastUrl
          });
        }

        return {
          state: lastState,
          locationTimeoutObserved,
          timedOut: false,
          url: lastUrl
        };
      }

      if (!unresolvedButtonsLogged &&
        areAttendanceButtonsVisible(lastState) &&
        !isAttendanceStateActionable(lastState, command.action)) {
        unresolvedButtonsLogged = true;
        await reportLog("warn", "Attendance labels are visible, but their clickable state is not resolved yet.", {
          commandId: command.commandId,
          action: command.action,
          url: lastUrl,
          state: lastState
        });
      }

      if (!locationTimeoutObserved && attendanceResponse.locationTimeoutObserved) {
        locationTimeoutObserved = true;
        await reportLog("warn", "IEYASU reported a location timeout. ClockBot will keep waiting for the buttons.", {
          commandId: command.commandId,
          action: command.action,
          url: lastUrl
        });
      }

      await sleep(1000);
    }

    return {
      state: lastState,
      locationTimeoutObserved,
      timedOut: true,
      url: lastUrl
    };
  }

  async function waitForPostPunchState(tabId, action, contentScriptOptions = {}) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < POST_PUNCH_WAIT_TIMEOUT_MS) {
      const attendanceResponse = await sendContentMessage(
        tabId,
        "clockbot:inspect-attendance",
        {},
        contentScriptOptions
      );
      const attendanceState = attendanceResponse.state;

      if (action === "clockIn" &&
        attendanceState.clockIn.state === "inactive" &&
        attendanceState.clockOut.state === "active") {
        return attendanceState;
      }

      if (action === "clockOut" &&
        attendanceState.clockOut.state === "inactive" &&
        attendanceState.clockIn.state === "active") {
        return attendanceState;
      }

      await sleep(1000);
    }

    return null;
  }

  async function executeCommand(command) {
    if (command.action !== "clockIn" && command.action !== "clockOut") {
      throw new Error(`Unsupported ClockBot action: ${command.action}`);
    }

    let activeTabId = null;
    const progressReporter = createCommandProgressReporter(command.commandId);
    progressReporter.start();
    executeCommand.lastProgressSnapshot = () => progressReporter.snapshot();
    const contentScriptOptions = {
      attendanceUrl: command.attendanceUrl,
      progressReporter,
      commandId: command.commandId
    };

    await progressReporter.report(
      "opening_tab",
      `Opening or focusing an IEYASU tab for ${getActionLabel(command.action)}.`
    );

    const tab = await openOrReuseAttendanceTab(command.attendanceUrl);
    if (!Number.isInteger(tab.id)) {
      throw new Error("ClockBot could not resolve the IEYASU Chrome tab.");
    }

    activeTabId = tab.id;

    await waitForInjectableTabWithRecovery(activeTabId, contentScriptOptions);
    await ensureContentScript(activeTabId, contentScriptOptions);
    await progressReporter.report(
      "tab_ready",
      "IEYASU tab is ready. Attaching the Chrome debugger input layer."
    );

    await ensureDebuggerAttached(activeTabId);

    try {
      await maybeApplyGeolocation(activeTabId, command.location, progressReporter, command.commandId);
      await ensureLoggedIn(activeTabId, command, progressReporter);

      await progressReporter.report(
        "attendance_wait",
        `Waiting for the ${getActionLabel(command.action)} button to become actionable.`
      );

      const attendanceWait = await waitForAttendanceControls(activeTabId, command, progressReporter);
      const attendanceState = attendanceWait.state;

      if (!attendanceState || !isAttendanceStateActionable(attendanceState, command.action)) {
        if (attendanceWait.timedOut) {
          throw new Error(attendanceWait.locationTimeoutObserved
            ? "The attendance buttons never became available after IEYASU reported a location timeout."
            : "The attendance buttons did not become available before the timeout.");
        }

        throw new Error("ClockBot could not resolve the attendance buttons on IEYASU.");
      }

      if (command.action === "clockIn" &&
        attendanceState.clockIn.state === "inactive" &&
        attendanceState.clockOut.state === "active") {
        return {
          status: "Skipped",
          stage: "skipped",
          message: "Clock In appears to have been completed already."
        };
      }

      if (command.action === "clockOut" &&
        attendanceState.clockOut.state === "inactive" &&
        attendanceState.clockIn.state === "active") {
        return {
          status: "Skipped",
          stage: "skipped",
          message: "Clock Out is not available because the page is already back to Clock In."
        };
      }

      const targetButton = command.action === "clockOut"
        ? attendanceState.clockOut
        : attendanceState.clockIn;

      if (targetButton.state !== "active") {
        throw new Error(`The ${getActionLabel(command.action)} button is not currently active.`);
      }

      if (!hasValidTarget(targetButton.target)) {
        throw new Error(`ClockBot found the ${getActionLabel(command.action)} button, but could not resolve a clickable target.`);
      }

      await maybeSetClockInWorkMode(activeTabId, command, progressReporter, attendanceState, contentScriptOptions);

      await progressReporter.report(
        "clicking_action",
        `Clicking ${getActionLabel(command.action)} through Chrome debugger input events.`
      );

      await pressButtonHumanized(activeTabId, targetButton.target, {
        hoverMinMs: 340,
        hoverMaxMs: 960,
        preClickPauseMinMs: 90,
        preClickPauseMaxMs: 210
      });

      await progressReporter.report(
        "confirming_result",
        "Waiting for IEYASU to confirm the post-click state change."
      );

      const confirmedState = await waitForPostPunchState(
        activeTabId,
        command.action,
        contentScriptOptions
      );
      if (!confirmedState) {
        throw new Error(`The ${getActionLabel(command.action)} action did not produce a confirmed state change.`);
      }

      return {
        status: "Success",
        stage: "completed",
        message: command.action === "clockOut"
          ? "Clock Out completed successfully."
          : "Clock In completed successfully."
      };
    } finally {
      await detachDebuggerQuietly(activeTabId);
      await closeTabAfterCommand(activeTabId);
      progressReporter.stop();
      executeCommand.lastProgressSnapshot = null;
    }
  }

  function ensureHeartbeatAlarm() {
    try {
      chrome.alarms.create(BRIDGE_POLL_ALARM, {
        periodInMinutes: HEARTBEAT_ALARM_PERIOD_MINUTES
      });
    } catch (error) {
      console.warn("ClockBot could not create the heartbeat alarm.", {
        error: toErrorMessage(error)
      });
    }
  }

  async function initialize() {
    if (state.initialized) {
      return;
    }

    state.initialized = true;
    await getOrCreateClientId();
    ensureHeartbeatAlarm();
  }

  chrome.runtime.onInstalled.addListener(() => {
    void initialize().then(() => {
      requestPoll("installed");
    });
  });

  chrome.runtime.onStartup.addListener(() => {
    void initialize().then(() => {
      requestPoll("startup");
    });
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === BRIDGE_POLL_ALARM) {
      requestPoll("alarm");
    }
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && isIeyasuUrl(tab && tab.url)) {
      requestPoll("ieyasu-tab-updated");
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source && Number.isInteger(source.tabId)) {
      delete state.mousePositions[source.tabId];
    }

    if (reason && reason !== "target_closed") {
      console.warn("ClockBot debugger detached unexpectedly.", {
        tabId: source && source.tabId,
        reason
      });
    }
  });

  void initialize().then(() => {
    requestPoll("service-worker-loaded", 500);
  });
}());
