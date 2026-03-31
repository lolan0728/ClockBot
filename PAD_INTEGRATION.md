# Power Automate Desktop Integration

ClockBot supports two execution engines:

- `playwright`
- `pad`

This document describes the `pad` engine contract.

## Requirements

- Windows
- Power Automate Desktop installed
- A desktop flow that can be launched by name

ClockBot launches PAD through the desktop flow protocol URL:

`ms-powerautomate:/console/flow/run?...`

ClockBot does not pass credentials on the command line or in the protocol URL. Instead, it writes a request file and asks the PAD flow to write a result file.

## ClockBot Settings

In the app:

- Select `PAD` in the `Automation Engine` switcher
- Open `Configure PAD`
- Set:
  - `Workflow Name`
  - `Environment ID` (optional)

`Workflow Name` must match the PAD desktop flow that should run.

## Runtime Contract

For each run, ClockBot creates:

- `request.json`
- `progress.json`
- `result.json`

Both files live under:

`<userData>/pad-runs/<runId>/`

## Input Arguments Passed To PAD

ClockBot passes these string arguments to the PAD flow:

- `requestFilePath`
- `progressFilePath`
- `resultFilePath`
- `runId`

The flow should declare matching input variables and use them as file paths and correlation data.

## request.json Format

```json
{
  "runId": "9d06c475-b52e-4fbe-a6a4-4fa7c8bd3dc7",
  "action": "clockIn",
  "attendanceUrl": "https://f.ieyasu.co/fointl/login",
  "credentials": {
    "username": "example-user",
    "password": "example-password"
  },
  "progressFilePath": "C:\\Users\\example\\AppData\\Roaming\\ClockBot\\pad-runs\\9d06c475-b52e-4fbe-a6a4-4fa7c8bd3dc7\\progress.json",
  "progressTimeoutMs": 90000,
  "requestedAt": "2026-03-27T12:34:56.000Z"
}
```

## progress.json Format

ClockBot now supports an optional heartbeat file that lets it fail early when a PAD flow starts but stops making progress.

If the PAD flow writes `progress.json`, it should use this shape:

```json
{
  "runId": "9d06c475-b52e-4fbe-a6a4-4fa7c8bd3dc7",
  "stage": "waiting-for-clock-in-button",
  "message": "Waiting for the Clock In button to appear.",
  "updatedAt": "2026-03-27T12:35:05.000Z"
}
```

Recommended stages are short, stable labels such as:

- `started`
- `launching-browser`
- `logging-in`
- `waiting-for-clock-in-button`
- `waiting-for-clock-out-button`
- `writing-result`

The PAD flow should update `progress.json`:

1. As soon as the flow starts
2. Before each long-running browser action
3. Before any `Wait for web page content` step that may block for a while
4. Immediately before writing `result.json`

ClockBot uses the file modification time as the heartbeat signal. The `updatedAt` field is still recommended because it makes the file easier to inspect manually when debugging.

## result.json Format

The PAD flow must write:

```json
{
  "runId": "9d06c475-b52e-4fbe-a6a4-4fa7c8bd3dc7",
  "status": "Success",
  "message": "Clock In completed successfully.",
  "completedAt": "2026-03-27T12:35:20.000Z"
}
```

Allowed `status` values:

- `Success`
- `Failed`
- `Skipped`

## Expected PAD Flow Behavior

The desktop flow should:

1. Receive `requestFilePath`, `progressFilePath`, `resultFilePath`, and `runId`
2. Read `request.json`
3. Validate the `runId`
4. Write or refresh `progress.json` during long-running steps
5. Perform the browser UI automation
6. Write `result.json`

ClockBot waits for `result.json` and maps the returned status into the existing UI and logs.
After the run completes, ClockBot removes `request.json` on a best-effort basis so the plaintext credential payload is not kept longer than needed.

## Failure Behavior

ClockBot marks the PAD run as failed when:

- The current platform is not Windows
- `Workflow Name` is missing
- PAD cannot be launched
- PAD writes `progress.json` and then stops updating it before `result.json` is produced
- `result.json` is missing when timeout expires
- `result.json` is invalid JSON
- `result.json.runId` does not match the current run
- `result.json.status` is not one of the supported values

If a legacy PAD flow does not write `progress.json`, ClockBot remains backward-compatible and falls back to the regular `result.json` timeout behavior. Early stalled-run detection only activates after ClockBot has observed a valid `progress.json` heartbeat for the current run.

## Notes

- ClockBot keeps the browser visible during runs in both execution modes.
- Browser selection for PAD is owned by the PAD flow itself.
- If you want to change how PAD opens or controls the browser, change the flow, not ClockBot.
