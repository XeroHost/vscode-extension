// Live API test against a real panel. Not shipped (see .vscodeignore).
// Usage: node live.mjs <key.json> <origin> <server>   (run after `npm run build:test`)
import assert from 'node:assert/strict';
import { shim } from './vscode-shim.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import {
  ApiError,
  callbackPage,
  checkOrigin,
  ConsolePseudoterminal,
  PanelClient,
  pickLanguage,
  provisionApiKey,
  serverUri,
  stateLabel,
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

const FOLDER = '/ui-test-vscode2';
const ROOT = new URL('..', import.meta.url).pathname;
const LANGS = ['es', 'pt-br', 'fr', 'de', 'it', 'tr', 'zh-cn', 'ja', 'ko'];
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

await step('l10n: key/bundle consistency script passes (code, manifest, page strings)', async () => {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('node', [`${ROOT}scripts/check-l10n.mjs`], { encoding: 'utf8' }).trim();
});

await step('l10n: every bundle loads through vscode.l10n.t and translates runtime strings', async () => {
  const english = checkOrigin('http://evil.example').reason;
  assert.match(english, /^Only https/);
  assert.equal(stateLabel('running'), 'Running');
  for (const lang of LANGS) {
    shim.bundle = JSON.parse(readFileSync(`${ROOT}l10n/bundle.l10n.${lang}.json`, 'utf8'));
    const reason = checkOrigin('http://evil.example').reason;
    assert.notEqual(reason, english, `${lang}: origin error not translated`);
    assert.ok(!/\{\d\}/.test(reason));
    if (lang === 'es') {
      assert.equal(stateLabel('offline'), 'Apagado');
      assert.equal(stateLabel('running'), 'En ejecución');
      assert.equal(reason, 'Solo se admiten paneles https:// (http:// solo para localhost)');
    }
    // placeholders are filled in by the real code path
    const err = await fs.rename(uriOf('/a'), serverUri(origin, 'othersrv', '/b'), { overwrite: false }).catch((e) => e);
    assert.notEqual(err.message, 'Cannot rename across servers.', `${lang}: rename error not translated`);
  }
  shim.bundle = undefined;
  assert.equal(checkOrigin('http://evil.example').reason, english);
  return `${LANGS.length} bundles`;
});

await step('l10n: manifest bundles (package.nls.*) cover the 10 languages', () => {
  const files = readdirSync(ROOT).filter((f) => /^package\.nls(\.[a-z-]+)?\.json$/.test(f));
  assert.equal(files.length, 10);
  const en = JSON.parse(readFileSync(`${ROOT}package.nls.json`, 'utf8'));
  const es = JSON.parse(readFileSync(`${ROOT}package.nls.es.json`, 'utf8'));
  assert.equal(es['command.signIn'], 'Iniciar sesión');
  assert.equal(es['command.signOut'], 'Cerrar sesión');
  assert.equal(es['command.refresh'], 'Actualizar');
  assert.equal(Object.keys(es).length, Object.keys(en).length);
});

