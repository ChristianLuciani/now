// `npm run changed`: does the item list differ from the one committed in HEAD?
//
// `now.json` always differs byte-wise between runs because `asOf` is the run
// instant. The workflow's commit criterion is therefore the item list, not the
// file bytes: a run that only advances `asOf` is not a change worth a commit.
//
// Exit codes: 0 = items changed (commit), 1 = items identical (no commit),
// 2 = error (missing/invalid now.json).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/cli.mjs';

const FIELDS = ['kind', 'title', 'url', 'date', 'source'];

function canonical(items) {
  return JSON.stringify(
    (Array.isArray(items) ? items : []).map((item) =>
      FIELDS.map((field) => item?.[field] ?? null),
    ),
  );
}

export function hasItemChange({ root = process.cwd(), exec = execFileSync } = {}) {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'now.json'), 'utf8'));

  let headText;
  try {
    headText = exec('git', ['show', 'HEAD:now.json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { changed: true, reason: 'no now.json in HEAD' };
  }

  let head;
  try {
    head = JSON.parse(headText);
  } catch {
    return { changed: true, reason: 'HEAD:now.json is not valid JSON' };
  }

  const changed = canonical(current.items) !== canonical(head.items);
  return {
    changed,
    reason: changed ? 'items differ from HEAD' : 'items identical to HEAD',
  };
}

if (isMain(import.meta.url)) {
  try {
    const result = hasItemChange();
    console.log(`changed: ${result.changed ? 'yes' : 'no'} (${result.reason})`);
    process.exitCode = result.changed ? 0 : 1;
  } catch (error) {
    console.error(`changed failed: ${error.message}`);
    process.exitCode = 2;
  }
}
