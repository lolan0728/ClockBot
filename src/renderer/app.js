const stateElements = {
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  morningTime: document.getElementById("morningTime"),
  eveningTime: document.getElementById("eveningTime"),
  showBrowser: document.getElementById("showBrowser"),
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
  closeWindowButton: document.getElementById("closeWindowButton")
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
    showBrowser: stateElements.showBrowser.checked
  };
}

function hasSettingsChanged(nextSettings = null) {
  if (!currentState) {
    return false;
  }

  const candidateSettings = nextSettings || collectSettingsPayload();
  return candidateSettings.morningTime !== currentState.settings.morningTime ||
    candidateSettings.eveningTime !== currentState.settings.eveningTime ||
    candidateSettings.showBrowser !== currentState.settings.showBrowser;
}

async function saveSettingsNow() {
  try {
    const payload = collectSettingsPayload();

    if (!hasSettingsChanged(payload)) {
      return;
    }

    const state = await window.clockBotApi.saveSettings(payload);
    render(state);
  } catch (error) {
    showError(error);

    if (currentState) {
      render(currentState);
    }
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

  return !state.isRunning && (
    hasCompleteEnteredCredentials() ||
    hasStoredPasswordForCurrentUsername(state)
  );
}

function canRunManualActions(state) {
  if (!state || state.isRunning) {
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
  stateElements.showBrowser.checked = state.settings.showBrowser;

  renderToggleButton(state);
  renderLogWindowButton(state);
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
      if (!canStartMonitoring(currentState)) {
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

stateElements.showBrowser.addEventListener("change", () => {
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
      showBrowser: stateElements.showBrowser.checked
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
  const confirmed = await showConfirmDialog({
    title: "Run Clock In?",
    message: "ClockBot will sign in and try to press the attendance button now.",
    confirmLabel: "Run Clock In"
  });

  if (!confirmed) {
    return;
  }

  try {
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
  const confirmed = await showConfirmDialog({
    title: "Run Clock Out?",
    message: "ClockBot will sign in and try to press the leave button now.",
    confirmLabel: "Run Clock Out"
  });

  if (!confirmed) {
    return;
  }

  try {
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

if (appShell && typeof window.ResizeObserver === "function") {
  const resizeObserver = new window.ResizeObserver(() => {
    requestWindowFit();
  });
  resizeObserver.observe(appShell);
}
