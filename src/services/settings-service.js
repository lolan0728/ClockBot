const fs = require("fs");
const path = require("path");

const DEFAULT_ATTENDANCE_URL = "https://f.ieyasu.co/fointl/login";

const DEFAULT_SETTINGS = Object.freeze({
  morningTime: "09:00",
  eveningTime: "18:00",
  attendanceUrl: DEFAULT_ATTENDANCE_URL,
  showBrowser: false,
  minimizeToTray: true
});

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function sanitizeAttendanceUrl(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return DEFAULT_ATTENDANCE_URL;
  }

  try {
    const parsed = new URL(candidate.trim());

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_ATTENDANCE_URL;
    }

    return parsed.toString();
  } catch (error) {
    return DEFAULT_ATTENDANCE_URL;
  }
}

class SettingsService {
  constructor(baseDirectory) {
    this.baseDirectory = baseDirectory;
    this.filePath = path.join(baseDirectory, "settings.json");
    this.settings = { ...DEFAULT_SETTINGS };
  }

  load() {
    fs.mkdirSync(this.baseDirectory, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.save({});
      return this.getSettings();
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.settings = this.#sanitize(parsed);
    } catch (error) {
      this.settings = { ...DEFAULT_SETTINGS };
    }

    fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");

    return this.getSettings();
  }

  save(partialSettings) {
    this.settings = this.#sanitize({
      ...this.settings,
      ...partialSettings
    });

    fs.mkdirSync(this.baseDirectory, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
    return this.getSettings();
  }

  getSettings() {
    return { ...this.settings };
  }

  #sanitize(candidate) {
    const next = { ...DEFAULT_SETTINGS };

    if (candidate && typeof candidate === "object") {
      if (typeof candidate.morningTime === "string" && TIME_PATTERN.test(candidate.morningTime)) {
        next.morningTime = candidate.morningTime;
      }

      if (typeof candidate.eveningTime === "string" && TIME_PATTERN.test(candidate.eveningTime)) {
        next.eveningTime = candidate.eveningTime;
      }

      next.attendanceUrl = sanitizeAttendanceUrl(candidate.attendanceUrl);

      if (typeof candidate.showBrowser === "boolean") {
        next.showBrowser = candidate.showBrowser;
      }

      if (typeof candidate.minimizeToTray === "boolean") {
        next.minimizeToTray = candidate.minimizeToTray;
      }
    }

    return next;
  }
}

module.exports = {
  DEFAULT_ATTENDANCE_URL,
  DEFAULT_SETTINGS,
  SettingsService
};
