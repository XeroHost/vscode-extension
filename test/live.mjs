// Live API test against a real panel. Not shipped (see .vscodeignore).
// Usage: node live.mjs <key.json> <origin> <server>   (run after `npm run build:test`)
import assert from 'node:assert/strict';
import { shim } from './vscode-shim.mjs';
import { readFileSync } from 'node:fs';
import {
  ApiError,
  checkOrigin,
  ConsolePseudoterminal,
  PanelClient,
  provisionApiKey,
  serverUri,
  WingsSocketHub,
  XeroHostFileSystem,
} from './bundle/extension-under-test.mjs';

const [keyFile, origin, serverId] = process.argv.slice(2);
const { key } = JSON.parse(readFileSync(keyFile, 'utf8'));

const results = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${err?.stack ?? err}`);
  }
}

const client = new PanelClient({ origin, apiKey: key });
const session = {
  client: async () => client,
  clientIfSignedIn: async () => client,
};

const FOLDER = '/ui-test-vscode';
const dec = new TextDecoder();
const enc = new TextEncoder();
const uriOf = (path) => serverUri(origin, serverId, path);
const fs = new XeroHostFileSystem(session);

await step('origin validation', () => {
  assert.equal(checkOrigin('https://raimond.xerosrv.com').ok, true);
  assert.equal(checkOrigin('http://127.0.0.1:3000').ok, true);
  assert.equal(checkOrigin('http://localhost').ok, true);
  assert.equal(checkOrigin('http://evil.example').ok, false);
  assert.equal(checkOrigin('javascript:alert(1)').ok, false);
  assert.equal(checkOrigin('https://user:pw@evil.example').ok, false);
});

async function startSignIn(origin) {
  shim.opened.length = 0;
  shim.nextInput = undefined;
  const result = provisionApiKey(origin);
  for (let i = 0; i < 50 && shim.opened.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const url = new URL(shim.opened[0]);
  return { result, url, callback: new URL(url.searchParams.get('callback_url')), state: url.searchParams.get('state') };
}

await step('sign-in: authorize URL + loopback callback (key)', async () => {
  const { result, url, callback, state } = await startSignIn('https://panel.example');
  assert.equal(url.origin + url.pathname, 'https://panel.example/account/vscode/authorize');
  assert.equal(url.searchParams.get('client'), 'VS Code');
  assert.ok(state.length >= 32, 'state has at least 128 bits of entropy');
  assert.equal(callback.hostname, '127.0.0.1');
  assert.equal(callback.pathname, '/callback');

  const wrong = await fetch(`${callback.origin}/callback?state=wrong&key=stolen`);
  assert.equal(wrong.status, 400);
  const other = await fetch(`${callback.origin}/elsewhere?state=${state}&key=k`);
  assert.equal(other.status, 404);
  const post = await fetch(`${callback.origin}/callback?state=${state}&key=k`, { method: 'POST' });
  assert.equal(post.status, 404);

  const ok = await fetch(`${callback.origin}/callback?state=${state}&key=ptlc_testkey`);
  assert.equal(ok.status, 200);
  assert.equal(await result, 'ptlc_testkey');
  await assert.rejects(fetch(`${callback.origin}/callback?state=${state}&key=again`));
});

await step('sign-in: access_denied from the panel', async () => {
  const { result, callback, state } = await startSignIn('https://panel.example');
  const res = await fetch(`${callback.origin}/callback?state=${state}&error=access_denied`);
  assert.equal(res.status, 200);
  assert.equal(await result, null);
});

await step('sign-in: manual paste fallback', async () => {
  shim.opened.length = 0;
  shim.nextInput = '  ptlc_pasted  ';
  assert.equal(await provisionApiKey('https://panel.example'), 'ptlc_pasted');
});

await step('account', async () => (await client.getAccount()).username);

await step('server list + get server', async () => {
  const servers = await client.listServers();
  const server = await client.getServer(serverId);
  assert.equal(server.identifier, serverId);
  return `${servers.length} in list (hidden-access user), server "${server.name}"`;
});

await step('bad key is rejected with 401', async () => {
  const bad = new PanelClient({ origin, apiKey: 'ptlc_invalid' });
  await assert.rejects(bad.getAccount(), (e) => e instanceof ApiError && e.status === 401);
});

try {
  await step('stat/readDirectory root', async () => {
    assert.equal((await fs.stat(uriOf('/'))).type, 2);
    const entries = await fs.readDirectory(uriOf('/'));
    assert.ok(entries.length > 0);
    return `${entries.length} entries`;
  });

  await step('stat on missing path -> FileNotFound (parent listing)', async () => {
    await assert.rejects(fs.stat(uriOf('/definitely-missing-xyz')), (e) => e.code === 'FileNotFound');
    await assert.rejects(fs.stat(uriOf('/definitely-missing-xyz/inner.txt')), (e) => e.code === 'FileNotFound');
  });

  await step('createDirectory', async () => {
    await fs.createDirectory(uriOf(FOLDER));
    assert.equal((await fs.stat(uriOf(FOLDER))).type, 2);
  });

  await step('writeFile create + readFile', async () => {
    await fs.writeFile(uriOf(`${FOLDER}/a.txt`), enc.encode('hello xerohost\n'), { create: true, overwrite: false });
    assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/a.txt`))), 'hello xerohost\n');
    const stat = await fs.stat(uriOf(`${FOLDER}/a.txt`));
    assert.equal(stat.type, 1);
    assert.equal(stat.size, 15);
  });

  await step('writeFile respects create/overwrite flags', async () => {
    await assert.rejects(
      fs.writeFile(uriOf(`${FOLDER}/a.txt`), enc.encode('x'), { create: true, overwrite: false }),
      (e) => e.code === 'FileExists',
    );
    await assert.rejects(
      fs.writeFile(uriOf(`${FOLDER}/none.txt`), enc.encode('x'), { create: false, overwrite: true }),
      (e) => e.code === 'FileNotFound',
    );
    await fs.writeFile(uriOf(`${FOLDER}/a.txt`), enc.encode('second\n'), { create: false, overwrite: true });
    assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/a.txt`))), 'second\n');
  });

  await step('binary roundtrip (all byte values)', async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    await fs.writeFile(uriOf(`${FOLDER}/b.bin`), bytes, { create: true, overwrite: true });
    const back = await fs.readFile(uriOf(`${FOLDER}/b.bin`));
    assert.deepEqual(Buffer.from(back), Buffer.from(bytes));
  });

  await step('rename (same dir) + overwrite flag', async () => {
    await fs.rename(uriOf(`${FOLDER}/a.txt`), uriOf(`${FOLDER}/renamed.txt`), { overwrite: false });
    await assert.rejects(fs.stat(uriOf(`${FOLDER}/a.txt`)), (e) => e.code === 'FileNotFound');
    assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/renamed.txt`))), 'second\n');
    await assert.rejects(
      fs.rename(uriOf(`${FOLDER}/renamed.txt`), uriOf(`${FOLDER}/b.bin`), { overwrite: false }),
      (e) => e.code === 'FileExists',
    );
  });

  await step('move into a subfolder', async () => {
    await fs.createDirectory(uriOf(`${FOLDER}/sub`));
    await fs.rename(uriOf(`${FOLDER}/renamed.txt`), uriOf(`${FOLDER}/sub/moved.txt`), { overwrite: false });
    assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/sub/moved.txt`))), 'second\n');
  });

  await step('copy file and folder', async () => {
    await fs.copy(uriOf(`${FOLDER}/sub/moved.txt`), uriOf(`${FOLDER}/copied.txt`), { overwrite: false });
    assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/copied.txt`))), 'second\n');
    await fs.copy(uriOf(`${FOLDER}/sub`), uriOf(`${FOLDER}/sub-copy`), { overwrite: false });
    assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/sub-copy/moved.txt`))), 'second\n');
    await assert.rejects(
      fs.copy(uriOf(`${FOLDER}/copied.txt`), uriOf(`${FOLDER}/sub`), { overwrite: false }),
      (e) => e.code === 'FileExists',
    );
  });

  await step('readDirectory lists what was created', async () => {
    const names = (await fs.readDirectory(uriOf(FOLDER))).map(([n]) => n).sort();
    assert.deepEqual(names, ['b.bin', 'copied.txt', 'sub', 'sub-copy']);
  });

  await step('large file: upload (2 MiB) then signed download (5 MiB)', async () => {
    const two = Buffer.alloc(2 * 1024 * 1024, 'abcdefgh');
    await fs.writeFile(uriOf(`${FOLDER}/two.bin`), two, { create: true, overwrite: true });
    assert.equal((await fs.stat(uriOf(`${FOLDER}/two.bin`))).size, two.length);
    assert.deepEqual(Buffer.from(await fs.readFile(uriOf(`${FOLDER}/two.bin`))), two);

    const five = Buffer.alloc(5 * 1024 * 1024, 'xyz');
    await fs.writeFile(uriOf(`${FOLDER}/five.bin`), five, { create: true, overwrite: true });
    assert.deepEqual(Buffer.from(await fs.readFile(uriOf(`${FOLDER}/five.bin`))), five);
  });

  await step('compress + decompress', async () => {
    const archive = await client.compress(serverId, FOLDER, ['sub']);
    assert.match(archive, /\.(tar\.gz|zip)$/);
    await client.delete(serverId, FOLDER, ['sub']);
    await client.decompress(serverId, FOLDER, archive);
    fs.invalidatePath({ origin, server: serverId }, FOLDER);
    assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/sub/moved.txt`))), 'second\n');
    return archive;
  });

  await step('delete file', async () => {
    await fs.delete(uriOf(`${FOLDER}/copied.txt`), { recursive: false });
    await assert.rejects(fs.stat(uriOf(`${FOLDER}/copied.txt`)), (e) => e.code === 'FileNotFound');
  });
} finally {
  await step('cleanup: delete folder recursively', async () => {
    await fs.delete(uriOf(FOLDER), { recursive: true });
    await assert.rejects(fs.stat(uriOf(FOLDER)), (e) => e.code === 'FileNotFound');
  });
}

