// Shared CLI helpers: repo root, schema loading and the failure summary.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readSchema(root = process.cwd()) {
  const schemaPath = path.join(root, 'schema', 'now.schema.json');
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

// The workflow names the failing source in the job summary. We append there
// when GitHub provides the path; locally this is a no-op.
export function appendSummary(markdown, env = process.env) {
  const target = env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  } catch {
    // A summary failure must never mask the real failure.
  }
}

export function isMain(metaUrl, argv = process.argv) {
  if (!argv[1]) return false;
  return path.resolve(argv[1]) === fileURLToPath(metaUrl);
}
