const { performAttendanceAction } = require("./ieyasu-automation");

class PunchService {
  constructor(log) {
    this.log = log;
  }

  async run(action, credentials, settings) {
    return performAttendanceAction({
      action,
      credentials,
      attendanceUrl: settings.attendanceUrl,
      showBrowser: settings.showBrowser,
      log: this.log
    });
  }
}

module.exports = {
  PunchService
};
