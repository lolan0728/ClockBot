const MAX_ALLOWED_DELAY_MS = 30 * 60 * 1000;

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

class SchedulerService {
  constructor({ getSettings, onTrigger, onMissed, onDayChanged, log }) {
    this.getSettings = getSettings;
    this.onTrigger = onTrigger;
    this.onMissed = onMissed;
    this.onDayChanged = onDayChanged;
    this.log = log;
    this.currentDateKey = toDateKey(new Date());
    this.timers = {
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
    this.#clearTimers();

    if (this.dayWatcher) {
      clearInterval(this.dayWatcher);
      this.dayWatcher = null;
    }
  }

  refresh() {
    if (!this.active) {
      return;
    }

    this.#clearTimers();
    this.#scheduleAll();
  }

  getSchedulePreview() {
    const settings = this.getSettings();
    const now = new Date();
    const morning = buildDateFromTime(now, settings.morningTime);
    const evening = buildDateFromTime(now, settings.eveningTime);

    return {
      clockIn: morning.getTime() > now.getTime() ? morning.toISOString() : null,
      clockOut: evening.getTime() > now.getTime() ? evening.toISOString() : null
    };
  }

  #handleDayBoundary() {
    const nextDateKey = toDateKey(new Date());

    if (nextDateKey === this.currentDateKey) {
      return;
    }

    this.currentDateKey = nextDateKey;
    this.#clearTimers();
    this.onDayChanged();
    this.#scheduleAll();
  }

  #scheduleAll() {
    const settings = this.getSettings();
    this.#scheduleAction("clockIn", settings.morningTime);
    this.#scheduleAction("clockOut", settings.eveningTime);
  }

  #scheduleAction(action, timeText) {
    const now = new Date();
    const target = buildDateFromTime(now, timeText);
    const delayMs = target.getTime() - now.getTime();

    if (delayMs <= 0) {
      this.log.info(`Skipped scheduling ${action} for today because ${timeText} has already passed.`);
      return;
    }

    this.log.info(`Scheduled ${action} for ${target.toLocaleString()}.`);
    this.timers[action] = setTimeout(() => {
      void this.#runAction(action, target);
    }, delayMs);
  }

  async #runAction(action, scheduledFor) {
    if (!this.active) {
      return;
    }

    const now = Date.now();
    const delayMs = now - scheduledFor.getTime();

    if (delayMs > MAX_ALLOWED_DELAY_MS) {
      await this.onMissed(action, {
        scheduledFor: scheduledFor.toISOString(),
        delayMs
      });
      return;
    }

    await this.onTrigger(action, {
      source: "scheduled",
      scheduledFor: scheduledFor.toISOString()
    });
  }

  #clearTimers() {
    Object.keys(this.timers).forEach((key) => {
      if (this.timers[key]) {
        clearTimeout(this.timers[key]);
        this.timers[key] = null;
      }
    });
  }
}

module.exports = {
  MAX_ALLOWED_DELAY_MS,
  SchedulerService,
  buildDateFromTime,
  toDateKey
};
