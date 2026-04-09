const stateElements = {
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  morningTime: document.getElementById("morningTime"),
  eveningTime: document.getElementById("eveningTime"),
  extensionConnectionBadge: document.getElementById("extensionConnectionBadge"),
  automationEngineNote: document.getElementById("automationEngineNote"),
  configureBarkButton: document.getElementById("configureBarkButton"),
  barkStatusNote: document.getElementById("barkStatusNote"),
  openExtensionFolderButton: document.getElementById("openExtensionFolderButton"),
  manualActionsHint: document.getElementById("manualActionsHint"),
  clearCredentialsButton: document.getElementById("clearCredentialsButton"),
  resetScheduleButton: document.getElementById("resetScheduleButton"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmDialogTitle: document.getElementById("confirmDialogTitle"),
  confirmDialogMessage: document.getElementById("confirmDialogMessage"),
  confirmDialogCancel: document.getElementById("confirmDialogCancel"),
  confirmDialogConfirm: document.getElementById("confirmDialogConfirm"),
  clockInStatus: document.getElementById("clockInStatus"),
  clockInMessage: document.getElementById("clockInMessage"),
  clockInMeta: document.getElementById("clockInMeta"),
  clockOutStatus: document.getElementById("clockOutStatus"),
  clockOutMessage: document.getElementById("clockOutMessage"),
  clockOutMeta: document.getElementById("clockOutMeta"),
  nextRunSummary: document.getElementById("nextRunSummary"),
  toggleLogWindowButton: document.getElementById("toggleLogWindowButton"),
  closeWindowButton: document.getElementById("closeWindowButton"),
  barkDialog: document.getElementById("barkDialog"),
  barkDeviceKeyInput: document.getElementById("barkDeviceKeyInput"),
  barkIconUrlInput: document.getElementById("barkIconUrlInput"),
  barkDialogError: document.getElementById("barkDialogError"),
  barkDialogDelete: document.getElementById("barkDialogDelete"),
  barkDialogCancel: document.getElementById("barkDialogCancel"),
  barkDialogSave: document.getElementById("barkDialogSave")
};

const credentialsForm = document.getElementById("credentialsForm");
const settingsForm = document.getElementById("settingsForm");
const startMonitoringButton = document.getElementById("startMonitoringButton");
const runClockInButton = document.getElementById("runClockIn");
const runClockOutButton = document.getElementById("runClockOut");
const appShell = document.querySelector(".app-shell");

let currentState = null;
let saveSettingsTimer = null;
let resizeWindowTimer = null;
let confirmDialogResolver = null;
let hasHydratedStoredUsername = false;
const draftCredentials = {
  username: "",
  password: ""
};
const TIME_HELP_TEXT = "Use 24-hour time in HH:MM format, for example 09:00.";
const DEFAULT_MORNING_TIME = "09:00";
const DEFAULT_EVENING_TIME = "18:00";
const DEFAULT_BROWSER_PREFERENCE = "chrome";

function getBrowserAvailabilityState(state) {
  return state && state.capabilities && state.capabilities.browsers
    ? state.capabilities.browsers
    : {
      chrome: { id: "chrome", label: "Chrome", available: false, profileAvailable: false }
    };
}

function getExtensionBridgeState(state) {
  return state && state.extensionBridge
    ? state.extensionBridge
    : {
      connected: false,
      status: "waiting",
      extensionDirectory: "",
      lastSeenAt: null
    };
}

function getBarkState(state) {
  return state && state.bark
    ? state.bark
    : {
      enabled: false,
      configured: false,
      hasIcon: false
    };
}

function hasAnySupportedBrowser(state) {
  const browserAvailability = getBrowserAvailabilityState(state);
  return Boolean(browserAvailability.chrome && browserAvailability.chrome.available);
}

function getBrowserLabel() {
  return "Chrome";
}

function getSelectedBrowserPreference() {
  return DEFAULT_BROWSER_PREFERENCE;
}

function getSelectedBrowserPreferenceFromForm() {
  return DEFAULT_BROWSER_PREFERENCE;
}

function getSelectedBrowserState(state) {
  const browserAvailability = getBrowserAvailabilityState(state);

  return browserAvailability.chrome || {
    id: DEFAULT_BROWSER_PREFERENCE,
    label: getBrowserLabel(),
    available: false,
    profileAvailable: false
  };
}

function getGlobalBrowserBlockReason(state) {
  return hasAnySupportedBrowser(state)
    ? null
    : "Install Chrome to enable attendance automation.";
}

function getExtensionBrowserBlockReason(state) {
  const globalBrowserReason = getGlobalBrowserBlockReason(state);
  if (globalBrowserReason) {
    return globalBrowserReason;
  }

  const browserState = getSelectedBrowserState(state);
  if (!browserState.available) {
    return `${browserState.label} is not installed on this PC.`;
  }

  return null;
}

function getAutomationEngineBlockReason(state) {
  if (!state) {
    return null;
  }

  return getExtensionBrowserBlockReason(state);
}

function getAutomationEngineNote(state) {
  if (!state) {
    return "";
  }

  const blockReason = getAutomationEngineBlockReason(state);

  if (blockReason) {
    return blockReason;
  }

  const extensionBridge = getExtensionBridgeState(state);
  if (extensionBridge.connected) {
    return "Chrome Extension ready. ClockBot will use your regular Chrome session.";
  }

  return "Chrome Extension mode. Load the unpacked extension and keep Chrome open.";
}

function getManualActionsHint(state) {
  if (!state) {
    return "Use these buttons to run the actions manually whenever needed.";
  }

  const globalBrowserReason = getGlobalBrowserBlockReason(state);
  if (globalBrowserReason) {
    return globalBrowserReason;
  }

  return "Manual actions run through the ClockBot extension in regular Chrome.";
}

function getStoredCredentials(state) {
  return state && state.storedCredentials
    ? state.storedCredentials
    : { username: "", hasPassword: false };
}

function getActiveCredentials(state) {
  return state && state.activeCredentials
    ? state.activeCredentials
    : { username: "", hasPassword: false };
}

function formatDateTime(value) {
  if (!value) {
    return "Not scheduled.";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function formatStatusMeta(actionState) {
  if (!actionState.lastRunAt) {
    return "No attempts yet.";
  }

  return `Last update: ${formatDateTime(actionState.lastRunAt)}`;
}

function paintStatus(element, messageElement, metaElement, actionState) {
  element.textContent = actionState.status;
  element.className = "status-pill";

  const tone = actionState.status.toLowerCase();
  if (tone !== "pending") {
    element.classList.add(tone);
  }

  messageElement.textContent = actionState.message || "No details yet.";
  metaElement.textContent = formatStatusMeta(actionState);
}

function showError(error) {
  const message = error && error.message ? error.message : "The action failed.";
  void showConfirmDialog({
    title: "ClockBot",
    message,
    confirmLabel: "OK",
    hideCancel: true
  });
}

function resolveConfirmDialog(value) {
  if (!confirmDialogResolver) {
    return;
  }

  const resolve = confirmDialogResolver;
  confirmDialogResolver = null;

  if (stateElements.confirmDialog.open) {
    stateElements.confirmDialog.close();
  }

  resolve(value);
}

function showConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmTone = "primary",
  cancelLabel = "Cancel",
  hideCancel = false
}) {
  if (confirmDialogResolver) {
    resolveConfirmDialog(false);
  }

  stateElements.confirmDialogTitle.textContent = title;
  stateElements.confirmDialogMessage.textContent = message;
  stateElements.confirmDialogConfirm.textContent = confirmLabel;
  stateElements.confirmDialogCancel.textContent = cancelLabel;
  stateElements.confirmDialogCancel.hidden = hideCancel;
  stateElements.confirmDialogConfirm.className = confirmTone === "danger"
    ? "danger"
    : "primary";

  return new Promise((resolve) => {
    confirmDialogResolver = resolve;
    stateElements.confirmDialog.showModal();
    stateElements.confirmDialogConfirm.focus();
  });
}

function setBarkDialogError(message = "") {
  const nextMessage = String(message || "").trim();
  stateElements.barkDialogError.textContent = nextMessage;
  stateElements.barkDialogError.hidden = !nextMessage;
}

function closeBarkDialog() {
  if (stateElements.barkDialog.open) {
    stateElements.barkDialog.close();
  }

  setBarkDialogError("");
}

async function openBarkDialog() {
  const barkSettings = await window.clockBotApi.getBarkSettings();

  stateElements.barkDeviceKeyInput.value = barkSettings.deviceKey || "";
  stateElements.barkIconUrlInput.value = barkSettings.iconUrl || "";
  stateElements.barkDialogDelete.hidden = !barkSettings.deviceKey;
  setBarkDialogError("");
  stateElements.barkDialog.showModal();
  stateElements.barkDeviceKeyInput.focus();
  stateElements.barkDeviceKeyInput.select();
}

function normalizeTimeValue(value) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return null;
  }

  let hoursText = "";
  let minutesText = "";

  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    [hoursText, minutesText] = trimmed.split(":");
  } else if (/^\d{3,4}$/.test(trimmed)) {
    hoursText = trimmed.slice(0, trimmed.length - 2);
    minutesText = trimmed.slice(-2);
  } else {
    return null;
  }

  const hours = Number.parseInt(hoursText, 10);
  const minutes = Number.parseInt(minutesText, 10);

  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizeTimeField(input) {
  const normalized = normalizeTimeValue(input.value);

  if (normalized) {
    input.value = normalized;
  }

  return normalized;
}

