import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [archive, version] = process.argv.slice(2);
assert(archive && version, 'Usage: node .github/scripts/smoke-mac.mjs <zip> <version>');

const scratch = await mkdtemp(join(await realpath(tmpdir()), 'diosidecar-smoke-'));
const profile = join(scratch, 'profile');
const logPath = join(scratch, 'app.log');
const diagramName = 'quit-check.drawio';
const diagram = join(scratch, diagramName);
const appPath = join(scratch, 'DioSidecar.app', 'Contents', 'MacOS', 'DioSidecar');

async function waitForDiagram(child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert(child.exitCode === null && child.signalCode === null, 'The app exited before opening the diagram');
    const portFile = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const port = Number.parseInt(portFile, 10);
    if (Number.isInteger(port)) {
      // Use DevTools only to observe that the packaged renderer opened the file.
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      }).then((response) => response.json()).catch(() => []);
      if (pages.some((page) => page.type === 'page' && page.title.startsWith(`${diagramName} - `))) return;
    }
    await delay(250);
  }
  throw new Error(`The app did not open ${diagramName} in 60 seconds`);
}

try {
  await mkdir(profile);
  await run('/usr/bin/ditto', ['-x', '-k', resolve(archive), scratch], { timeout: 90_000, killSignal: 'SIGKILL' });
  const { stdout } = await run(appPath, [`--user-data-dir=${profile}`, '--version'], {
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(stdout.trim().split('\n').at(-1), version);

  await writeFile(diagram, '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>');
  const output = await open(logPath, 'w');
  const child = spawn(appPath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', diagram], {
    env: { ...process.env, DRAWIO_DISABLE_UPDATE: 'true' },
    stdio: ['ignore', output.fd, output.fd],
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ error }));
  });

  try {
    await output.close();
    await Promise.race([
      waitForDiagram(child),
      exited.then(({ error, code, signal }) => {
        throw error ?? new Error(`The app exited before opening the diagram (${signal ?? code})`);
      }),
    ]);
    const { stdout: sent } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('AppKit');
      $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).terminate;
    `], { timeout: 5000, killSignal: 'SIGKILL' });
    assert.equal(sent.trim(), 'true', 'macOS did not accept the normal Quit request');

    const result = await Promise.race([exited, delay(15_000, null, { ref: false })]);
    assert(result, 'The app did not exit within 15 seconds of the normal Quit request');
    assert.equal(result.code, 0, `The app did not exit cleanly (${result.error ?? result.signal ?? result.code})`);
    console.log(`DioSidecar ${version} opened ${diagramName} and quit normally`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
} catch (error) {
  const log = await readFile(logPath, 'utf8').catch(() => '');
  if (log) console.error(log);
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