await step('console websocket + pseudoterminal (no commands, no power)', async () => {
  const hub = new WingsSocketHub(session);
  const target = { origin, uuid: (await client.getServer(serverId)).uuid, name: 'Minecraft Java' };

  const lease = hub.acquire(origin, target.uuid);
  const events = [];
  lease.on('CONNECTION_ERROR', (e) => events.push(`error:${e.message}`));
  const authed = new Promise((resolve) => lease.whenAuthenticated(resolve));
  const authAgain = new Promise((resolve) => {
    let seen = 0;
    lease.on('auth success', () => {
      if (++seen === 2) resolve();
    });
  });
  const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label} ${events.join(',')}`)), ms));

  const pty = new ConsolePseudoterminal(hub, target);
  let output = '';
  pty.onDidWrite((chunk) => {
    output += chunk;
  });
  pty.open();

  await Promise.race([authed, timeout(15000, 'auth success')]);
  await new Promise((r) => setTimeout(r, 3000));
  const lines = output.split('\r\n').filter(Boolean);

  // token refresh path: ask for a new token and re-authenticate on the same socket
  const socket = [...hub.entries.values()][0].socket;
  await socket.refreshToken();
  await Promise.race([authAgain, timeout(15000, 're-auth success after token refresh')]);

  pty.close();
  lease.release();
  hub.dispose();
  assert.ok(lines.length > 1, `expected backlog lines, got ${lines.length}`);
  const sample = lines.find((l) => !l.includes('Connecting')) ?? '';
  return `${lines.length} lines rendered, token refresh re-authenticated; sample: ${sample.slice(0, 80).replace(/\x1b\[[0-9;]*m/g, '')}`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