function collectSettingsPayload() {
  const morningTime = normalizeTimeField(stateElements.morningTime);
  const eveningTime = normalizeTimeField(stateElements.eveningTime);

  if (!morningTime || !eveningTime) {
    throw new Error(TIME_HELP_TEXT);
  }

  return {
    morningTime,
    eveningTime,
    browserPreference: getSelectedBrowserPreferenceFromForm()
  };
}

function hasSettingsChanged(nextSettings = null) {
  if (!currentState) {
    return false;
  }

  const candidateSettings = nextSettings || collectSettingsPayload();
  return candidateSettings.morningTime !== currentState.settings.morningTime ||
    candidateSettings.eveningTime !== currentState.settings.eveningTime ||
    candidateSettings.browserPreference !== getSelectedBrowserPreference(currentState);
}

async function persistSettings() {
  if (!currentState) {
    return null;
  }

  const payload = collectSettingsPayload();

  if (!hasSettingsChanged(payload)) {
    return currentState;
  }

  const state = await window.clockBotApi.saveSettings(payload);
  render(state);
  return state;
}

async function flushPendingSettingsSave() {
  if (saveSettingsTimer) {
    clearTimeout(saveSettingsTimer);
    saveSettingsTimer = null;
  }

  return persistSettings();
}

async function saveSettingsNow() {
  try {
    return await persistSettings();
  } catch (error) {
    showError(error);

    if (currentState) {
      render(currentState);
    }

    return null;
  }
}

