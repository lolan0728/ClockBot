# ClockBot

ClockBot is a local Electron tray app for automating IEYASU clock-in and clock-out actions.

## Features

- Desktop UI for saved or session-based credentials
- Configurable morning and evening schedule, defaulting to `09:00` and `18:00`
- System tray support with minimize-to-tray behavior
- Live status panel and rolling log view
- Manual `Clock In` and `Clock Out` test actions
- Chrome Extension-driven automation against `https://f.ieyasu.co/fointl/login`
- Visual in-page cursor playback for hover, click, and typing motion feedback
- Extension bridge that reuses your regular Chrome session

## Run on Windows

1. Install dependencies:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

2. Start the app:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
   ```

3. Load the unpacked extension from `browser-extension\` in `chrome://extensions`.

4. Enter your username and password, then click `Start Monitoring`.

## Run on macOS

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the app:

   ```bash
   npm start
   ```

3. Load the unpacked extension from `browser-extension/` in `chrome://extensions`.

4. On the first run, allow browser and macOS location access if prompted.

## Package for Windows

1. Install dependencies, including the Windows packager:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

2. Build the Windows portable artifacts:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\package-win.ps1
   ```

   The packaging script prefers the local `.electron-cache` first, which helps avoid repeated Electron downloads.

3. Find the output in:

   ```text
   .\dist\
   ```

The build generates two `x64` Windows outputs in `.\dist\`:

- `ClockBot-portable-<version>.exe`
  A single-file portable app. It is easy to share, but startup is slower because it unpacks itself on each launch.
- `ClockBot-win-unpacked-<version>.zip`
  A zip archive containing the unpacked app folder. Extract it once and run `ClockBot.exe` inside for much faster startup.

## Package for macOS

On macOS, build a zip archive with:

```bash
npm run pack:mac
```

The output will be written to `./dist/`.

## Why use the PowerShell scripts?

Some Windows terminals launch `npm.cmd` with a `\\?\C:\...` current directory, which makes `cmd.exe` fall back to `C:\Windows` and breaks `npm install` / `npm start`.

The scripts in `scripts\` normalize the project path and call `npm.cmd --prefix <project> ...`, so they keep working even when the current directory is reported in that extended-path format.

## Notes

- Saved credentials are encrypted with Electron's system-backed secure storage and are not written in plain text.
- Settings and logs are stored under Electron's user data directory.
- Chrome must be installed locally because the active automation path runs through the ClockBot extension.
- The browser stays visible during every automation run.
- Load the unpacked extension from `browser-extension/` and keep regular Chrome open while ClockBot is running.
- On Windows, ClockBot can inject the current system location for the attendance site.
- On macOS and other platforms, ClockBot falls back to the browser's own location permissions, so the first visible run may require a one-time permission grant.
- You can override browser detection by setting `CLOCKBOT_BROWSER_PATH` to a local browser executable.
