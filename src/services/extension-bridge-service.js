const http = require("http");
const path = require("path");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const { getBrowserProfileState } = require("./browser-service");
const { getSystemLocation } = require("./system-location-service");

const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 38473;
const CLIENT_STALE_TIMEOUT_MS = 4500;
const CONNECTION_MONITOR_INTERVAL_MS = 1000;
const COMMAND_DISCONNECT_GRACE_MS = CLIENT_STALE_TIMEOUT_MS + 1200;
const COMMAND_PICKUP_GRACE_MS = 1800;
const COMMAND_RELAUNCH_COOLDOWN_MS = 6500;
const CLIENT_CONNECT_TIMEOUT_MS = 20000;
const COMMAND_TIMEOUT_MS = 180000;
const COMMAND_POLL_INTERVAL_MS = 1500;
const PROGRESS_STAGE_LOG_LEVELS = Object.freeze({
  recovering_error_page: "warn"
});
const VALID_RESULT_STATUSES = new Set([
  "Success",
  "Failed",
  "Skipped"
]);

function delay(timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 1024 * 1024) {
        reject(new Error("Request body exceeded 1 MB."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!rawBody.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error("Request body was not valid JSON."));
      }
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
}

function getActionLabel(action) {
  return action === "clockOut" ? "Clock Out" : "Clock In";
}