function queueSettingsSave() {
  if (saveSettingsTimer) {
    clearTimeout(saveSettingsTimer);
  }

  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    void saveSettingsNow();
  }, 250);
}

function renderToggleButton(state) {
  if (state.monitoringEnabled) {
    startMonitoringButton.textContent = "Stop Monitoring";
    startMonitoringButton.className = "danger";
  } else {
    startMonitoringButton.textContent = "Start Monitoring";
    startMonitoringButton.className = "primary";
  }

  renderMonitoringButtonAvailability(state);
}

function renderLogWindowButton(state) {
  stateElements.toggleLogWindowButton.textContent = state.logWindowVisible
    ? "Hide Live Log"
    : "Show Live Log";
}

function getEnteredCredentials() {
  return {
    username: stateElements.username.value.trim(),
    password: stateElements.password.value
  };
}

function hasCompleteEnteredCredentials() {
  const enteredCredentials = getEnteredCredentials();
  return Boolean(enteredCredentials.username && enteredCredentials.password);
}

function hasStoredPasswordForCurrentUsername(state) {
  const storedCredentials = getStoredCredentials(state);
  const enteredUsername = stateElements.username.value.trim();

  return Boolean(
    storedCredentials.hasPassword &&
    storedCredentials.username &&
    enteredUsername &&
    enteredUsername === storedCredentials.username
  );
}

function canStartMonitoring(state) {
  if (!state) {
    return false;
  }

  if (state.monitoringEnabled) {
    return !state.isRunning;
  }

  if (getAutomationEngineBlockReason(state)) {
    return false;
  }

  return !state.isRunning && (
    hasCompleteEnteredCredentials() ||
    hasStoredPasswordForCurrentUsername(state)
  );
}

function canRunManualActions(state) {
  if (!state || state.isRunning) {
    return false;
  }

  if (getAutomationEngineBlockReason(state)) {
    return false;
  }

  if (state.monitoringEnabled && getActiveCredentials(state).hasPassword) {
    return true;
  }

  const storedCredentials = getStoredCredentials(state);
  const enteredCredentials = getEnteredCredentials();

  if (enteredCredentials.username && enteredCredentials.password) {
    return true;
  }

  return storedCredentials.hasPassword &&
    storedCredentials.username &&
    enteredCredentials.username === storedCredentials.username;
}

