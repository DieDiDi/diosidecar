import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiKeyStore } from "../../agent/main/api-key-store.js";

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (key) => Buffer.from(`mock ciphertext for ${key}`),
  decryptString: (data) => data.toString().slice("mock ciphertext for ".length),
};

async function keyFile(t) {
  const directory = await mkdtemp(join(tmpdir(), "draw-agent-keys-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "keys.json");
}

test("keeps concurrent provider updates and allows removal", async (t) => {
  const file = await keyFile(t);
  const store = createApiKeyStore(file, mockSafeStorage);
  await Promise.all([store.set("codex", "test-one"), store.set("claude-code", "test-two")]);
  assert.equal(await store.get("codex"), "test-one");
  assert.equal(await store.get("claude-code"), "test-two");
  const keys = JSON.parse(await readFile(file, "utf8"));
  assert.ok(Object.values(keys).every((entry) => entry.startsWith("enc:")));
  await store.set("codex", null);
  assert.equal(await store.get("codex"), null);
  assert.equal(await store.get("claude-code"), "test-two");
});

test("rejects unavailable and basic-text credential storage", async (t) => {
  const file = await keyFile(t);
  const unavailable = createApiKeyStore(file, { ...mockSafeStorage, isEncryptionAvailable: () => false });
  const basicText = createApiKeyStore(file, { ...mockSafeStorage, getSelectedStorageBackend: () => "basic_text" }, "linux");
  for (const store of [unavailable, basicText]) {
    await assert.rejects(store.set("codex", "test-key"), /Secure key storage is unavailable/);
    assert.equal(await store.get("codex"), null);
  }
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("converts a legacy Base64 key before using it", async (t) => {
  const file = await keyFile(t);
  const legacy = `raw:${Buffer.from("test-key").toString("base64")}`;
  await writeFile(file, JSON.stringify({ codex: legacy }));
  const store = createApiKeyStore(file, mockSafeStorage);
  assert.equal(await store.get("codex"), "test-key");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.match(saved.codex, /^enc:/);
  assert.equal(await store.get("codex"), "test-key");
});
