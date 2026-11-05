// `npm run changed`: does this run produce something worth committing?
//
// `now.json` always differs byte-wise between runs because `asOf` is the run
// instant, so the criterion is the content:
//   - the item list differs from HEAD, or
//   - the current renderer emits different markdown than HEAD:now.md (a
//     renderer change with identical items must still be committed, or the
//     committed block stays stale).
//
// Exit codes: 0 = change (commit), 1 = no change (skip), 2 = error
// (missing/invalid now.json).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/cli.mjs';
import { renderMarkdown } from './lib/render.mjs';

const FIELDS = ['kind', 'title', 'url', 'date', 'source'];

function canonical(items) {
  return JSON.stringify(
    (Array.isArray(items) ? items : []).map((item) =>
      FIELDS.map((field) => item?.[field] ?? null),
    ),
  );
}

function readHead(exec, root, file) {
  try {
    return exec('git', ['show', `HEAD:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function hasChange({ root = process.cwd(), exec = execFileSync } = {}) {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'now.json'), 'utf8'));

  const headJsonText = readHead(exec, root, 'now.json');
  if (headJsonText === null) {
    return { changed: true, reason: 'no now.json in HEAD' };
  }

  let head;
  try {
    head = JSON.parse(headJsonText);
  } catch {
    return { changed: true, reason: 'HEAD:now.json is not valid JSON' };
  }

  if (canonical(current.items) !== canonical(head.items)) {
    return { changed: true, reason: 'items differ from HEAD' };
  }

  const headMarkdown = readHead(exec, root, 'now.md');
  if (headMarkdown === null) {
    return { changed: true, reason: 'no now.md in HEAD' };
  }

  if (renderMarkdown(current) !== headMarkdown) {
    return { changed: true, reason: 'now.md render differs from HEAD' };
  }

  return { changed: false, reason: 'items and now.md identical to HEAD' };
}

if (isMain(import.meta.url)) {
  try {
    const result = hasChange();
    console.log(`changed: ${result.changed ? 'yes' : 'no'} (${result.reason})`);
    process.exitCode = result.changed ? 0 : 1;
  } catch (error) {
    console.error(`changed failed: ${error.message}`);
    process.exitCode = 2;
  }
}
