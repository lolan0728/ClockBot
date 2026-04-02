const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { shell } = require("electron");

const PAD_RUN_TIMEOUT_MS = 300000;
const PAD_LAUNCH_TIMEOUT_MS = 15000;
const PAD_INITIAL_PROGRESS_TIMEOUT_MS = 45000;
const PAD_PROGRESS_STALE_TIMEOUT_MS = 90000;
const PAD_POLL_INTERVAL_MS = 1000;
const VALID_RESULT_STATUSES = new Set([
  "Success",
  "Failed",
  "Skipped"
]);

function getActionLabel(action) {
  return action === "clockOut" ? "Clock Out" : "Clock In";
}

function isPadAvailable() {
  return process.platform === "win32";
}

function getPadConfigError(padConfig) {
  if (!isPadAvailable()) {
    return "Power Automate Desktop is available on Windows only.";
  }

  const workflowName = padConfig && typeof padConfig.workflowName === "string"
    ? padConfig.workflowName.trim()
    : "";

  if (!workflowName) {
    return "Configure a PAD workflow name before running this automation.";
  }

  return null;
}

function buildPadRunUrl({ workflowName, environmentId, inputArguments }) {
  const searchParams = new URLSearchParams();
  searchParams.set("workflowName", workflowName);
  searchParams.set("inputArguments", JSON.stringify(inputArguments));

  if (environmentId) {
    searchParams.set("environmentId", environmentId);
  }

  return `ms-powerautomate:/console/flow/run?${searchParams.toString()}`;
}

function delay(timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function parsePadResult(raw, expectedRunId) {
  const normalized = typeof raw === "string" && raw.charCodeAt(0) === 0xFEFF
    ? raw.slice(1)
    : raw;
  const parsed = JSON.parse(normalized);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("PAD result.json did not contain an object.");
  }

  if (parsed.runId !== expectedRunId) {
    throw new Error("PAD result.json runId did not match the current request.");
  }

  const status = typeof parsed.status === "string" ? parsed.status.trim() : "";
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";

  if (!VALID_RESULT_STATUSES.has(status)) {
    throw new Error(`PAD result.json returned an unsupported status: ${status || "<empty>"}.`);
  }

  if (!message) {
    throw new Error("PAD result.json did not include a message.");
  }

  return {
    status,
    message,
    completedAt: typeof parsed.completedAt === "string" && parsed.completedAt.trim()
      ? parsed.completedAt.trim()
      : new Date().toISOString()
  };
}

function parsePadProgress(raw, expectedRunId) {
  const normalized = typeof raw === "string" && raw.charCodeAt(0) === 0xFEFF
    ? raw.slice(1)
    : raw;
  const parsed = JSON.parse(normalized);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("PAD progress.json did not contain an object.");
  }

  if (typeof parsed.runId === "string" && parsed.runId.trim() && parsed.runId !== expectedRunId) {
    throw new Error("PAD progress.json runId did not match the current request.");
  }

  return {
    stage: typeof parsed.stage === "string" ? parsed.stage.trim() : "",
    message: typeof parsed.message === "string" ? parsed.message.trim() : "",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt.trim() : ""
  };
}

function readJsonFile(filePath, parser, expectedRunId) {
  const raw = fs.readFileSync(filePath, "utf8");

  if (!raw.trim()) {
    throw new Error(`${path.basename(filePath)} is empty.`);
  }

  return parser(raw, expectedRunId);
}

function emitPadProgress(onProgress, payload) {
  if (typeof onProgress !== "function") {
    return;
  }

  try {
    onProgress(payload);
  } catch (_error) {
    // Ignore UI progress callback failures so the PAD run can continue.
  }
}

