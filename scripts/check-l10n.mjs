// Fails when a string used in the code or in package.json is missing from a language bundle.
//   node scripts/check-l10n.mjs          check everything
//   node scripts/check-l10n.mjs --list   print the runtime keys found in src/
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['es', 'pt-br', 'fr', 'de', 'it', 'tr', 'zh-cn', 'ja', 'ko']; // 'en' is the source text itself
const ALL_LANGS = ['en', ...LANGS];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const errors = [];
const fail = (message) => errors.push(message);

/** Reads a JS string literal starting at `i` (quote char at src[i]); returns [value, endIndex]. */
function readLiteral(src, i) {
  const quote = src[i];
  let out = '';
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (c === quote) {
      return [out, i + 1];
    } else if (quote === '`' && c === '$' && src[i + 1] === '{') {
      return [null, i];
    } else {
      out += c;
    }
  }
  return [null, i];
}

// --- runtime keys: l10n.t('literal', ...) ---
const keys = new Map(); // key -> first location
for (const file of walk(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  const call = /l10n\.t\(\s*/g;
  let m;
  while ((m = call.exec(src))) {
    const at = m.index + m[0].length;
    const where = `${file.slice(root.length + 1)}:${src.slice(0, m.index).split('\n').length}`;
    if (!`'"\``.includes(src[at])) {
      fail(`${where}: l10n.t() needs a string literal as first argument`);
      continue;
    }
    const [value] = readLiteral(src, at);
    if (value === null) {
      fail(`${where}: l10n.t() key must be a plain literal (no \${} interpolation)`);
      continue;
    }
    if (!keys.has(value)) keys.set(value, where);
  }
}

if (process.argv.includes('--list')) {
  for (const k of keys.keys()) console.log(k);
  process.exit(0);
}

const placeholders = (text) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort().join(',');

function checkTable(label, expected, table, sourceOf = (k) => k) {
  for (const key of expected) {
    const value = table[key];
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`${label}: missing "${key}"`);
    } else if (placeholders(value) !== placeholders(sourceOf(key))) {
      fail(`${label}: placeholders of "${key}" differ from the source text`);
    }
  }
  for (const key of Object.keys(table)) {
    if (!expected.includes(key)) fail(`${label}: unused key "${key}"`);
  }
}

// --- runtime bundles ---
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.l10n !== './l10n') fail('package.json: "l10n" must be "./l10n"');
for (const lang of LANGS) {
  const file = join(root, 'l10n', `bundle.l10n.${lang}.json`);
  if (!existsSync(file)) {
    fail(`l10n/bundle.l10n.${lang}.json does not exist`);
    continue;
  }
  checkTable(`bundle.l10n.${lang}.json`, [...keys.keys()], JSON.parse(readFileSync(file, 'utf8')));
}

// --- package.nls ---
const used = new Set();
(function scan(node) {
  if (typeof node === 'string') {
    for (const m of node.matchAll(/^%([^%]+)%$/g)) used.add(m[1]);
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach(scan);
  }
})(pkg);
const nlsKeys = [...used];
const nlsEn = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8'));
checkTable('package.nls.json', nlsKeys, nlsEn);
for (const lang of LANGS) {
  const file = join(root, `package.nls.${lang}.json`);
  if (!existsSync(file)) {
    fail(`package.nls.${lang}.json does not exist`);
    continue;
  }
  checkTable(`package.nls.${lang}.json`, nlsKeys, JSON.parse(readFileSync(file, 'utf8')), (k) => nlsEn[k] ?? '');
}

// --- callback page strings ---
const pages = JSON.parse(readFileSync(join(root, 'src', 'pageStrings.json'), 'utf8'));
for (const lang of ALL_LANGS) {
  if (!pages[lang]) fail(`pageStrings.json: language "${lang}" missing`);
  else checkTable(`pageStrings.json[${lang}]`, Object.keys(pages.en), pages[lang], (k) => pages.en[k]);
}
for (const lang of Object.keys(pages)) {
  if (!ALL_LANGS.includes(lang)) fail(`pageStrings.json: unexpected language "${lang}"`);
}

if (errors.length) {
  console.error(`l10n check FAILED (${errors.length}):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `l10n check OK: ${keys.size} runtime strings x ${LANGS.length} bundles, ${nlsKeys.length} manifest strings x ${ALL_LANGS.length} files, ${Object.keys(pages.en).length} page strings x ${ALL_LANGS.length}`,
);
