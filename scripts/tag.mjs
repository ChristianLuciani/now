// `npm run tag`: which immutable tag the next snapshot commit gets.
//
// README §3 and AGENTS.md §1: every committed snapshot is tagged, and every
// consumer pins that tag plus a digest. The workflow used to cut `v1.0.0` once
// and stop, so it kept committing snapshots while both consumers stayed frozen
// on the last tag a human had cut by hand (measured 2026-11-08: producer at
// `asOf` 2026-11-08, site and profile README still serving `v1.0.1` from
// 2026-11-05).
//
// This module owns only the arithmetic: the highest existing `vX.Y.Z` plus one
// patch, so after `v1.0.1` comes `v1.0.2` and a hand-cut minor (`v1.1.0`) opens
// the next line instead of fighting it. It never moves a tag: the workflow
// creates the returned tag and an existing one is left immutable.

import { execFileSync } from 'node:child_process';
import { isMain } from './lib/cli.mjs';


/** Stable, immutable release tag. Pre-releases and `v1`/`latest` are not pins. */
export const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Numeric, not lexical: after `v1.0.9` comes `v1.0.10`, never `v1.0.9`+1 string-wise. */
function compareTuples(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function parseTag(tag) {
  const match = TAG_PATTERN.exec(String(tag).trim());
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

/**
 * The next tag over a list of existing tags. Total and deterministic:
 * same tags → same answer, order-independent.
 */
export function nextTag(tags = []) {
  let highest = null;
  for (const tag of Array.isArray(tags) ? tags : []) {
    const tuple = parseTag(tag);
    if (!tuple) continue;
    if (highest === null || compareTuples(tuple, highest) > 0) highest = tuple;
  }
  if (highest === null) return 'v1.0.0';
  return `v${highest[0]}.${highest[1]}.${highest[2] + 1}`;
}

/** Existing tags in the repo, read-only. `exec` is injectable for the tests. */
export function readTags({ root = process.cwd(), exec = execFileSync } = {}) {
  const out = exec('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' });
  return String(out)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${nextTag(readTags())}\n`);
}
