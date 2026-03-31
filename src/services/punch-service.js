const { performAttendanceAction } = require("./ieyasu-automation");
const { performPadAttendanceAction } = require("./pad-automation");

class PunchService {
  constructor(log, options = {}) {
    this.log = log;
    this.baseDirectory = options.baseDirectory || process.cwd();
  }

  async run(action, credentials, settings, options = {}) {
    const engine = settings && settings.automationEngine === "pad"
      ? "pad"
      : "playwright";

    if (engine === "pad") {
      return performPadAttendanceAction({
        action,
        credentials,
        attendanceUrl: settings.attendanceUrl,
        padConfig: settings.padConfig,
        baseDirectory: this.baseDirectory,
        log: this.log,
        onProgress: options.onProgress
      });
    }

    return performAttendanceAction({
      action,
      credentials,
      attendanceUrl: settings.attendanceUrl,
      log: this.log
    });
  }
}

module.exports = {
  PunchService
};
