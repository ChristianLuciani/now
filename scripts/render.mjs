// `npm run render`: now.json -> now.md. Pure function of the file on disk:
// running it twice produces identical bytes.

import fs from 'node:fs';
import path from 'node:path';
import { validate } from './lib/schema.mjs';
import { renderMarkdown } from './lib/render.mjs';
import { isMain, readSchema } from './lib/cli.mjs';

export class RenderError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'RenderError';
    this.errors = errors;
  }
}

export function runRender({ root = process.cwd() } = {}) {
  const jsonPath = path.join(root, 'now.json');
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    throw new RenderError(`cannot read now.json: ${error.message}`);
  }

  const errors = validate(snapshot, readSchema(root));
  if (errors.length > 0) {
    throw new RenderError('now.json does not validate against schema/now.schema.json', errors);
  }

  const markdown = renderMarkdown(snapshot);
  fs.writeFileSync(path.join(root, 'now.md'), markdown);
  return markdown;
}

if (isMain(import.meta.url)) {
  try {
    const markdown = runRender();
    const bullets = markdown.split('\n').filter((line) => line.startsWith('- ')).length;
    console.log(`render: wrote now.md (${bullets} bullet(s))`);
  } catch (error) {
    console.error(`render failed: ${error.message}`);
    for (const message of error.errors ?? []) console.error(`  - ${message}`);
    process.exitCode = 1;
  }
}
