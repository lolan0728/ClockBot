class PunchService {
  constructor(log, options = {}) {
    this.log = log;
    this.baseDirectory = options.baseDirectory || process.cwd();
    this.extensionBridgeService = options.extensionBridgeService || null;
  }

  async run(action, credentials, settings, options = {}) {
    if (!this.extensionBridgeService) {
      throw new Error("Chrome Extension mode is not available right now.");
    }

    return this.extensionBridgeService.runAction({
      action,
      credentials,
      attendanceUrl: settings.attendanceUrl,
      clockInWorkModePreference: settings.clockInWorkModePreference,
      onProgress: options.onProgress
    });
  }
}

module.exports = {
  PunchService
};
