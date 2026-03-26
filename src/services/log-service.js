const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

class LogService extends EventEmitter {
  constructor(baseDirectory) {
    super();
    this.baseDirectory = path.join(baseDirectory, "logs");
    this.entries = [];
    fs.mkdirSync(this.baseDirectory, { recursive: true });
  }

  info(message, context) {
    this.#write("INFO", message, context);
  }

  warn(message, context) {
    this.#write("WARN", message, context);
  }

  error(message, context) {
    this.#write("ERROR", message, context);
  }

  getEntries(limit = 200) {
    return this.entries.slice(-limit);
  }

  #write(level, message, context) {
    const timestamp = new Date();
    const entry = {
      id: `${timestamp.getTime()}-${Math.random().toString(16).slice(2, 8)}`,
      level,
      message,
      context: context || null,
      timestamp: timestamp.toISOString()
    };

    this.entries.push(entry);

    if (this.entries.length > 400) {
      this.entries.shift();
    }

    const line = this.#formatLine(entry);
    const filePath = path.join(this.baseDirectory, `${entry.timestamp.slice(0, 10)}.log`);

    try {
      fs.appendFileSync(filePath, `${line}\n`, "utf8");
    } catch (error) {
      // Ignore file write errors so the app can continue running.
    }

    this.emit("entry", entry);
  }

  #formatLine(entry) {
    const date = new Date(entry.timestamp);
    const localTime = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-") + ` ${[
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0")
    ].join(":")}`;
    const contextSuffix = entry.context ? ` | ${JSON.stringify(entry.context)}` : "";
    return `[${localTime}] [${entry.level}] ${entry.message}${contextSuffix}`;
  }
}

module.exports = {
  LogService
};