function canClearCredentials(state) {
  if (!state) {
    return false;
  }

  const storedCredentials = getStoredCredentials(state);
  const activeCredentials = getActiveCredentials(state);
  const enteredCredentials = getEnteredCredentials();

  return Boolean(
    storedCredentials.username ||
    storedCredentials.hasPassword ||
    activeCredentials.username ||
    enteredCredentials.username ||
    enteredCredentials.password
  );
}

function renderManualActionAvailability(state) {
  const disabled = !canRunManualActions(state);
  runClockInButton.disabled = disabled;
  runClockOutButton.disabled = disabled;
}

function renderMonitoringButtonAvailability(state) {
  startMonitoringButton.disabled = !canStartMonitoring(state);
}

function renderClearCredentialsAvailability(state) {
  stateElements.clearCredentialsButton.disabled = !canClearCredentials(state);
}

function renderResetScheduleAvailability(state) {
  if (!state) {
    stateElements.resetScheduleButton.disabled = true;
    return;
  }

  stateElements.resetScheduleButton.disabled =
    state.settings.morningTime === DEFAULT_MORNING_TIME &&
    state.settings.eveningTime === DEFAULT_EVENING_TIME;
}

function renderEngineControls(state) {
  const barkState = getBarkState(state);

  stateElements.configureBarkButton.disabled = !state;
  stateElements.openExtensionFolderButton.disabled = !state;
  stateElements.automationEngineNote.textContent = getAutomationEngineNote(state);
  stateElements.configureBarkButton.textContent = barkState.configured
    ? "Edit Bark Push"
    : "Set Bark Push";
  stateElements.barkStatusNote.textContent = barkState.configured
    ? barkState.hasIcon
      ? "Bark push is ready, with a custom icon."
      : "Bark push is ready for iPhone notifications."
    : "Bark push is off until you add a device key.";

  const extensionBridge = getExtensionBridgeState(state);
  const badgeText = extensionBridge.connected ? "Connected" : "Waiting";
  stateElements.extensionConnectionBadge.textContent = badgeText;
  stateElements.extensionConnectionBadge.classList.toggle("connected", extensionBridge.connected);
}

function requestWindowFit() {
  if (!appShell) {
    return;
  }

  if (resizeWindowTimer) {
    window.cancelAnimationFrame(resizeWindowTimer);
  }

  resizeWindowTimer = window.requestAnimationFrame(() => {
    resizeWindowTimer = null;
    const shellRect = appShell.getBoundingClientRect();
    const shellStyle = window.getComputedStyle(appShell);
    const marginBottom = Number.parseFloat(shellStyle.marginBottom || "0");
    const targetHeight = Math.ceil(shellRect.bottom + marginBottom + 4);
    window.clockBotApi.resizeWindowToContent(targetHeight);
  });
}

function syncPasswordPlaceholder(state) {
  const storedCredentials = getStoredCredentials(state);
  const usernameValue = stateElements.username.value.trim();
  const canUseStoredPassword = storedCredentials.hasPassword &&
    storedCredentials.username &&
    usernameValue === storedCredentials.username;

  stateElements.password.placeholder = canUseStoredPassword
    ? "Saved securely"
    : "";
}

function syncDraftCredentialsToMain() {
  window.clockBotApi.updateDraftCredentials({
    username: draftCredentials.username,
    password: draftCredentials.password
  });
}

