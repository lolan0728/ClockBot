const fs = require("fs");
const path = require("path");

const DEFAULT_BARK_CONFIG = Object.freeze({
  enabled: false,
  serverOrigin: "https://api.day.app",
  deviceKey: "",
  group: "clockbot",
  iconUrl: ""
});
const REQUEST_TIMEOUT_MS = 5000;

function sanitizeServerOrigin(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return DEFAULT_BARK_CONFIG.serverOrigin;
  }

  try {
    const parsed = new URL(candidate.trim());

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_BARK_CONFIG.serverOrigin;
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch (error) {
    return DEFAULT_BARK_CONFIG.serverOrigin;
  }
}

function sanitizeDeviceKey(candidate) {
  return typeof candidate === "string"
    ? candidate.trim()
    : "";
}

function sanitizeGroup(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return DEFAULT_BARK_CONFIG.group;
  }

  return candidate.trim().slice(0, 64);
}

function sanitizeIconUrl(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return "";
  }

  try {
    const parsed = new URL(candidate.trim());

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }

    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function normalizeSourceLabel(source) {
  if (source === "scheduled") {
    return "Scheduled";
  }

  if (source === "manual") {
    return "Manual";
  }

  return "App";
}

function normalizeDetailText(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTimestamp(timestamp) {
  const value = timestamp ? new Date(timestamp) : new Date();

  if (Number.isNaN(value.getTime())) {
    return new Date().toLocaleString("zh-CN", { hour12: false });
  }

  return value.toLocaleString("zh-CN", { hour12: false });
}

class BarkService {
  constructor(log, options = {}) {
    this.log = log;
    this.baseDirectory = options.baseDirectory || process.cwd();
    this.filePath = options.filePath || path.join(this.baseDirectory, "bark-settings.json");
    this.config = { ...DEFAULT_BARK_CONFIG };
  }

  load() {
    fs.mkdirSync(this.baseDirectory, { recursive: true });

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "");
        this.config = this.#sanitize(JSON.parse(raw));
      } catch (error) {
        this.config = { ...DEFAULT_BARK_CONFIG };
      }
    }

    this.#persist();
    return this.getConfig();
  }

  getConfig() {
    return { ...this.config };
  }

  getPublicState() {
    return {
      enabled: this.config.enabled,
      configured: Boolean(this.config.deviceKey),
      hasIcon: Boolean(this.config.iconUrl)
    };
  }

  isReady() {
    return Boolean(this.config.enabled && this.config.deviceKey);
  }

  save(candidate = {}) {
    const nextConfig = this.#sanitize({
      ...this.config,
      ...candidate
    });

    nextConfig.enabled = Boolean(nextConfig.deviceKey);
    this.config = nextConfig;
    this.#persist();
    return this.getConfig();
  }

  clearDeviceKey() {
    this.config = this.#sanitize({
      ...this.config,
      enabled: false,
      deviceKey: ""
    });
    this.#persist();
    return this.getConfig();
  }

  async sendAttendanceResult({
    actionLabel,
    status,
    message,
    source,
    timestamp
  } = {}) {
    const config = this.getConfig();

    if (!config.enabled || !config.deviceKey) {
      return false;
    }

    const subtitle = `${actionLabel || "Attendance"} | ${status || "Update"}`;
    const body = [
      `Time: ${formatTimestamp(timestamp)}`,
      actionLabel ? `Task: ${actionLabel}` : null,
      status ? `Result: ${status}` : null,
      `Trigger: ${normalizeSourceLabel(source)}`,
      message ? `Details: ${normalizeDetailText(message)}` : null
    ]
      .filter(Boolean)
      .join("\n");

    const requestUrl = new URL(
      `${config.serverOrigin}/${encodeURIComponent(config.deviceKey)}/${encodeURIComponent("ClockBot")}/${encodeURIComponent(subtitle)}/${encodeURIComponent(body)}`
    );
    requestUrl.searchParams.set("group", config.group);
    requestUrl.searchParams.set("level", status === "Failed" ? "timeSensitive" : "active");

    if (config.iconUrl) {
      requestUrl.searchParams.set("icon", config.iconUrl);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(requestUrl.toString(), {
        method: "GET",
        signal: controller.signal
      });
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Bark request failed with HTTP ${response.status}.`);
      }

      if (responseText) {
        try {
          const payload = JSON.parse(responseText);

          if (typeof payload.code === "number" && payload.code !== 200) {
            throw new Error(payload.message || `Bark API returned code ${payload.code}.`);
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            return true;
          }

          throw error;
        }
      }

      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  #persist() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), "utf8");
    } catch (error) {
      this.log.warn("ClockBot could not persist Bark notification settings.", {
        message: error && error.message ? error.message : String(error),
        filePath: this.filePath
      });
    }
  }

  #sanitize(candidate) {
    const nextConfig = { ...DEFAULT_BARK_CONFIG };

    if (candidate && typeof candidate === "object") {
      if (typeof candidate.enabled === "boolean") {
        nextConfig.enabled = candidate.enabled;
      }

      nextConfig.serverOrigin = sanitizeServerOrigin(candidate.serverOrigin);
      nextConfig.deviceKey = sanitizeDeviceKey(candidate.deviceKey);
      nextConfig.group = sanitizeGroup(candidate.group);
      nextConfig.iconUrl = sanitizeIconUrl(candidate.iconUrl);
    }

    return nextConfig;
  }
}

module.exports = {
  BarkService
};
