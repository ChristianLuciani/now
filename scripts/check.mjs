// `npm run check`: the gate. Fails on
//   - a schema violation (including a relative date and a non-https URL),
//   - items out of total order,
//   - more than five items,
//   - a token-shaped string in now.json or now.md,
//   - a now.md that is not the byte-identical render of now.json.

import fs from 'node:fs';
import path from 'node:path';
import { isDate, validate } from './lib/schema.mjs';
import { MAX_ITEMS, isSortedTotal } from './lib/snapshot.mjs';
import { renderMarkdown } from './lib/render.mjs';
import { isMain, readSchema } from './lib/cli.mjs';

const TOKEN_PATTERNS = [
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'fine-grained GitHub token', pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'AWS access key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { name: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
];

export function findTokenShaped(text) {
  const found = [];
  for (const { name, pattern } of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

export function runCheck({ root = process.cwd() } = {}) {
  const problems = [];
  const jsonPath = path.join(root, 'now.json');
  const mdPath = path.join(root, 'now.md');

  let jsonText;
  try {
    jsonText = fs.readFileSync(jsonPath, 'utf8');
  } catch {
    return ['now.json: missing or unreadable'];
  }

  let snapshot;
  try {
    snapshot = JSON.parse(jsonText);
  } catch (error) {
    return [`now.json: invalid JSON (${error.message})`];
  }

  const errors = validate(snapshot, readSchema(root));
  problems.push(...errors.map((entry) => `schema: ${entry}`));

  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  if (items.length > MAX_ITEMS) {
    problems.push(`order: ${items.length} items (max ${MAX_ITEMS})`);
  }
  if (Array.isArray(snapshot?.items) && !isSortedTotal(snapshot.items)) {
    problems.push('order: items are not sorted by date desc, then url asc');
  }
  items.forEach((item, index) => {
    if (typeof item?.url === 'string' && !item.url.startsWith('https://')) {
      problems.push(`url: items[${index}].url is not https://`);
    }
    if (typeof item?.date === 'string' && !isDate(item.date)) {
      problems.push(
        `date: items[${index}].date is not absolute YYYY-MM-DD (relative dates are not allowed)`,
      );
    }
  });

  for (const name of findTokenShaped(jsonText)) {
    problems.push(`secret: token-shaped ${name} in now.json`);
  }

  let markdown;
  try {
    markdown = fs.readFileSync(mdPath, 'utf8');
  } catch {
    problems.push('now.md: missing or unreadable');
  }

  if (markdown !== undefined) {
    for (const name of findTokenShaped(markdown)) {
      problems.push(`secret: token-shaped ${name} in now.md`);
    }
    if (Array.isArray(snapshot?.items) && markdown !== renderMarkdown(snapshot)) {
      problems.push('now.md: not the byte-identical render of now.json (stale or hand-edited)');
    }
  }

  return problems;
}

if (isMain(import.meta.url)) {
  const problems = runCheck();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('check: ok (schema, order, urls, dates, no token-shaped strings, render is current)');
  }
}
