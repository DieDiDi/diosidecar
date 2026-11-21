import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * @param {string} file
 * @param {import('electron').SafeStorage} safeStorage
 * @param {NodeJS.Platform} platform
 */
export function createApiKeyStore(file, safeStorage, platform = process.platform) {
  let pending = Promise.resolve();

  /** @template T @param {() => Promise<T>} operation */
  function run(operation) {
    const result = pending.then(operation);
    pending = result.then(() => {}, () => {});
    return result;
  }

  function encryptionAvailable() {
    return safeStorage.isEncryptionAvailable() &&
      (platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  }

  /** @returns {Promise<Record<string, string>>} */
  async function readKeys() {
    try {
      const keys = JSON.parse(await readFile(file, "utf8"));
      if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
        throw new Error("Invalid API key store");
      }
      return keys;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  /** @param {Record<string, string>} keys */
  async function writeKeys(keys) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(keys, null, 2), { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** @param {string} key */
  function encrypt(key) {
    return `enc:${safeStorage.encryptString(key).toString("base64")}`;
  }

  return {
    /** @param {string} backend @param {string | null} key */
    set(backend, key) {
      return run(async () => {
        if (key && !encryptionAvailable()) {
          throw new Error("Secure key storage is unavailable. Use your agent CLI sign-in or enable a system keyring.");
        }
        const keys = await readKeys();
        if (key) {
          await writeKeys({ ...keys, [backend]: encrypt(key) });
        } else if (Object.hasOwn(keys, backend)) {
          delete keys[backend];
          await writeKeys(keys);
        }
      });
    },
    /** @param {string} backend */
    get(backend) {
      return run(async () => {
        if (!encryptionAvailable()) return null;
        const keys = await readKeys().catch(() => ({}));
        const entry = keys[backend];
        if (typeof entry !== "string") return null;
        if (entry.startsWith("raw:")) {
          // Upgrade keys written by the earlier Base64 fallback before using them.
          const key = Buffer.from(entry.slice(4), "base64").toString("utf8");
          await writeKeys({ ...keys, [backend]: encrypt(key) });
          return key;
        }
        if (!entry.startsWith("enc:")) return null;
        try {
          return safeStorage.decryptString(Buffer.from(entry.slice(4), "base64"));
        } catch {
          return null;
        }
      });
    },
  };
}
