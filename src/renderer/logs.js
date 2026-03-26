const stateElements = {
  closeWindowButton: document.getElementById("closeWindowButton"),
  logSummary: document.getElementById("logSummary"),
  logPanel: document.getElementById("logPanel")
};

function formatDateTime(value, includeSeconds = false) {
  if (!value) {
    return "Not scheduled.";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    hour12: false
  }).format(new Date(value));
}

function buildSummary(state) {
  if (!state.monitoringEnabled) {
    return "Monitoring is stopped. Logs continue to update while the app is running.";
  }

  const clockIn = state.schedulePreview.clockIn
    ? `Clock In ${formatDateTime(state.schedulePreview.clockIn)}`
    : "Clock In not scheduled";
  const clockOut = state.schedulePreview.clockOut
    ? `Clock Out ${formatDateTime(state.schedulePreview.clockOut)}`
    : "Clock Out not scheduled";

  return `${clockIn} | ${clockOut}`;
}

function paintLogs(entries) {
  stateElements.logPanel.innerHTML = "";

  if (!entries.length) {
    stateElements.logPanel.textContent = "No log entries yet.";
    return;
  }

  entries.forEach((entry) => {
    const line = document.createElement("div");
    line.className = "log-entry";
    line.textContent = `[${formatDateTime(entry.timestamp, true)}] [${entry.level}] ${entry.message}`;
    stateElements.logPanel.appendChild(line);
  });

  stateElements.logPanel.scrollTop = stateElements.logPanel.scrollHeight;
}

function render(state) {
  stateElements.logSummary.textContent = buildSummary(state);
  paintLogs(state.logs || []);
}

stateElements.closeWindowButton.addEventListener("click", async () => {
  await window.clockBotApi.closeWindow();
});

window.clockBotApi.onStateChanged(render);
window.clockBotApi.getState().then(render);