function render(state) {
  currentState = state;
  const storedCredentials = getStoredCredentials(state);
  const activeCredentials = getActiveCredentials(state);
  const usernameIsFocused = document.activeElement === stateElements.username;
  const passwordIsFocused = document.activeElement === stateElements.password;

  if (!hasHydratedStoredUsername) {
    hasHydratedStoredUsername = true;

    if (!state.monitoringEnabled && !draftCredentials.username && storedCredentials.username) {
      draftCredentials.username = storedCredentials.username;
      syncDraftCredentialsToMain();
    }
  }

  stateElements.username.disabled = state.monitoringEnabled;
  stateElements.password.disabled = state.monitoringEnabled;

  if (!usernameIsFocused) {
    stateElements.username.value = state.monitoringEnabled
      ? activeCredentials.username
      : draftCredentials.username;
  }

  if (!passwordIsFocused) {
    stateElements.password.value = state.monitoringEnabled ? "" : draftCredentials.password;
  }

  syncPasswordPlaceholder(state);
  stateElements.morningTime.value = state.settings.morningTime;
  stateElements.eveningTime.value = state.settings.eveningTime;

  renderToggleButton(state);
  renderLogWindowButton(state);
  renderEngineControls(state);
  stateElements.manualActionsHint.textContent = getManualActionsHint(state);
  renderManualActionAvailability(state);
  renderClearCredentialsAvailability(state);
  renderResetScheduleAvailability(state);

  paintStatus(
    stateElements.clockInStatus,
    stateElements.clockInMessage,
    stateElements.clockInMeta,
    state.dailyState.clockIn
  );
  paintStatus(
    stateElements.clockOutStatus,
    stateElements.clockOutMessage,
    stateElements.clockOutMeta,
    state.dailyState.clockOut
  );

  const nextRuns = [];
  if (state.monitoringEnabled && state.schedulePreview.clockIn) {
    nextRuns.push(`Clock In: ${formatDateTime(state.schedulePreview.clockIn)}`);
  }
  if (state.monitoringEnabled && state.schedulePreview.clockOut) {
    nextRuns.push(`Clock Out: ${formatDateTime(state.schedulePreview.clockOut)}`);
  }
  stateElements.nextRunSummary.textContent = nextRuns.length
    ? nextRuns.join(" | ")
    : state.monitoringEnabled
      ? "No future runs are scheduled for today."
      : "Monitoring is stopped.";

  requestWindowFit();
}

credentialsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentState) {
    return;
  }

  try {
    let state;

    if (currentState.monitoringEnabled) {
      state = await window.clockBotApi.stopMonitoring();
    } else {
      const settingsState = await flushPendingSettingsSave();
      const effectiveState = settingsState || currentState;

      if (!canStartMonitoring(effectiveState)) {
        if (!stateElements.username.value.trim()) {
          stateElements.username.focus();
        } else if (!stateElements.password.value) {
          stateElements.password.focus();
        }
        return;
      }

      const formData = new FormData(credentialsForm);
      const username = String(formData.get("username") || "").trim();
      const password = String(formData.get("password") || "");
      state = await window.clockBotApi.startMonitoring({ username, password });
    }

    render(state);
  } catch (error) {
    showError(error);
  }
});

settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

stateElements.morningTime.addEventListener("change", () => {
  queueSettingsSave();
});

stateElements.eveningTime.addEventListener("change", () => {
  queueSettingsSave();
});

stateElements.username.addEventListener("input", () => {
  const nextUsername = stateElements.username.value;
  const usernameChanged = nextUsername !== draftCredentials.username;

  draftCredentials.username = nextUsername;

  if (usernameChanged) {
    draftCredentials.password = "";
    stateElements.password.value = "";
  }

  syncDraftCredentialsToMain();
  syncPasswordPlaceholder(currentState);
  renderMonitoringButtonAvailability(currentState);
  renderManualActionAvailability(currentState);
  renderClearCredentialsAvailability(currentState);
});

stateElements.password.addEventListener("input", () => {
  draftCredentials.password = stateElements.password.value;
  syncDraftCredentialsToMain();
  renderMonitoringButtonAvailability(currentState);
  renderManualActionAvailability(currentState);
  renderClearCredentialsAvailability(currentState);
});

stateElements.toggleLogWindowButton.addEventListener("click", async () => {
  try {
    const state = await window.clockBotApi.toggleLogWindow();
    render(state);
  } catch (error) {
    showError(error);
  }
});

stateElements.openExtensionFolderButton.addEventListener("click", async () => {
  try {
    const state = await window.clockBotApi.openExtensionFolder();
    render(state);
  } catch (error) {
    showError(error);
  }
});

stateElements.configureBarkButton.addEventListener("click", async () => {
  try {
    await openBarkDialog();
  } catch (error) {
    showError(error);
  }
});

stateElements.closeWindowButton.addEventListener("click", async () => {
  try {
    await window.clockBotApi.closeWindow();
  } catch (error) {
    showError(error);
  }
});

stateElements.clearCredentialsButton.addEventListener("click", async () => {
  const confirmationText = currentState && currentState.monitoringEnabled
    ? "Clear the saved username and password from this PC? The current monitoring session will keep using the in-memory copy until you stop it."
    : "Clear the saved username and password from this PC and from this form?";

  const confirmed = await showConfirmDialog({
    title: "Clear saved info?",
    message: confirmationText,
    confirmLabel: "Clear",
    confirmTone: "danger"
  });

  if (!confirmed) {
    return;
  }

  try {
    const state = await window.clockBotApi.clearStoredCredentials();
    draftCredentials.username = "";
    draftCredentials.password = "";
    syncDraftCredentialsToMain();
    render(state);
  } catch (error) {
    showError(error);
  }
});

