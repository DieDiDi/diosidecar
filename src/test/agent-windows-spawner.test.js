import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { findBinary, withPathFirst } from "../../agent/core/agent/env.ts";
import { createNodeSpawner } from "../../agent/main/node-spawner.ts";

test("Windows executable lookup keeps a single case-insensitive PATH", async () => {
  const installed = "C:\\Program Files\\nodejs";
  const preferred = "C:\\Tools\\node";
  const env = { Path: installed, SystemRoot: "D:\\Windows" };
  const node = installed + "\\node.exe";
  let invocation;
  const spawner = {
    windows: true,
    async run(command, args, options) {
      invocation = { command, args, env: options.env };
      return { code: 0, stdout: node + "\r\n", stderr: "" };
    },
  };
  assert.equal(await findBinary(spawner, env, "node"), node);
  assert.deepEqual(invocation, {
    command: "D:\\Windows\\System32\\where.exe",
    args: ["node"],
    env: { SystemRoot: env.SystemRoot, PATH: installed },
  });
  assert.deepEqual(withPathFirst(env, preferred), { SystemRoot: env.SystemRoot, PATH: preferred + ";" + installed });
  assert.equal(env.Path, installed);
});

test("the desktop spawner finds and runs Node.js on Windows", { skip: process.platform !== "win32" }, async () => {
  const spawner = createNodeSpawner({ baseEnv: { Path: dirname(process.execPath), SystemRoot: process.env.SystemRoot, PATHEXT: ".EXE" } });
  assert.equal(spawner.windows, true);
  const env = await spawner.baseEnv();
  const node = await findBinary(spawner, env, "node");
  assert.ok(node);
  const result = await spawner.run(node, ["--version"], { env, timeoutMs: 10_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), process.version);
});
