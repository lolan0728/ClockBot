const fs = require("fs");
const path = require("path");
const { safeStorage } = require("electron");

function sanitizeCredentials(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const username = typeof candidate.username === "string" ? candidate.username.trim() : "";
  const password = typeof candidate.password === "string" ? candidate.password : "";

  if (!username || !password) {
    return null;
  }

  return {
    username,
    password
  };
}

class CredentialsService {
  constructor(baseDirectory) {
    this.baseDirectory = baseDirectory;
    this.filePath = path.join(baseDirectory, "credentials.json");
    this.credentials = null;
  }

  isAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  load() {
    fs.mkdirSync(this.baseDirectory, { recursive: true });

    if (!fs.existsSync(this.filePath) || !this.isAvailable()) {
      this.credentials = null;
      return this.getCredentials();
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const payload = typeof parsed.payload === "string"
        ? Buffer.from(parsed.payload, "base64")
        : null;

      if (!payload) {
        this.credentials = null;
        return this.getCredentials();
      }

      const decrypted = safeStorage.decryptString(payload);
      this.credentials = sanitizeCredentials(JSON.parse(decrypted));
    } catch (error) {
      this.credentials = null;
    }

    return this.getCredentials();
  }

  save(credentials) {
    const nextCredentials = sanitizeCredentials(credentials);

    if (!nextCredentials) {
      throw new Error("Username and password are both required.");
    }

    if (!this.isAvailable()) {
      throw new Error("Secure credential storage is not available on this device.");
    }

    fs.mkdirSync(this.baseDirectory, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(nextCredentials));
    const payload = {
      payload: encrypted.toString("base64")
    };

    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    this.credentials = nextCredentials;
    return this.getCredentials();
  }

  clear() {
    this.credentials = null;

    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch (error) {
      // Keep going if cleanup fails.
    }
  }

  getCredentials() {
    return this.credentials
      ? { ...this.credentials }
      : null;
  }

  getPublicState() {
    return {
      username: this.credentials ? this.credentials.username : "",
      hasPassword: Boolean(this.credentials && this.credentials.password)
    };
  }
}

module.exports = {
  CredentialsService
};
