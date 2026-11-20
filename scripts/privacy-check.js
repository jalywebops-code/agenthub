#!/usr/bin/env node
// npm run privacy-check [-- --all]
// Looks through the files git tracks (with --all, also new files git doesn't ignore) for things that shouldn't be
// published: email addresses, real home folders (/Users/<name>, /home/<name>; "you" is the neutral example) and
// Tailscale machine names, plus your own patterns from private/privacy-patterns.txt (one regular expression per line,
// # for comments; that file is never committed, since the names in it are the private part). Text you publish on
// purpose (your repository's address, the name in the LICENSE) goes in private/privacy-allow.txt, one exact string per
// line: it is taken out of each line before the check, so the rest of the line is still checked.
// Prints every match and exits with 1 when there is one, so it can gate a release.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const files = [...git('ls-files'), ...(process.argv.includes('--all') ? git('ls-files', '--others', '--exclude-standard') : [])];

const GENERIC = [
  ['email address', /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|anthropic\.com\b|users\.noreply\.github\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['home folder', /\/(?:Users|home)\/(?!you\b|runner\b|<you>)[A-Za-z][\w.-]*/],
  ['Tailscale machine name', /\b[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b/i],
];
const own = [];
const patternFile = path.join(ROOT, 'private', 'privacy-patterns.txt');
if (fs.existsSync(patternFile)) {
  for (const line of fs.readFileSync(patternFile, 'utf8').split('\n')) {
    const p = line.trim();
    if (p && !p.startsWith('#')) own.push(['your pattern', new RegExp(p, 'i')]);
  }
} else {
  console.log('No private/privacy-patterns.txt: checking the generic patterns only (add your own names there).');
}

const allowed = [];
const allowFile = path.join(ROOT, 'private', 'privacy-allow.txt');
if (fs.existsSync(allowFile)) {
  for (const line of fs.readFileSync(allowFile, 'utf8').split('\n')) {
    const a = line.trim();
    if (a && !a.startsWith('#')) allowed.push(a);
  }
}
const withoutAllowed = (line) => allowed.reduce((l, a) => l.split(a).join(' '), line);

let found = 0;
for (const file of files) {
  const full = path.join(ROOT, file);
  let text;
  try { text = fs.readFileSync(full); } catch { continue; } // deleted but not yet committed
  if (text.includes(0)) continue; // binary (fonts, images)
  text.toString('utf8').split('\n').forEach((line, i) => {
    const checked = withoutAllowed(line);
    for (const [what, re] of [...GENERIC, ...own]) {
      const m = re.exec(checked);
      if (!m) continue;
      found++;
      console.log(`${file}:${i + 1}  ${what}: ${m[0]}`);
      break;
    }
  });
}
console.log(found ? `\n${found} line${found === 1 ? '' : 's'} to clean up before publishing.` : `Clean: ${files.length} files checked.`);
process.exit(found ? 1 : 0);
