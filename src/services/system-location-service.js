const { execFile } = require("child_process");
const { promisify } = require("util");
const os = require("os");

const execFileAsync = promisify(execFile);
const POWERSHELL_PATH = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const LOCATION_SCRIPT = [
  "Add-Type -AssemblyName System.Device",
  "$watcher = New-Object System.Device.Location.GeoCoordinateWatcher",
  "$started = $watcher.TryStart($true, [TimeSpan]::FromSeconds(10))",
  "if (-not $started) { 'WATCHER_START_FAILED'; exit 0 }",
  "$coord = $watcher.Position.Location",
  "if ($coord -and -not $coord.IsUnknown) {",
  "  \"LAT=$($coord.Latitude);LON=$($coord.Longitude)\"",
  "} else {",
  "  'LOCATION_UNKNOWN'",
  "}"
].join("; ");

function parseLocation(stdout) {
  const output = String(stdout || "").trim();
  const match = output.match(/LAT=([-+\d.]+);LON=([-+\d.]+)/);

  if (!match) {
    return null;
  }

  const latitude = Number.parseFloat(match[1]);
  const longitude = Number.parseFloat(match[2]);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return null;
  }

  return {
    latitude,
    longitude,
    accuracy: 100
  };
}

async function getWindowsSystemLocation(log) {
  try {
    const { stdout } = await execFileAsync(
      POWERSHELL_PATH,
      ["-NoProfile", "-Command", LOCATION_SCRIPT],
      { timeout: 15000, windowsHide: true }
    );

    const location = parseLocation(stdout);

    if (!location) {
      log.warn("Windows location service did not return usable coordinates.", {
        output: String(stdout || "").trim()
      });
      return null;
    }

    log.info("Resolved current Windows location for attendance automation.", {
      latitude: location.latitude,
      longitude: location.longitude
    });
    return location;
  } catch (error) {
    log.warn("Failed to query Windows location service.", {
      message: error && error.message ? error.message : String(error)
    });
    return null;
  }
}

async function getSystemLocation(log) {
  if (process.platform === "win32") {
    return getWindowsSystemLocation(log);
  }

  const platformLabel = process.platform === "darwin" ? "macOS" : os.platform();
  log.info(`${platformLabel} will rely on the browser's own location permissions for attendance automation.`);
  return null;
}

module.exports = {
  getSystemLocation
};