function toIsoTimestamp(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

class ExtensionBridgeService extends EventEmitter {
  constructor(log, options = {}) {
    super();
    this.log = log;
    this.host = options.host || DEFAULT_BRIDGE_HOST;
    this.port = Number.isInteger(options.port) ? options.port : DEFAULT_BRIDGE_PORT;
    this.extensionDirectory = options.extensionDirectory || path.join(process.cwd(), "browser-extension");
    this.server = null;
    this.serverListenPromise = null;
    this.pendingCommand = null;
    this.clientState = {
      clientId: null,
      extensionVersion: null,
      browserVersion: null,
      lastSeenAt: null
    };
    this.lastKnownConnected = false;
    this.connectionMonitorTimer = null;
  }

  async start() {
    if (this.server) {
      return this.serverListenPromise;
    }

    this.server = http.createServer((request, response) => {
      void this.#handleRequest(request, response);
    });

    this.serverListenPromise = new Promise((resolve, reject) => {
      const handleError = (error) => {
        reject(error);
      };

      this.server.once("error", handleError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener("error", handleError);
        this.connectionMonitorTimer = setInterval(() => {
          this.#emitStateIfConnectionChanged();
          this.#failPendingCommandIfClientWentAway();
        }, CONNECTION_MONITOR_INTERVAL_MS);

        if (typeof this.connectionMonitorTimer.unref === "function") {
          this.connectionMonitorTimer.unref();
        }

        this.log.info("ClockBot extension bridge is listening.", {
          host: this.host,
          port: this.port,
          extensionDirectory: this.extensionDirectory
        });
        this.#emitStateIfConnectionChanged(true);
        resolve();
      });
    });

    return this.serverListenPromise;
  }

  async stop() {
    if (this.connectionMonitorTimer) {
      clearInterval(this.connectionMonitorTimer);
      this.connectionMonitorTimer = null;
    }

    if (this.pendingCommand) {
      this.#rejectPendingCommand(new Error("ClockBot extension bridge stopped while a task was running."));
    }

    if (!this.server) {
      return;
    }

    await new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });

    this.server = null;
    this.serverListenPromise = null;
    this.clientState = {
      clientId: null,
      extensionVersion: null,
      browserVersion: null,
      lastSeenAt: null
    };
    this.#emitStateIfConnectionChanged(true);
  }

  getPublicState() {
    const connected = this.#isClientConnected();

    return {
      host: this.host,
      port: this.port,
      serviceUrl: `http://${this.host}:${this.port}`,
      connected,
      status: connected ? "connected" : "waiting",
      clientId: this.clientState.clientId,
      extensionVersion: this.clientState.extensionVersion,
      browserVersion: this.clientState.browserVersion,
      lastSeenAt: this.clientState.lastSeenAt,
      extensionDirectory: this.extensionDirectory,
      hasPendingCommand: Boolean(this.pendingCommand)
    };
  }

  getExtensionDirectory() {
    return this.extensionDirectory;
  }

  async runAction({ action, credentials, attendanceUrl, clockInWorkModePreference, onProgress }) {
    await this.start();

    if (this.pendingCommand) {
      throw new Error("ClockBot is already waiting for the Chrome extension to finish another task.");
    }

    const browserState = getBrowserProfileState("chrome");

    if (!browserState || !browserState.available || !browserState.executablePath) {
      throw new Error("Chrome is not installed on this PC.");
    }

    const location = await getSystemLocation(this.log);
    const commandId = randomUUID();

    return new Promise(async (resolve, reject) => {
      const command = {
        id: commandId,
        action,
        credentials: {
          username: credentials.username,
          password: credentials.password
        },
        attendanceUrl,
        clockInWorkModePreference,
        location,
        createdAt: toIsoTimestamp(),
        dispatchedAt: null,
        onProgress,
        resolve,
        reject,
        timeoutHandle: null,
        lastProgressKey: "",
        lastProgressStage: "",
        lastProgressMessage: "",
        launchAttempts: 0,
        lastLaunchAt: 0,
        startedWithExtensionConnected: this.#isClientConnected()
      };

      this.pendingCommand = command;
      this.#emitStateIfConnectionChanged(true);
      this.#emitProgress(command, {
        stage: "queued",
        message: `Queued ${getActionLabel(action)} for the Chrome extension.`
      });

      try {
        command.timeoutHandle = setTimeout(() => {
          this.#rejectPendingCommand(new Error(
            `The ClockBot Chrome extension did not finish in time. Load the unpacked extension from ${this.extensionDirectory} and keep Chrome open.`
          ));
        }, COMMAND_TIMEOUT_MS);

        if (typeof command.timeoutHandle.unref === "function") {
          command.timeoutHandle.unref();
        }

        if (!command.startedWithExtensionConnected) {
          this.#launchChromeForCommand(command, browserState, {
            stage: "launching_browser",
            message: "Ensuring Chrome is open with your everyday profile."
          });
        } else {
          this.#emitProgress(command, {
            stage: "browser_already_ready",
            message: "Chrome is already open and the extension is online."
          });
        }

        this.#emitProgress(command, {
          stage: "waiting_extension",
          message: "Waiting for the Chrome extension to pick up the task."
        });

        await this.#waitForCommandPickup(command, browserState, CLIENT_CONNECT_TIMEOUT_MS);
      } catch (error) {
        this.#rejectPendingCommand(error);
      }
    });
  }

  #launchChromeForCommand(command, browserState, progress) {
    command.lastLaunchAt = Date.now();
    this.#launchChrome(command, browserState);
    command.launchAttempts += 1;

    if (progress) {
      this.#emitProgress(command, progress);
    }
  }

  #launchChrome(command, browserState) {
    const argumentsList = [];

    if (browserState.profileDirectoryName) {
      argumentsList.push(`--profile-directory=${browserState.profileDirectoryName}`);
    }

    try {
      const child = spawn(browserState.executablePath, argumentsList, {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });

      child.unref();

      this.log.info("Launching Chrome normally for extension automation.", {
        executablePath: browserState.executablePath,
        profileDirectoryName: browserState.profileDirectoryName || null,
        commandId: command ? command.id : null,
        action: command ? command.action : null,
        launchAttempt: command ? command.launchAttempts + 1 : 1,
        coldStart: command ? !command.startedWithExtensionConnected : null
      });
    } catch (error) {
      throw new Error(`Could not launch Chrome. ${error && error.message ? error.message : String(error)}`);
    }
  }

  async #waitForCommandPickup(command, browserState, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (!this.pendingCommand || this.pendingCommand.id !== command.id) {
        throw new Error("The queued Chrome extension task was cleared before it could start.");
      }

      if (command.dispatchedAt) {
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      const timeSinceLastLaunchMs = command.lastLaunchAt > 0
        ? Date.now() - command.lastLaunchAt
        : Number.POSITIVE_INFINITY;
      const shouldAttemptRecoveryLaunch = command.launchAttempts < 2 &&
        elapsedMs >= COMMAND_PICKUP_GRACE_MS &&
        !this.#isClientConnected() &&
        timeSinceLastLaunchMs >= COMMAND_RELAUNCH_COOLDOWN_MS;

      if (shouldAttemptRecoveryLaunch) {
        this.#launchChromeForCommand(command, browserState, {
          stage: "launching_browser_retry",
          message: "Chrome is still offline, so ClockBot is reopening it with your everyday profile."
        });
      }

      await delay(400);
    }

    throw new Error(
      `ClockBot could not reach the Chrome extension. Load the unpacked extension from ${this.extensionDirectory}, then open Chrome and try again.`
    );
  }

  #touchClientState(payload = {}) {
    this.clientState = {
      clientId: typeof payload.clientId === "string" && payload.clientId.trim()
        ? payload.clientId.trim()
        : this.clientState.clientId,
      extensionVersion: typeof payload.extensionVersion === "string" && payload.extensionVersion.trim()
        ? payload.extensionVersion.trim()
        : this.clientState.extensionVersion,
      browserVersion: typeof payload.browserVersion === "string" && payload.browserVersion.trim()
        ? payload.browserVersion.trim()
        : this.clientState.browserVersion,
      lastSeenAt: toIsoTimestamp()
    };

    this.#emitStateIfConnectionChanged(true);
  }

  #isClientConnected() {
    if (!this.clientState.lastSeenAt) {
      return false;
    }

    return Date.now() - new Date(this.clientState.lastSeenAt).getTime() < CLIENT_STALE_TIMEOUT_MS;
  }

  #emitStateIfConnectionChanged(force = false) {
    const connected = this.#isClientConnected();

    if (force || connected !== this.lastKnownConnected) {
      this.lastKnownConnected = connected;
      this.emit("state-changed", this.getPublicState());
    }
  }

  #failPendingCommandIfClientWentAway() {
    if (!this.pendingCommand || !this.pendingCommand.dispatchedAt) {
      return;
    }

    if (this.#isClientConnected()) {
      return;
    }

    const lastSeenAt = this.clientState.lastSeenAt
      ? new Date(this.clientState.lastSeenAt).getTime()
      : 0;
    const silenceMs = lastSeenAt > 0
      ? Date.now() - lastSeenAt
      : Number.POSITIVE_INFINITY;

    if (silenceMs < COMMAND_DISCONNECT_GRACE_MS) {
      return;
    }

    const actionLabel = getActionLabel(this.pendingCommand.action);
    this.log.warn("Chrome extension connection dropped while a ClockBot task was running.", {
      commandId: this.pendingCommand.id,
      action: this.pendingCommand.action,
      lastSeenAt: this.clientState.lastSeenAt,
      silenceMs
    });
    this.#emitProgress(this.pendingCommand, {
      stage: "extension_disconnected",
      message: `Chrome was closed before ${actionLabel} finished.`
    });
    this.#rejectPendingCommand(new Error(
      `Chrome was closed before ${actionLabel} finished. Keep Chrome open until the task completes.`
    ));
  }

  #emitProgress(command, progress) {
    if (!command || typeof command.onProgress !== "function") {
      return;
    }

    const payload = {
      stage: progress.stage || "",
      message: progress.message || "",
      updatedAt: progress.updatedAt || toIsoTimestamp()
    };
    command.lastProgressStage = payload.stage;
    command.lastProgressMessage = payload.message;

    try {
      command.onProgress(payload);
    } catch (_error) {
      // Ignore renderer progress callback errors.
    }
  }

  #resolvePendingCommand(result) {
    if (!this.pendingCommand) {
      return;
    }

    const command = this.pendingCommand;
    this.pendingCommand = null;

    if (command.timeoutHandle) {
      clearTimeout(command.timeoutHandle);
    }

    this.#emitStateIfConnectionChanged(true);
    command.resolve(result);
  }

  #rejectPendingCommand(error) {
    if (!this.pendingCommand) {
      return;
    }

    const command = this.pendingCommand;
    this.pendingCommand = null;

    if (command.timeoutHandle) {
      clearTimeout(command.timeoutHandle);
    }

    this.#emitStateIfConnectionChanged(true);
    command.reject(error);
  }

  async #handleRequest(request, response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url, `http://${this.host}:${this.port}`);

    try {
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        this.#respondJson(response, 200, {
          ok: true,
          bridge: this.getPublicState()
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/extension/hello") {
        const payload = await readJsonBody(request);
        this.#touchClientState(payload);

        this.#respondJson(response, 200, {
          ok: true,
          pollIntervalMs: COMMAND_POLL_INTERVAL_MS,
          bridge: this.getPublicState()
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/extension/commands/next") {
        this.#touchClientState({
          clientId: requestUrl.searchParams.get("clientId") || this.clientState.clientId
        });

        if (!this.pendingCommand || this.pendingCommand.dispatchedAt) {
          this.#respondJson(response, 200, {
            commandId: null,
            pollAfterMs: COMMAND_POLL_INTERVAL_MS
          });
          return;
        }

        this.pendingCommand.dispatchedAt = toIsoTimestamp();
        this.#emitProgress(this.pendingCommand, {
          stage: "extension_picked_up",
          message: "Chrome extension picked up the task."
        });
        this.log.info("Chrome extension picked up a ClockBot task.", {
          commandId: this.pendingCommand.id,
          action: this.pendingCommand.action,
          coldStart: !this.pendingCommand.startedWithExtensionConnected,
          launchAttempts: this.pendingCommand.launchAttempts
        });

        this.#respondJson(response, 200, {
          commandId: this.pendingCommand.id,
          action: this.pendingCommand.action,
          attendanceUrl: this.pendingCommand.attendanceUrl,
          clockInWorkModePreference: this.pendingCommand.clockInWorkModePreference,
          credentials: this.pendingCommand.credentials,
          location: this.pendingCommand.location
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/extension/progress") {
        const payload = await readJsonBody(request);
        this.#touchClientState(payload);

        if (this.pendingCommand && payload.commandId === this.pendingCommand.id) {
          const progressKey = `${payload.stage || ""}::${payload.message || ""}`;

          if (progressKey !== this.pendingCommand.lastProgressKey) {
            this.pendingCommand.lastProgressKey = progressKey;
            this.#logInterestingProgress(this.pendingCommand, payload);
            this.#emitProgress(this.pendingCommand, {
              stage: payload.stage || "",
              message: payload.message || "",
              updatedAt: payload.updatedAt || toIsoTimestamp()
            });
          }
        }

        this.#respondJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/extension/result") {
        const payload = await readJsonBody(request);
        this.#touchClientState(payload);

        if (!this.pendingCommand || payload.commandId !== this.pendingCommand.id) {
          this.#respondJson(response, 404, {
            ok: false,
            error: "No matching ClockBot command was waiting."
          });
          return;
        }

        const status = typeof payload.status === "string" ? payload.status.trim() : "";
        const message = typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : "The Chrome extension finished without a message.";

        if (!VALID_RESULT_STATUSES.has(status)) {
          this.#respondJson(response, 400, {
            ok: false,
            error: "Unsupported result status."
          });
          return;
        }

        this.#emitProgress(this.pendingCommand, {
          stage: payload.stage || "completed",
          message
        });

        this.#resolvePendingCommand({
          status,
          message
        });

        this.#respondJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/extension/log") {
        const payload = await readJsonBody(request);
        this.#touchClientState(payload);

        const level = typeof payload.level === "string"
          ? payload.level.trim().toLowerCase()
          : "info";
        const message = typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : "Chrome extension log entry.";
        const context = payload.context && typeof payload.context === "object"
          ? payload.context
          : undefined;

        if (level === "error") {
          this.log.error(`Extension: ${message}`, context);
        } else if (level === "warn") {
          this.log.warn(`Extension: ${message}`, context);
        } else {
          this.log.info(`Extension: ${message}`, context);
        }

        this.#respondJson(response, 200, { ok: true });
        return;
      }

      this.#respondJson(response, 404, {
        ok: false,
        error: "Not found."
      });
    } catch (error) {
      this.#respondJson(response, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  #respondJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify(payload));
  }

  #logInterestingProgress(command, payload = {}) {
    const logLevel = PROGRESS_STAGE_LOG_LEVELS[payload.stage];

    if (!logLevel) {
      return;
    }

    const context = {
      commandId: command.id,
      action: command.action,
      stage: payload.stage,
      message: payload.message || "",
      coldStart: !command.startedWithExtensionConnected,
      launchAttempts: command.launchAttempts
    };

    if (logLevel === "warn") {
      this.log.warn(`Extension progress: ${payload.message || payload.stage}`, context);
      return;
    }

    this.log.info(`Extension progress: ${payload.message || payload.stage}`, context);
  }
}

module.exports = {
  ExtensionBridgeService
};
