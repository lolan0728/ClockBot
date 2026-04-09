# ClockBot AI Handoff Progress

## 1. Goal

Current product direction:

- Stop trying to let `Playwright` control the user's real daily Chrome profile.
- Replace the old "browser mode" implementation with:
  - `Electron desktop app`
  - `Chrome Extension`
  - `localhost bridge` on `127.0.0.1:38473`
- Keep `PAD` as the fallback / alternate run method.

Core user requirement behind this migration:

- `ClockBot` must use the user's real daily Chrome session.
- It must not copy, wrap, or mutate `Chrome User Data` again.
- It must not log the user out of Chrome / Google.

## 2. Current State Summary

This migration is **partially implemented**.

Already done:

- Main process now knows about a new `ExtensionBridgeService`.
- Browser-mode execution path no longer calls `performAttendanceAction(...)` from `ieyasu-automation.js`.
- UI wording has been changed from `Browser Mode` to `Chrome Extension`.
- UI now exposes an `Open Extension Folder` button.
- Packaging config now includes `browser-extension/**/*`.
- Chrome extension folder exists and currently contains:
  - `browser-extension/manifest.json`
  - `browser-extension/content-script.js`

Not done yet:

- `browser-extension/background.js` does **not** exist yet.
- There is no live extension-side polling loop yet.
- There is no end-to-end `ClockBot -> extension -> IEYASU` execution yet.
- Final syntax validation and runtime verification have not been completed for the new extension flow.

## 3. Files Already Changed

### Electron / app side

- `package.json`
  - `browser-extension/**/*` was added to `build.files`
- `src/main.js`
  - imports `ExtensionBridgeService`
  - instantiates it in `wireServices()`
  - starts it on app ready
  - stops it on app quit
  - exposes `clockbot:open-extension-folder`
  - includes `extensionBridge` inside state snapshot
  - browser-mode blocking logic no longer requires a Chrome profile directory
- `src/preload.js`
  - exposes `openExtensionFolder()`
- `src/services/punch-service.js`
  - browser-mode branch now calls `extensionBridgeService.runAction(...)`
  - no longer imports or uses `performAttendanceAction(...)`
- `src/renderer/index.html`
  - browser-mode label changed to `Chrome Extension`
  - added `openExtensionFolderButton`
- `src/renderer/app.js`
  - renders extension-oriented copy
  - shows / hides the extension folder button
  - invokes `window.clockBotApi.openExtensionFolder()`
  - confirmation dialogs now describe extension-based Chrome execution
  - PAD blocking logic was fixed so PAD does not depend on Chrome being installed

### New service

- `src/services/extension-bridge-service.js`
  - already exists
  - starts an HTTP bridge on `127.0.0.1:38473`
  - supports:
    - `GET /health`
    - `POST /extension/hello`
    - `GET /extension/commands/next`
    - `POST /extension/progress`
    - `POST /extension/result`
    - `POST /extension/log`
  - can launch regular Chrome with the user's real profile via normal Chrome startup
  - can queue one attendance command at a time

### Chrome extension side

- `browser-extension/manifest.json`
  - MV3 manifest exists
  - permissions currently include:
    - `tabs`
    - `scripting`
    - `storage`
    - `activeTab`
    - `debugger`
    - `alarms`
  - host permissions currently include:
    - `https://*.ieyasu.co/*`
    - `http://127.0.0.1:38473/*`
- `browser-extension/content-script.js`
  - already contains page inspection helpers
  - supports message handlers for:
    - `clockbot:ping`
    - `clockbot:inspect-login`
    - `clockbot:read-error-message`
    - `clockbot:inspect-attendance`
  - includes logic ported from old Playwright code for:
    - login field discovery
    - login button discovery
    - attendance button visibility / state classification
    - location-timeout text detection

## 4. Most Important Remaining Task

Create:

- `browser-extension/background.js`

This file must implement the actual extension runtime loop.

### Required responsibilities of `background.js`

1. Poll the local bridge

- call `POST /extension/hello`
- call `GET /extension/commands/next?clientId=...`
- report progress and results back to ClockBot

2. Open / reuse regular Chrome tab(s)

- use normal Chrome tabs
- do **not** use `userDataDir`, wrapper, or copied profiles
- operate on the real user's Chrome session