stateElements.resetScheduleButton.addEventListener("click", async () => {
  stateElements.morningTime.value = DEFAULT_MORNING_TIME;
  stateElements.eveningTime.value = DEFAULT_EVENING_TIME;

  try {
    const state = await window.clockBotApi.saveSettings({
      morningTime: DEFAULT_MORNING_TIME,
      eveningTime: DEFAULT_EVENING_TIME,
      browserPreference: getSelectedBrowserPreferenceFromForm()
    });
    render(state);
  } catch (error) {
    showError(error);

    if (currentState) {
      render(currentState);
    }
  }
});

runClockInButton.addEventListener("click", async () => {
  const selectedBrowserLabel = getBrowserLabel();
  const confirmed = await showConfirmDialog({
    title: "Run Clock In?",
    message: `ClockBot will open ${selectedBrowserLabel} and ask the Chrome extension to complete Clock In with your everyday session now.`,
    confirmLabel: "Run Clock In"
  });

  if (!confirmed) {
    return;
  }

  try {
    await flushPendingSettingsSave();
    const state = await window.clockBotApi.runAction({
      action: "clockIn",
      credentials: getEnteredCredentials()
    });
    render(state);
  } catch (error) {
    showError(error);
  }
});

runClockOutButton.addEventListener("click", async () => {
  const selectedBrowserLabel = getBrowserLabel();
  const confirmed = await showConfirmDialog({
    title: "Run Clock Out?",
    message: `ClockBot will open ${selectedBrowserLabel} and ask the Chrome extension to complete Clock Out with your everyday session now.`,
    confirmLabel: "Run Clock Out"
  });

  if (!confirmed) {
    return;
  }

  try {
    await flushPendingSettingsSave();
    const state = await window.clockBotApi.runAction({
      action: "clockOut",
      credentials: getEnteredCredentials()
    });
    render(state);
  } catch (error) {
    showError(error);
  }
});

window.clockBotApi.onStateChanged(render);
window.clockBotApi.getState().then(render);

stateElements.confirmDialogCancel.addEventListener("click", () => {
  resolveConfirmDialog(false);
});

stateElements.confirmDialogConfirm.addEventListener("click", () => {
  resolveConfirmDialog(true);
});

stateElements.confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  resolveConfirmDialog(false);
});

stateElements.confirmDialog.addEventListener("click", (event) => {
  if (event.target === stateElements.confirmDialog) {
    resolveConfirmDialog(false);
  }
});

stateElements.barkDialogSave.addEventListener("click", async () => {
  const deviceKey = stateElements.barkDeviceKeyInput.value.trim();
  const iconUrl = stateElements.barkIconUrlInput.value.trim();

  if (!deviceKey) {
    setBarkDialogError("Device key is required.");
    stateElements.barkDeviceKeyInput.focus();
    return;
  }

  try {
    const state = await window.clockBotApi.saveBarkSettings({
      deviceKey,
      iconUrl
    });
    closeBarkDialog();
    render(state);
  } catch (error) {
    setBarkDialogError(error && error.message ? error.message : "Bark settings could not be saved.");
  }
});

stateElements.barkDialogDelete.addEventListener("click", async () => {
  try {
    const state = await window.clockBotApi.clearBarkSettings();
    closeBarkDialog();
    render(state);
  } catch (error) {
    setBarkDialogError(error && error.message ? error.message : "Bark settings could not be cleared.");
  }
});

stateElements.barkDialogCancel.addEventListener("click", () => {
  closeBarkDialog();
});

stateElements.barkDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeBarkDialog();
});

stateElements.barkDialog.addEventListener("click", (event) => {
  if (event.target === stateElements.barkDialog) {
    closeBarkDialog();
  }
});

stateElements.barkDeviceKeyInput.addEventListener("input", () => {
  if (!stateElements.barkDialogError.hidden) {
    setBarkDialogError("");
  }
});

stateElements.barkIconUrlInput.addEventListener("input", () => {
  if (!stateElements.barkDialogError.hidden) {
    setBarkDialogError("");
  }
});

if (appShell && typeof window.ResizeObserver === "function") {
  const resizeObserver = new window.ResizeObserver(() => {
    requestWindowFit();
  });
  resizeObserver.observe(appShell);
}
