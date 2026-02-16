import fs from 'node:fs';
import path from 'node:path';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  const txt = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(p, txt, 'utf8');
}

function collectNlsKeysFromPackageJson(pkg) {
  const json = JSON.stringify(pkg);
  const re = /%([^%]+)%/g;
  /** @type {Set<string>} */
  const keys = new Set();
  for (let m; (m = re.exec(json)); ) keys.add(m[1]);
  return [...keys].sort();
}

const repoRoot = process.cwd();
const pkgPath = path.join(repoRoot, 'package.json');
const localesDir = path.join(repoRoot, 'src', 'i18n', 'locales');

const pkg = readJson(pkgPath);
const keys = collectNlsKeysFromPackageJson(pkg);

const enLocalePath = path.join(localesDir, 'en.json');
const en = readJson(enLocalePath);

/** @type {Array<{ locale: string, inFile: string, outFile: string }>} */
const targets = [
  { locale: 'en', inFile: 'en.json', outFile: 'package.nls.json' },
  { locale: 'ja', inFile: 'ja.json', outFile: 'package.nls.ja.json' },
  { locale: 'ko', inFile: 'ko.json', outFile: 'package.nls.ko.json' },
  { locale: 'vi', inFile: 'vi.json', outFile: 'package.nls.vi.json' },
  { locale: 'zh-cn', inFile: 'zh-cn.json', outFile: 'package.nls.zh-cn.json' },
  { locale: 'zh-tw', inFile: 'zh-tw.json', outFile: 'package.nls.zh-tw.json' },
];

for (const t of targets) {
  const localePath = path.join(localesDir, t.inFile);
  const dict = readJson(localePath);

  /** @type {Record<string, string>} */
  const out = {};
  for (const k of keys) {
    const v = dict[k] ?? en[k];
    if (typeof v !== 'string') {
      throw new Error(`Missing translation key '${k}' in ${t.inFile} (and en fallback).`);
    }
    out[k] = v;
  }

  writeJson(path.join(repoRoot, t.outFile), out);
}