async function waitForPadResult({ action, resultFilePath, progressFilePath, runId, timeoutMs, log, onProgress }) {
  const startedAt = Date.now();
  let lastReadIssue = null;
  let lastProgressIssue = null;
  let lastProgressAtMs = null;
  let lastProgressStage = "";
  let lastProgressMessage = "";
  let sawProgress = false;
  let reportedMissingProgress = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(resultFilePath)) {
      try {
        return readJsonFile(resultFilePath, parsePadResult, runId);
      } catch (error) {
        lastReadIssue = error && error.message ? error.message : String(error);
      }
    }

    if (fs.existsSync(progressFilePath)) {
      try {
        const progress = readJsonFile(progressFilePath, parsePadProgress, runId);
        const stats = fs.statSync(progressFilePath);
        sawProgress = true;
        lastProgressIssue = null;
        lastProgressAtMs = stats.mtimeMs;

        if (progress.stage !== lastProgressStage || progress.message !== lastProgressMessage) {
          lastProgressStage = progress.stage;
          lastProgressMessage = progress.message;
          const progressSummary = progress.message || progress.stage || "Progress updated.";
          const stageSuffix = progress.stage ? ` (${progress.stage})` : "";
          log.info(`${getActionLabel(action)} progress: ${progressSummary}${stageSuffix}`, {
            action,
            runId,
            stage: progress.stage || null,
            message: progress.message || null,
            updatedAt: progress.updatedAt || null
          });
          emitPadProgress(onProgress, {
            action,
            runId,
            stage: progress.stage || "",
            message: progress.message || "",
            updatedAt: progress.updatedAt || new Date(stats.mtimeMs).toISOString()
          });
        }
      } catch (error) {
        lastProgressIssue = error && error.message ? error.message : String(error);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (!sawProgress && elapsedMs >= PAD_INITIAL_PROGRESS_TIMEOUT_MS && !reportedMissingProgress) {
      reportedMissingProgress = true;

      log.warn("PAD has not reported progress yet. Continuing to wait for result.json because heartbeat is optional until the flow writes progress.json.", {
        runId,
        progressFilePath,
        timeoutMs: PAD_INITIAL_PROGRESS_TIMEOUT_MS,
        lastProgressIssue
      });
    }

    if (sawProgress && lastProgressAtMs && Date.now() - lastProgressAtMs >= PAD_PROGRESS_STALE_TIMEOUT_MS) {
      const progressSummary = lastProgressStage || lastProgressMessage
        ? ` Last progress: ${lastProgressStage || "unknown stage"}${lastProgressMessage ? ` (${lastProgressMessage})` : ""}.`
        : "";

      log.warn("PAD stopped updating progress.json before result.json was written.", {
        runId,
        progressFilePath,
        staleAfterMs: PAD_PROGRESS_STALE_TIMEOUT_MS,
        lastProgressStage: lastProgressStage || null,
        lastProgressMessage: lastProgressMessage || null,
        lastProgressIssue
      });

      throw new Error(`PAD stopped reporting progress before completion.${progressSummary}`);
    }

    await delay(PAD_POLL_INTERVAL_MS);
  }

  log.warn("Timed out while waiting for PAD result.json.", {
    runId,
    resultFilePath,
    timeoutMs,
    lastReadIssue,
    sawProgress,
    lastProgressStage: lastProgressStage || null,
    lastProgressMessage: lastProgressMessage || null,
    lastProgressIssue
  });

  if (lastReadIssue) {
    throw new Error(`PAD did not produce a valid result.json before timeout. Last issue: ${lastReadIssue}`);
  }

  if (sawProgress) {
    const progressSummary = lastProgressStage || lastProgressMessage
      ? ` Last progress: ${lastProgressStage || "unknown stage"}${lastProgressMessage ? ` (${lastProgressMessage})` : ""}.`
      : "";
    throw new Error(`PAD did not produce result.json before timeout.${progressSummary}`);
  }

  if (lastProgressIssue) {
    throw new Error(`PAD did not produce result.json before timeout. PAD progress.json was also invalid: ${lastProgressIssue}`);
  }

  throw new Error("PAD did not produce result.json before timeout.");
}

async function performPadAttendanceAction({ action, credentials, attendanceUrl, padConfig, baseDirectory, log, onProgress }) {
  const configError = getPadConfigError(padConfig);

  if (configError) {
    throw new Error(configError);
  }

  const workflowName = padConfig.workflowName.trim();
  const environmentId = typeof padConfig.environmentId === "string"
    ? padConfig.environmentId.trim()
    : "";
  const runId = randomUUID();
  const runDirectory = path.join(baseDirectory, "pad-runs", runId);
  const requestFilePath = path.join(runDirectory, "request.json");
  const progressFilePath = path.join(runDirectory, "progress.json");
  const resultFilePath = path.join(runDirectory, "result.json");

  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(requestFilePath, JSON.stringify({
    runId,
    action,
    attendanceUrl,
    credentials: {
      username: credentials.username,
      password: credentials.password
    },
    progressFilePath,
    progressTimeoutMs: PAD_PROGRESS_STALE_TIMEOUT_MS,
    requestedAt: new Date().toISOString()
  }, null, 2), "utf8");

  const padUrl = buildPadRunUrl({
    workflowName,
    environmentId,
    inputArguments: {
      requestFilePath,
      progressFilePath,
      resultFilePath,
      runId
    }
  });

  log.info(`Launching PAD workflow for ${action}.`, {
    action,
    runId,
    workflowName,
    environmentId: environmentId || null,
    progressFilePath,
    resultFilePath
  });

  try {
    try {
      await withTimeout(
        shell.openExternal(padUrl),
        PAD_LAUNCH_TIMEOUT_MS,
        `Power Automate Desktop did not respond while launching '${workflowName}'. Check whether PAD is showing a confirmation dialog or a connection error.`
      );
    } catch (error) {
      throw new Error(`Failed to launch PAD workflow '${workflowName}'. ${error && error.message ? error.message : String(error)}`);
    }

    const result = await waitForPadResult({
      action,
      resultFilePath,
      progressFilePath,
      runId,
      timeoutMs: PAD_RUN_TIMEOUT_MS,
      log,
      onProgress
    });

    return {
      status: result.status,
      message: result.message
    };
  } finally {
    try {
      if (fs.existsSync(requestFilePath)) {
        fs.unlinkSync(requestFilePath);
      }
    } catch (error) {
      log.warn("Failed to remove PAD request.json after run completion.", {
        runId,
        message: error && error.message ? error.message : String(error)
      });
    }
  }
}

module.exports = {
  getPadConfigError,
  isPadAvailable,
  performPadAttendanceAction
};