3. Inject / ensure `content-script.js`

- on IEYASU tab(s), inject `content-script.js` when needed
- use it to inspect DOM state

4. Use `chrome.debugger` as the default interaction layer

- attach to the IEYASU tab
- use CDP input events
- emulate:
  - mouse movement
  - click
  - typing
  - short random delays
- goal: humanized interaction, not plain DOM `element.click()`

5. Implement minimum attendance flow

- open / focus IEYASU page
- inspect login state
- if login form exists:
  - fill username
  - fill password
  - click login
- wait until login completes or an error appears
- inspect attendance buttons
- click `clockIn` or `clockOut`
- wait for confirmed post-click state transition

6. Return results to ClockBot

- `Success`
- `Failed`
- `Skipped`

## 5. Suggested Behavior for `background.js`

The next implementation should follow this shape:

### Bridge lifecycle

- keep one active command at a time
- use `chrome.alarms` to re-poll periodically
- also trigger polling when IEYASU tabs load or Chrome wakes up

### Command execution shape

1. Receive command from bridge
2. Open or activate a Chrome tab for `attendanceUrl`
3. Wait for tab load
4. Ensure content script is present
5. Attach `chrome.debugger`
6. If location is provided by the bridge, try `Emulation.setGeolocationOverride`
7. Inspect login state
8. If needed, perform login with humanized debugger input
9. Poll attendance state until actionable
10. Click target attendance button
11. Poll for post-click state transition
12. Send final result to bridge
13. Detach debugger

## 6. Existing Code Worth Reusing

The old Playwright file still has valuable business logic:

- `src/services/ieyasu-automation.js`

Useful parts already partially ported into `content-script.js`:

- login selectors
- visible-control scanning
- attendance button visual-state classification
- location-timeout text detection

Useful logic still not ported yet:

- login completion waiting pattern
- post-punch state confirmation pattern
- some error-message handling flow

Recommended approach:

- keep DOM inspection logic inside `content-script.js`
- keep real browser input logic inside `background.js`
- let `background.js` call the content script repeatedly to inspect current state

## 7. Important Constraints

Do **not** go back to these failed strategies:

- direct Playwright control of the real Chrome daily profile
- wrapper / junction profile tricks
- copying Chrome profile into `automation-profile`
- any implementation that can again log the user out of Chrome / Google

This is a hard constraint from the user.

## 8. Current Dirty Worktree Notes

The repository is already dirty and contains older unrelated / earlier migration files.
Do not blindly revert them.

Current changed / untracked items include at least:

- modified:
  - `package.json`
  - `src/main.js`
  - `src/preload.js`
  - `src/renderer/app.js`
  - `src/renderer/index.html`
  - `src/renderer/styles.css`
  - `src/services/ieyasu-automation.js`
  - `src/services/punch-service.js`
  - `src/services/settings-service.js`
- untracked:
  - `CHROME_EXTENSION_PLAN.md`
  - `browser-extension/`
  - `src/services/browser-service.js`
  - `src/services/extension-bridge-service.js`
  - old PowerShell helper scripts under `scripts/`

Treat `src/services/ieyasu-automation.js` as historical / transitional for now.
It should not be reactivated as the primary browser-mode implementation.

## 9. Recommended Next Steps

1. Create `browser-extension/background.js`
2. Verify it can:
   - connect to the bridge
   - receive a queued command
   - send progress back
3. Wire minimum login flow
4. Wire minimum attendance click flow
5. Run syntax checks:
   - `node --check src/main.js`
   - `node --check src/preload.js`
   - `node --check src/renderer/app.js`
   - `node --check src/services/punch-service.js`
   - `node --check src/services/extension-bridge-service.js`
6. Start the Electron app
7. Manually load the unpacked extension from `browser-extension/`
8. Test one manual action from the UI

## 10. Expected Definition of Done

This migration is done only when all of the following are true:

- Selecting `Chrome Extension` mode in the UI is usable
- Clicking `Open Extension Folder` works
- User can load the unpacked extension into Chrome
- `ClockBot` can queue a manual `Clock In` / `Clock Out`
- Extension receives the task and reports progress
- Extension uses the user's real Chrome session
- No copied / wrapped Chrome profile is involved
- PAD mode still works as an alternate run method