await step('callback page language: Accept-Language parsing + translations', () => {
  assert.equal(pickLanguage('es-ES,es;q=0.9,en;q=0.8', 'en'), 'es');
  assert.equal(pickLanguage('pt-BR,pt;q=0.9', 'en'), 'pt-br');
  assert.equal(pickLanguage('pt-PT', 'en'), 'pt-br');
  assert.equal(pickLanguage('zh-CN,zh;q=0.9', 'en'), 'zh-cn');
  assert.equal(pickLanguage('zh-Hans', 'en'), 'zh-cn');
  assert.equal(pickLanguage('ja;q=0.5, ko;q=0.9', 'en'), 'ko');
  assert.equal(pickLanguage('xx-YY, de;q=0.5', 'en'), 'de');
  assert.equal(pickLanguage('xx', 'fr'), 'fr', 'falls back to the VS Code display language');
  assert.equal(pickLanguage(undefined, 'tr'), 'tr');
  assert.equal(pickLanguage('xx', 'klingon'), 'en');
  assert.equal(pickLanguage('es;q=0', 'en'), 'en', 'q=0 means not acceptable');
  for (const [lang, lc] of [['es', 'es'], ['pt-br', 'pt-BR'], ['fr', 'fr'], ['de', 'de'], ['it', 'it'], ['tr', 'tr'], ['zh-cn', 'zh-CN'], ['ja', 'ja'], ['ko', 'ko'], ['en', 'en']]) {
    const html = callbackPage({ tone: 'success', heading: 'signedInHeading', message: 'signedInMessage', language: lang });
    assert.ok(html.includes(`<html lang="${lc}">`), lang);
    if (lang !== 'en') assert.ok(!html.includes('Signed in</h1>'), `${lang} page is still English`);
  }
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

await step('sign-in: loopback callback page is served in the browser language', async () => {
  const { result, callback, state } = await startSignIn('https://panel.example');
  const wrong = await fetch(`${callback.origin}/callback?state=wrong`, { headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' } });
  assert.equal(wrong.status, 400);
  const wrongHtml = await wrong.text();
  assert.ok(wrongHtml.includes('<html lang="pt-BR">') && wrongHtml.includes('Solicitação inválida'));
  const ok = await fetch(`${callback.origin}/callback?state=${state}&key=ptlc_lang`, { headers: { 'Accept-Language': 'ja,en;q=0.5' } });
  const html = await ok.text();
  assert.ok(html.includes('<html lang="ja">') && html.includes('サインインしました'), 'success page in Japanese');
  assert.ok(!html.includes('ptlc_lang'), 'the key is never echoed into the page');
  assert.equal(await result, 'ptlc_lang');
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

  const ref = { origin, server: serverId };
  const collect = () => {
    const events = [];
    const sub = fs.onDidChangeFile((batch) => events.push(...batch));
    return { events, stop: () => sub.dispose() };
  };
  const find = (events, type, path) => events.filter((e) => e.type === type && e.uri.toString() === uriOf(path).toString());

  await step('poll: file created / changed / deleted by a direct API call (panel simulation) fires events', async () => {
    const { events, stop } = collect();
    const watch = fs.watch(uriOf(FOLDER), { recursive: false, excludes: [] });
    try {
      await fs.readDirectory(uriOf(FOLDER)); // the explorer lists it: that is the baseline
      assert.equal(await fs.pollOnce(), 2, 'root + the watched folder (found to be a folder by the first listing)');
      assert.equal(events.length, 0, 'an unchanged directory fires nothing');

      await client.writeFile(serverId, `${FOLDER}/ext.txt`, enc.encode('v1'));
      await fs.pollOnce();
      assert.equal(find(events, 2, `${FOLDER}/ext.txt`).length, 1, 'Created');

      await client.writeFile(serverId, `${FOLDER}/ext.txt`, enc.encode('version two'));
      await fs.pollOnce();
      const changed = find(events, 1, `${FOLDER}/ext.txt`);
      assert.equal(changed.length, 1, 'Changed');
      assert.deepEqual(Object.keys(changed[0]).sort(), ['type', 'uri'], 'event shape {type, uri}: what an open editor reloads from');
      // the file VS Code would re-read is already fresh (poll refreshed the listing cache)
      assert.equal((await fs.stat(uriOf(`${FOLDER}/ext.txt`))).size, 11);
      assert.equal(dec.decode(await fs.readFile(uriOf(`${FOLDER}/ext.txt`))), 'version two');

      await client.delete(serverId, FOLDER, ['ext.txt']);
      await fs.pollOnce();
      assert.equal(find(events, 3, `${FOLDER}/ext.txt`).length, 1, 'Deleted');

      await fs.pollOnce();
      assert.equal(events.length, 3, 'no duplicate events on later cycles');
    } finally {
      watch.dispose();
      stop();
    }
  });

  await step('poll: watching a single open file reports external edits; own saves are not echoed', async () => {
    const path = `${FOLDER}/open.txt`;
    const { events, stop } = collect();
    const watch = fs.watch(uriOf(path), { recursive: false, excludes: [] });
    try {
      await fs.writeFile(uriOf(path), enc.encode('mine'), { create: true, overwrite: true });
      const afterOwnWrite = events.length;
      assert.ok(afterOwnWrite >= 1, 'the write itself fires its own event');
      await fs.readDirectory(uriOf(FOLDER));
      await fs.pollOnce();
      await fs.pollOnce();
      assert.equal(events.length, afterOwnWrite, 'the poll does not report our own write again');

      await client.writeFile(serverId, path, enc.encode('edited in the panel'));
      await fs.pollOnce();
      assert.equal(find(events, 1, path).length, 1, 'external edit -> Changed on that file');
    } finally {
      watch.dispose();
      stop();
    }
  });

  await step('poll: unfocused window is skipped; 429 backs the cycle off; dirs per cycle are capped', async () => {
    const dir = `${FOLDER}/sub`;
    const watch = fs.watch(uriOf(dir), { recursive: false, excludes: [] });
    shim.focused = false;
    try {
      assert.equal(await fs.pollOnce(), 0, 'nothing listed while unfocused');
    } finally {
      shim.focused = true;
      watch.dispose();
    }

    let calls = 0;
    let failWith = null;
    const stubClient = {
      listDirectory: async () => {
        calls++;
        if (failWith) throw failWith;
        return [];
      },
    };
    const stub = new XeroHostFileSystem({ client: async () => stubClient, clientIfSignedIn: async () => stubClient });
    for (let i = 0; i < 30; i++) stub.watch(uriOf(`/d${i}/file.txt`), { recursive: false, excludes: [] });
    shim.config['xerohost.files.pollIntervalSeconds'] = 10;
    assert.equal(await stub.pollOnce(), 10, '10s interval -> at most 10 directories (60 requests/min)');
    for (let i = 0; i < 3; i++) await stub.pollOnce();
    assert.equal(calls, 40);
    shim.config['xerohost.files.pollIntervalSeconds'] = 60;
    calls = 0;
    assert.equal(await stub.pollOnce(), 20, 'never more than 20 directories per cycle');
    shim.config['xerohost.files.pollIntervalSeconds'] = undefined;

    failWith = new ApiError(429, 'Too Many Requests');
    calls = 0;
    assert.equal(await stub.pollOnce(), 0);
    assert.equal(calls, 1, 'a 429 stops the whole cycle after one request');
    assert.equal(stub.backoffFactor, 2);
    await stub.pollOnce();
    await stub.pollOnce();
    await stub.pollOnce();
    await stub.pollOnce();
    assert.equal(stub.backoffFactor, 8, 'backoff is capped at 8x');
    failWith = null;
    await stub.pollOnce();
    assert.equal(stub.backoffFactor, 1, 'a good cycle resets the backoff');
    stub.dispose();
  });

  await step('poll: interval timer drives the cycle on its own; setting 0 turns it off; dispose stops it', async () => {
    shim.config['xerohost.files.pollIntervalSeconds'] = 3;
    const { events, stop } = collect();
    const watch = fs.watch(uriOf(FOLDER), { recursive: false, excludes: [] });
    try {
      assert.ok(fs.timer, 'timer armed by watch()');
      await fs.readDirectory(uriOf(FOLDER));
      await client.writeFile(serverId, `${FOLDER}/timer.txt`, enc.encode('t'));
      const started = Date.now();
      while (find(events, 2, `${FOLDER}/timer.txt`).length === 0 && Date.now() - started < 12_000) {
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(find(events, 2, `${FOLDER}/timer.txt`).length, 1);
      await client.delete(serverId, FOLDER, ['timer.txt']);

      shim.config['xerohost.files.pollIntervalSeconds'] = 0;
      fs.schedule();
      assert.equal(fs.timer, null, 'interval 0 disables polling');
      return `Created seen after ${((Date.now() - started) / 1000).toFixed(1)}s`;
    } finally {
      shim.config['xerohost.files.pollIntervalSeconds'] = undefined;
      watch.dispose();
      stop();
      assert.equal(fs.timer, null, 'dispose of the last watcher stops the timer');
    }
  });

  await step('refresh: clears caches, fires Changed for the root, and diffs watched folders', async () => {
    const { events, stop } = collect();
    const watch = fs.watch(uriOf(FOLDER), { recursive: false, excludes: [] });
    try {
      await fs.readDirectory(uriOf(FOLDER));
      await fs.readDirectory(uriOf('/'));
      await client.writeFile(serverId, `${FOLDER}/refreshed.txt`, enc.encode('r'));
      // inside the 2.5s cache window a plain listing would still be stale
      assert.ok(!(await fs.readDirectory(uriOf(FOLDER))).some(([n]) => n === 'refreshed.txt'), 'stale before refresh');

      await fs.refresh(ref);
      assert.equal(find(events, 1, '/').length, 1, 'root Changed');
      assert.equal(find(events, 1, FOLDER).length, 1, 'listed folder Changed');
      assert.equal(find(events, 2, `${FOLDER}/refreshed.txt`).length, 1, 'new file reported as Created');
      assert.ok((await fs.readDirectory(uriOf(FOLDER))).some(([n]) => n === 'refreshed.txt'), 'fresh after refresh');

      events.length = 0;
      await fs.refresh();
      assert.equal(find(events, 1, '/').length, 1, 'refresh() without a target covers every known server');
      await client.delete(serverId, FOLDER, ['refreshed.txt']);
    } finally {
      watch.dispose();
      stop();
    }
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

fs.dispose();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
