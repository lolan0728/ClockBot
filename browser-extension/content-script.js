(function installClockBotContentScript() {
  if (globalThis.__clockbotContentInstalled) {
    return;
  }

  globalThis.__clockbotContentInstalled = true;

  const LOGIN_LABELS = ["\u30ed\u30b0\u30a4\u30f3", "Login"];
  const CLOCK_IN_LABEL = "\u51fa\u52e4";
  const CLOCK_OUT_LABEL = "\u9000\u52e4";
  const LOCATION_TIMEOUT_TEXT = "\u4f4d\u7f6e\u60c5\u5831\u53d6\u5f97\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f";
  const LOGIN_FIELD_SELECTORS = [
    "input[name='login_id']",
    "input[name='employee_code']",
    "input[name='email']",
    "input[type='email']",
    "input[type='text']"
  ];
  const PASSWORD_FIELD_SELECTORS = [
    "input[name='password']",
    "input[type='password']"
  ];
  const LOGIN_CONTROL_SELECTORS = [
    "button",
    "input[type='button']",
    "input[type='submit']"
  ];
  const ATTENDANCE_CONTROL_SELECTORS = [
    ...LOGIN_CONTROL_SELECTORS,
    "a",
    "[role='button']",
    ".btn",
    ".button",
    "[onclick]"
  ];
  const VISUAL_CURSOR_ID = "clockbot-visual-cursor";
  const VISUAL_CURSOR_STYLE_ID = "clockbot-visual-cursor-style";
  const VISUAL_CURSOR_TRAIL_SVG_CLASS = "clockbot-visual-cursor-trail-svg";
  const VISUAL_CURSOR_TRAIL_SOFT_CLASS = "clockbot-visual-cursor-trail-soft";
  const VISUAL_CURSOR_TRAIL_MAIN_CLASS = "clockbot-visual-cursor-trail-main";
  const VISUAL_CURSOR_NODE_CLASS = "clockbot-visual-cursor-node";
  const VISUAL_CURSOR_TRAIL_MAX_AGE_MS = 2200;
  const VISUAL_CURSOR_TRAIL_POINT_LIMIT = 120;
  const VISUAL_CURSOR_TRAIL_MIN_DISTANCE_PX = 3;
  let visualCursorOverlay = null;
  let visualCursorElement = null;
  let visualCursorHalo = null;
  let visualCursorDot = null;
  let visualCursorTrailSvg = null;
  let visualCursorTrailSoftPath = null;
  let visualCursorTrailMainPath = null;
  let visualCursorTimer = null;
  let visualCursorTrailClearTimer = null;
  let visualCursorTrailFadeTimer = null;
  let visualCursorTrailPoints = [];

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function ensureVisualCursorStyles() {
    if (document.getElementById(VISUAL_CURSOR_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = VISUAL_CURSOR_STYLE_ID;
    style.textContent = `
      #${VISUAL_CURSOR_ID} {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483647;
        opacity: 0;
        transition: opacity 160ms ease;
      }

      #${VISUAL_CURSOR_ID}[data-visible="true"] {
        opacity: 1;
      }

      #${VISUAL_CURSOR_ID} .${VISUAL_CURSOR_TRAIL_SVG_CLASS} {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
      }

      #${VISUAL_CURSOR_ID} .${VISUAL_CURSOR_TRAIL_SOFT_CLASS} {
        fill: none;
        stroke: rgba(235, 150, 150, 0.2);
        stroke-width: 11;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      #${VISUAL_CURSOR_ID} .${VISUAL_CURSOR_TRAIL_MAIN_CLASS} {
        fill: none;
        stroke: rgba(225, 124, 124, 0.56);
        stroke-width: 3.6;
        stroke-linecap: round;
        stroke-linejoin: round;
        filter: drop-shadow(0 0 6px rgba(225, 124, 124, 0.16));
      }

      #${VISUAL_CURSOR_ID} .${VISUAL_CURSOR_NODE_CLASS} {
        position: absolute;
        left: 0;
        top: 0;
        width: 28px;
        height: 28px;
        transform: translate(-8px, -8px) scale(0.92);
        transition:
          transform 90ms ease,
          filter 120ms ease;
        filter: drop-shadow(0 4px 10px rgba(121, 41, 41, 0.18));
      }

      #${VISUAL_CURSOR_ID}[data-state="hover"] .${VISUAL_CURSOR_NODE_CLASS} {
        transform: translate(-8px, -8px) scale(1.06);
      }

      #${VISUAL_CURSOR_ID}[data-state="press"] .${VISUAL_CURSOR_NODE_CLASS} {
        transform: translate(-8px, -8px) scale(0.9);
      }

      #${VISUAL_CURSOR_ID} .clockbot-visual-cursor-halo {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: radial-gradient(circle, rgba(236, 168, 168, 0.18), rgba(236, 168, 168, 0));
        border: 1px solid rgba(225, 124, 124, 0.2);
        transform: scale(0.92);
        transition: transform 110ms ease, opacity 110ms ease, background 110ms ease;
      }

      #${VISUAL_CURSOR_ID}[data-state="hover"] .clockbot-visual-cursor-halo {
        transform: scale(1.08);
        background: radial-gradient(circle, rgba(236, 168, 168, 0.28), rgba(236, 168, 168, 0));
      }

      #${VISUAL_CURSOR_ID}[data-state="press"] .clockbot-visual-cursor-halo {
        transform: scale(0.86);
        background: radial-gradient(circle, rgba(225, 124, 124, 0.34), rgba(225, 124, 124, 0));
      }

      #${VISUAL_CURSOR_ID} .clockbot-visual-cursor-dot {
        position: absolute;
        left: 8px;
        top: 8px;
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #df8d8d;
        border: 2px solid rgba(255, 255, 255, 0.96);
        box-shadow: 0 3px 10px rgba(154, 76, 76, 0.2);
        transition: transform 110ms ease, background 110ms ease;
      }

      #${VISUAL_CURSOR_ID}[data-state="hover"] .clockbot-visual-cursor-dot {
        background: #d67676;
        transform: scale(1.08);
      }

      #${VISUAL_CURSOR_ID}[data-state="press"] .clockbot-visual-cursor-dot {
        background: #cb6565;
        transform: scale(0.92);
      }
    `;

    document.documentElement.appendChild(style);
  }

  function updateVisualCursorViewport() {
    if (!visualCursorTrailSvg) {
      return;
    }

    const width = Math.max(window.innerWidth, document.documentElement.clientWidth || 0, 1);
    const height = Math.max(window.innerHeight, document.documentElement.clientHeight || 0, 1);

    visualCursorTrailSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    visualCursorTrailSvg.setAttribute("width", String(width));
    visualCursorTrailSvg.setAttribute("height", String(height));
  }

  function ensureVisualCursor() {
    if (visualCursorOverlay && visualCursorOverlay.isConnected) {
      updateVisualCursorViewport();
      return visualCursorOverlay;
    }

    ensureVisualCursorStyles();

    visualCursorOverlay = document.createElement("div");
    visualCursorOverlay.id = VISUAL_CURSOR_ID;
    visualCursorOverlay.dataset.visible = "false";
    visualCursorOverlay.dataset.state = "move";

    visualCursorTrailSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    visualCursorTrailSvg.setAttribute("class", VISUAL_CURSOR_TRAIL_SVG_CLASS);
    visualCursorTrailSvg.setAttribute("aria-hidden", "true");

    visualCursorTrailSoftPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    visualCursorTrailSoftPath.setAttribute("class", VISUAL_CURSOR_TRAIL_SOFT_CLASS);

    visualCursorTrailMainPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    visualCursorTrailMainPath.setAttribute("class", VISUAL_CURSOR_TRAIL_MAIN_CLASS);

    visualCursorTrailSvg.appendChild(visualCursorTrailSoftPath);
    visualCursorTrailSvg.appendChild(visualCursorTrailMainPath);

    visualCursorElement = document.createElement("div");
    visualCursorElement.className = VISUAL_CURSOR_NODE_CLASS;

    visualCursorHalo = document.createElement("div");
    visualCursorHalo.className = "clockbot-visual-cursor-halo";

    visualCursorDot = document.createElement("div");
    visualCursorDot.className = "clockbot-visual-cursor-dot";

    visualCursorElement.appendChild(visualCursorHalo);
    visualCursorElement.appendChild(visualCursorDot);
    visualCursorOverlay.appendChild(visualCursorTrailSvg);
    visualCursorOverlay.appendChild(visualCursorElement);
    document.documentElement.appendChild(visualCursorOverlay);
    updateVisualCursorViewport();

    return visualCursorOverlay;
  }

  function clearVisualCursorTimer() {
    if (visualCursorTimer) {
      clearTimeout(visualCursorTimer);
      visualCursorTimer = null;
    }
  }

  function clearVisualCursorTrailClearTimer() {
    if (visualCursorTrailClearTimer) {
      clearTimeout(visualCursorTrailClearTimer);
      visualCursorTrailClearTimer = null;
    }
  }

  function clearVisualCursorTrailFadeTimer() {
    if (visualCursorTrailFadeTimer) {
      clearTimeout(visualCursorTrailFadeTimer);
      visualCursorTrailFadeTimer = null;
    }
  }

  function buildTrailPath(points) {
    if (!points.length) {
      return "";
    }

    if (points.length === 1) {
      const point = points[0];
      return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)} L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }

    let pathData = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;

    for (let index = 1; index < points.length - 1; index += 1) {
      const current = points[index];
      const next = points[index + 1];
      const midpointX = (current.x + next.x) / 2;
      const midpointY = (current.y + next.y) / 2;
      pathData += ` Q ${current.x.toFixed(1)} ${current.y.toFixed(1)} ${midpointX.toFixed(1)} ${midpointY.toFixed(1)}`;
    }

    const lastPoint = points[points.length - 1];
    pathData += ` T ${lastPoint.x.toFixed(1)} ${lastPoint.y.toFixed(1)}`;
    return pathData;
  }

  function renderVisualCursorTrail() {
    ensureVisualCursor();

    if (!visualCursorTrailSoftPath || !visualCursorTrailMainPath) {
      return;
    }

    const pathData = buildTrailPath(visualCursorTrailPoints);
    visualCursorTrailSoftPath.setAttribute("d", pathData);
    visualCursorTrailMainPath.setAttribute("d", pathData);
  }

  function trimVisualCursorTrail(now = Date.now()) {
    if (visualCursorTrailPoints.length <= 1) {
      return;
    }

    visualCursorTrailPoints = visualCursorTrailPoints.filter((point, index, points) => (
      (now - point.timestamp) <= VISUAL_CURSOR_TRAIL_MAX_AGE_MS ||
      index >= points.length - 2
    ));

    if (visualCursorTrailPoints.length > VISUAL_CURSOR_TRAIL_POINT_LIMIT) {
      visualCursorTrailPoints = visualCursorTrailPoints.slice(-VISUAL_CURSOR_TRAIL_POINT_LIMIT);
    }
  }

  function scheduleVisualCursorTrailFade() {
    clearVisualCursorTrailFadeTimer();

    if (visualCursorTrailPoints.length < 2) {
      return;
    }

    visualCursorTrailFadeTimer = setTimeout(() => {
      visualCursorTrailFadeTimer = null;
      trimVisualCursorTrail();
      renderVisualCursorTrail();

      if (visualCursorTrailPoints.length > 1) {
        scheduleVisualCursorTrailFade();
      }
    }, 90);
  }

  function resetVisualCursorTrail() {
    clearVisualCursorTrailFadeTimer();
    visualCursorTrailPoints = [];
    renderVisualCursorTrail();
  }

  function appendVisualCursorTrailPoint(x, y) {
    const pointX = Math.round(Number(x) || 0);
    const pointY = Math.round(Number(y) || 0);
    const timestamp = Date.now();
    const lastPoint = visualCursorTrailPoints[visualCursorTrailPoints.length - 1];

    clearVisualCursorTrailClearTimer();

    if (lastPoint) {
      const distance = Math.hypot(pointX - lastPoint.x, pointY - lastPoint.y);

      if (distance < VISUAL_CURSOR_TRAIL_MIN_DISTANCE_PX) {
        lastPoint.x = pointX;
        lastPoint.y = pointY;
        lastPoint.timestamp = timestamp;
        renderVisualCursorTrail();
        scheduleVisualCursorTrailFade();
        return;
      }
    }

    visualCursorTrailPoints.push({
      x: pointX,
      y: pointY,
      timestamp
    });

    trimVisualCursorTrail(timestamp);
    renderVisualCursorTrail();
    scheduleVisualCursorTrailFade();
  }

  function updateVisualCursorPosition(x, y) {
    const overlay = ensureVisualCursor();
    visualCursorElement.style.left = `${Math.round(x)}px`;
    visualCursorElement.style.top = `${Math.round(y)}px`;
    overlay.dataset.visible = "true";
    appendVisualCursorTrailPoint(x, y);
  }

  function setVisualCursorState(nextState) {
    const overlay = ensureVisualCursor();
    overlay.dataset.state = nextState;
    overlay.dataset.visible = "true";
  }

  function scheduleVisualCursorStateReset(delayMs = 140) {
    clearVisualCursorTimer();
    visualCursorTimer = setTimeout(() => {
      visualCursorTimer = null;

      if (!visualCursorElement || !visualCursorElement.isConnected) {
        return;
      }

      visualCursorOverlay.dataset.state = "move";
    }, delayMs);
  }

  function hideVisualCursor() {
    clearVisualCursorTimer();
    clearVisualCursorTrailFadeTimer();

    if (!visualCursorOverlay || !visualCursorOverlay.isConnected) {
      return;
    }

    visualCursorOverlay.dataset.visible = "false";
    visualCursorOverlay.dataset.state = "move";

    clearVisualCursorTrailClearTimer();
    visualCursorTrailClearTimer = setTimeout(() => {
      visualCursorTrailClearTimer = null;
      resetVisualCursorTrail();
    }, 180);
  }

  function getControlText(element) {
    return normalizeText(element.innerText || element.value || element.textContent || "");
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function buildTarget(element) {
    if (!element) {
      return null;
    }

    element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "auto"
    });

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const horizontalPadding = Math.max(4, rect.width * 0.18);
    const verticalPadding = Math.max(4, rect.height * 0.22);
    const minX = rect.left + horizontalPadding;
    const maxX = rect.right - horizontalPadding;
    const minY = rect.top + verticalPadding;
    const maxY = rect.bottom - verticalPadding;

    return {
      x: clamp(minX + ((maxX - minX) * Math.random()), rect.left + 2, rect.right - 2),
      y: clamp(minY + ((maxY - minY) * Math.random()), rect.top + 2, rect.bottom - 2),
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function findFirstVisible(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (isVisible(node)) {
        return node;
      }
    }

    return null;
  }

  function findVisibleControlByLabels(labels, selectors) {
    const candidates = Array.from(document.querySelectorAll(selectors.join(",")));
    return candidates.find((element) => (
      isVisible(element) &&
      labels.some((label) => getControlText(element).includes(normalizeText(label)))
    )) || null;
  }

  function parseCssColor(value) {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
    if (!match) {
      return null;
    }

    const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
    const r = parts[0];
    const g = parts[1];
    const b = parts[2];
    const a = Number.isFinite(parts[3]) ? parts[3] : 1;

    if ([r, g, b, a].some((part) => Number.isNaN(part))) {
      return null;
    }

    return { r, g, b, a };
  }

  function getRelativeLuminance(color) {
    const transform = (channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };

    return (0.2126 * transform(color.r)) +
      (0.7152 * transform(color.g)) +
      (0.0722 * transform(color.b));
  }

  function getFilledScore(button) {
    if (!button) {
      return -1;
    }

    const background = parseCssColor(button.backgroundColor);
    const foreground = parseCssColor(button.color);

    if (!background || !foreground) {
      return -1;
    }

    const backgroundLuminance = getRelativeLuminance(background);
    const foregroundLuminance = getRelativeLuminance(foreground);
    return (1 - backgroundLuminance) + foregroundLuminance + (background.a * 0.25);
  }

  function classifyButtonVisualState(button) {
    if (!button) {
      return "missing";
    }

    const background = parseCssColor(button.backgroundColor);
    const foreground = parseCssColor(button.color);

    if (!background || !foreground) {
      return "unknown";
    }

    const backgroundLuminance = getRelativeLuminance(background);
    const foregroundLuminance = getRelativeLuminance(foreground);

    if (backgroundLuminance > 0.82 && foregroundLuminance < 0.35) {
      return "inactive";
    }

    if (backgroundLuminance < 0.55 && foregroundLuminance > 0.72) {
      return "active";
    }

    return "unknown";
  }

  function getVisibleInteractiveControls() {
    return Array.from(document.querySelectorAll(ATTENDANCE_CONTROL_SELECTORS.join(",")))
      .filter((element) => isVisible(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          element,
          text: getControlText(element),
          area: Math.round(rect.width * rect.height),
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderColor: style.borderColor
        };
      })
      .filter((control) => control.text);
  }

  function selectAttendanceButton(controls, label) {
    const normalizedLabel = normalizeText(label);
    const candidates = controls.filter((control) => control.text.includes(normalizedLabel));

    if (!candidates.length) {
      return null;
    }

    const exactMatch = candidates
      .filter((control) => control.text === normalizedLabel)
      .sort((left, right) => right.area - left.area)[0];

    if (exactMatch) {
      return exactMatch;
    }

    return candidates.sort((left, right) => right.area - left.area)[0];
  }

  function summarizeButtonState(button, state) {
    if (!button) {
      return {
        label: null,
        state: "missing",
        target: null
      };
    }

    return {
      label: button.text,
      state,
      target: buildTarget(button.element),
      backgroundColor: button.backgroundColor,
      color: button.color,
      borderColor: button.borderColor
    };
  }

  function resolveAttendanceButtons() {
    const controls = getVisibleInteractiveControls();
    const clockInButton = selectAttendanceButton(controls, CLOCK_IN_LABEL);
    const clockOutButton = selectAttendanceButton(controls, CLOCK_OUT_LABEL);
    let clockInState = classifyButtonVisualState(clockInButton);
    let clockOutState = classifyButtonVisualState(clockOutButton);

    if (clockInButton && clockOutButton && (clockInState === "unknown" || clockOutState === "unknown")) {
      const clockInScore = getFilledScore(clockInButton);
      const clockOutScore = getFilledScore(clockOutButton);

      if (clockInScore >= 0 && clockOutScore >= 0 && Math.abs(clockInScore - clockOutScore) > 0.35) {
        if (clockInScore > clockOutScore) {
          clockInState = "active";
          if (clockOutState === "unknown") {
            clockOutState = "inactive";
          }
        } else {
          clockOutState = "active";
          if (clockInState === "unknown") {
            clockInState = "inactive";
          }
        }
      }
    }

    return {
      visibleControls: controls.map((control) => control.text),
      pageText: normalizeText(document.body ? document.body.innerText : ""),
      clockIn: summarizeButtonState(clockInButton, clockInState),
      clockOut: summarizeButtonState(clockOutButton, clockOutState)
    };
  }

  function inspectLoginState() {
    const usernameField = findFirstVisible(LOGIN_FIELD_SELECTORS);
    const passwordField = findFirstVisible(PASSWORD_FIELD_SELECTORS);
    const loginButton = findVisibleControlByLabels(LOGIN_LABELS, LOGIN_CONTROL_SELECTORS);

    return {
      ok: true,
      url: window.location.href,
      loginRequired: Boolean(usernameField && passwordField),
      usernameTarget: buildTarget(usernameField),
      passwordTarget: buildTarget(passwordField),
      loginButtonTarget: buildTarget(loginButton),
      visibleControls: Array.from(document.querySelectorAll(LOGIN_CONTROL_SELECTORS.join(",")))
        .filter((element) => isVisible(element))
        .map((element) => getControlText(element))
        .filter(Boolean)
        .slice(0, 20)
    };
  }

  function readPotentialErrorMessage() {
    const candidates = [
      ".alert",
      ".error",
      ".flash",
      ".notice",
      ".validation-errors",
      "[role='alert']"
    ];

    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (isVisible(element)) {
        const text = normalizeText(element.innerText || element.textContent || "");
        if (text) {
          return {
            ok: true,
            message: text
          };
        }
      }
    }

    return {
      ok: true,
      message: ""
    };
  }

  function inspectAttendanceState() {
    const state = resolveAttendanceButtons();
    return {
      ok: true,
      url: window.location.href,
      locationTimeoutObserved: state.pageText.includes(LOCATION_TIMEOUT_TEXT),
      state: {
        visibleControls: state.visibleControls,
        clockIn: state.clockIn,
        clockOut: state.clockOut
      }
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.source !== "clockbot") {
      return false;
    }

    try {
      if (message.type === "clockbot:ping") {
        sendResponse({
          ok: true,
          url: window.location.href
        });
        return false;
      }

      if (message.type === "clockbot:inspect-login") {
        sendResponse(inspectLoginState());
        return false;
      }

      if (message.type === "clockbot:read-error-message") {
        sendResponse(readPotentialErrorMessage());
        return false;
      }

      if (message.type === "clockbot:inspect-attendance") {
        sendResponse(inspectAttendanceState());
        return false;
      }

      if (message.type === "clockbot:visual-cursor-move") {
        updateVisualCursorPosition(message.x, message.y);
        setVisualCursorState("move");
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "clockbot:visual-cursor-hover") {
        updateVisualCursorPosition(message.x, message.y);
        setVisualCursorState("hover");
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "clockbot:visual-cursor-press") {
        updateVisualCursorPosition(message.x, message.y);
        setVisualCursorState("press");
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "clockbot:visual-cursor-release") {
        updateVisualCursorPosition(message.x, message.y);
        setVisualCursorState("hover");
        scheduleVisualCursorStateReset(170);
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "clockbot:visual-cursor-hide") {
        hideVisualCursor();
        sendResponse({ ok: true });
        return false;
      }

      sendResponse({
        ok: false,
        error: "Unsupported ClockBot content-script message."
      });
      return false;
    } catch (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
      return false;
    }
  });
}());
