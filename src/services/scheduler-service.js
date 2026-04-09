const MAX_ALLOWED_DELAY_MS = 30 * 60 * 1000;
const RETRY_DELAY_MIN_MS = 25 * 1000;
const RETRY_DELAY_MAX_MS = 35 * 1000;

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDateFromTime(date, timeText) {
  const [hours, minutes] = timeText.split(":").map((value) => Number.parseInt(value, 10));
  const target = new Date(date);
  target.setHours(hours, minutes, 0, 0);
  return target;
}

function randomIntegerInclusive(min, max) {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

function clampToDay(date, referenceDate) {
  const start = new Date(referenceDate);
  start.setHours(0, 0, 0, 0);

  const end = new Date(referenceDate);
  end.setHours(23, 59, 0, 0);

  if (date.getTime() < start.getTime()) {
    return start;
  }

  if (date.getTime() > end.getTime()) {
    return end;
  }

  return date;
}

function buildScheduledTarget(date, timeText, settings, action) {
  const baseTarget = buildDateFromTime(date, timeText);

  if (!settings.fuzzyTimeEnabled || settings.fuzzyMinutes <= 0) {
    return baseTarget;
  }

  const offsetMinutes = randomIntegerInclusive(0, settings.fuzzyMinutes);
  const target = new Date(baseTarget);

  if (action === "clockIn") {
    target.setMinutes(target.getMinutes() - offsetMinutes);
  } else {
    target.setMinutes(target.getMinutes() + offsetMinutes);
  }

  return clampToDay(target, date);
}

class SchedulerService {
  constructor({ getSettings, onTrigger, onMissed, onDayChanged, onScheduleChanged, log }) {
    this.getSettings = getSettings;
    this.onTrigger = onTrigger;
    this.onMissed = onMissed;
    this.onDayChanged = onDayChanged;
    this.onScheduleChanged = onScheduleChanged;
    this.log = log;
    this.currentDateKey = toDateKey(new Date());
    this.timers = {
      clockIn: null,
      clockOut: null
    };
    this.plans = {
      clockIn: null,
      clockOut: null
    };
    this.dayWatcher = null;
    this.active = false;
  }

  start() {
    this.stop();
    this.active = true;
    this.currentDateKey = toDateKey(new Date());
    this.#scheduleAll();
    this.dayWatcher = setInterval(() => this.#handleDayBoundary(), 30 * 1000);
  }

  stop() {
    this.active = false;
    this.#clearTimersAndPlans();

    if (this.dayWatcher) {
      clearInterval(this.dayWatcher);
      this.dayWatcher = null;
    }
  }

  refresh() {
    if (!this.active) {
      return;
    }

    this.#clearTimersAndPlans();
    this.#scheduleAll();
  }

  getSchedulePreview() {
    return {
      clockIn: this.plans.clockIn ? this.plans.clockIn.scheduledFor : null,
      clockOut: this.plans.clockOut ? this.plans.clockOut.scheduledFor : null
    };
  }

  getActionPlan(action) {
    const plan = this.plans[action];

    return plan
      ? { ...plan }
      : null;
  }

  #handleDayBoundary() {
    const nextDateKey = toDateKey(new Date());

    if (nextDateKey === this.currentDateKey) {
      return;
    }

    this.currentDateKey = nextDateKey;
    this.#clearTimersAndPlans();
    this.onDayChanged();
    this.#scheduleAll();
  }

  #scheduleAll() {
    const settings = this.getSettings();
    this.#scheduleInitialAction("clockIn", settings.morningTime, settings);
    this.#scheduleInitialAction("clockOut", settings.eveningTime, settings);
    this.#emitScheduleChanged();
  }

  #scheduleInitialAction(action, timeText, settings) {
    const now = new Date();
    const target = buildScheduledTarget(now, timeText, settings, action);
    const delayMs = target.getTime() - now.getTime();

    if (delayMs <= 0) {
      this.log.info(`Skipped scheduling ${action} for today because ${timeText} has already passed.`);
      this.plans[action] = null;
      return;
    }

    this.#scheduleAction(action, {
      scheduledFor: target.toISOString(),
      attemptIndex: 1,
      maxAttempts: 1 + Math.max(0, settings.scheduledRetryCount || 0),
      isRetry: false
    });
  }

  #scheduleRetry(action, previousPlan) {
    const retryDelayMs = randomIntegerInclusive(RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS);
    const scheduledFor = new Date(Date.now() + retryDelayMs);
    const retryPlan = {
      scheduledFor: scheduledFor.toISOString(),
      attemptIndex: previousPlan.attemptIndex + 1,
      maxAttempts: previousPlan.maxAttempts,
      isRetry: true
    };

    this.log.info(`Queued retry ${retryPlan.attemptIndex} of ${retryPlan.maxAttempts} for ${action} at ${scheduledFor.toLocaleString()}.`, {
      retryDelayMs
    });
    this.#scheduleAction(action, retryPlan);
  }

  #scheduleAction(action, plan) {
    const scheduledForDate = new Date(plan.scheduledFor);
    const delayMs = scheduledForDate.getTime() - Date.now();

    if (delayMs <= 0) {
      return;
    }

    this.plans[action] = {
      ...plan,
      scheduledFor: scheduledForDate.toISOString()
    };
    this.timers[action] = setTimeout(() => {
      void this.#runAction(action, this.plans[action]);
    }, delayMs);

    if (!plan.isRetry) {
      this.log.info(`Scheduled ${action} for ${scheduledForDate.toLocaleString()}.`);
    }

    this.#emitScheduleChanged();
  }

  async #runAction(action, plan) {
    if (!this.active) {
      return;
    }

    if (!plan || !this.plans[action] || this.plans[action].scheduledFor !== plan.scheduledFor) {
      return;
    }

    this.timers[action] = null;
    this.plans[action] = null;
    this.#emitScheduleChanged();

    const scheduledFor = new Date(plan.scheduledFor);
    const now = Date.now();
    const delayMs = now - scheduledFor.getTime();

    if (delayMs > MAX_ALLOWED_DELAY_MS) {
      await this.onMissed(action, {
        scheduledFor: scheduledFor.toISOString(),
        delayMs,
        attemptIndex: plan.attemptIndex,
        maxAttempts: plan.maxAttempts,
        isRetry: plan.isRetry
      });
      return;
    }

    const result = await this.onTrigger(action, {
      source: "scheduled",
      scheduledFor: scheduledFor.toISOString(),
      attemptIndex: plan.attemptIndex,
      maxAttempts: plan.maxAttempts,
      isRetry: plan.isRetry
    });

    if (!this.active || !result || result.status !== "Failed") {
      return;
    }

    if (plan.attemptIndex >= plan.maxAttempts) {
      return;
    }

    this.#scheduleRetry(action, plan);
  }

  #clearTimersAndPlans() {
    Object.keys(this.timers).forEach((key) => {
      if (this.timers[key]) {
        clearTimeout(this.timers[key]);
        this.timers[key] = null;
      }

      this.plans[key] = null;
    });

    this.#emitScheduleChanged();
  }

  #emitScheduleChanged() {
    if (typeof this.onScheduleChanged === "function") {
      this.onScheduleChanged(this.getSchedulePreview());
    }
  }
}

module.exports = {
  MAX_ALLOWED_DELAY_MS,
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MIN_MS,
  SchedulerService,
  buildDateFromTime,
  buildScheduledTarget,
  toDateKey
};
