// `npm run fetch`: sources.yaml -> GraphQL -> now.json.
//
// Sequential and bounded: each source runs one pass, and the releases source
// walks a capped number of cursor pages (never an unbounded crawl). A fetch
// failure or a schema failure writes nothing: the last tagged snapshot keeps
// serving.

import fs from 'node:fs';
import path from 'node:path';
import { loadSources } from './lib/sources.mjs';
import { fetchSource, resolveApiUrl } from './lib/github.mjs';
import { buildSnapshot, formatAsOf, serializeSnapshot } from './lib/snapshot.mjs';
import { validate } from './lib/schema.mjs';
import { appendSummary, isMain, readSchema } from './lib/cli.mjs';

export class FetchError extends Error {
  constructor(message, { sourceId, errors = [], snapshot } = {}) {
    super(message);
    this.name = 'FetchError';
    this.sourceId = sourceId;
    this.errors = errors;
    this.snapshot = snapshot;
  }
}

export async function runFetch({
  root = process.cwd(),
  env = process.env,
  asOf = formatAsOf(),
  fetchImpl,
} = {}) {
  const sourcesPath = path.join(root, 'sources.yaml');
  let sourcesText;
  try {
    sourcesText = fs.readFileSync(sourcesPath, 'utf8');
  } catch (error) {
    throw new FetchError(`cannot read sources.yaml: ${error.message}`);
  }

  let doc;
  try {
    doc = loadSources(sourcesText);
  } catch (error) {
    throw new FetchError(`invalid sources.yaml: ${error.message}`);
  }

  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new FetchError('GITHUB_TOKEN is not set (only the workflow holds it)');
  }

  const context = { apiUrl: resolveApiUrl(env), token, fetchImpl, env };
  const collected = [];
  for (const source of doc.sources) {
    try {
      const items = await fetchSource(source, context);
      collected.push(...items);
    } catch (error) {
      throw new FetchError(`source "${source.id}" failed: ${error.message}`, {
        sourceId: source.id,
      });
    }
  }

  const snapshot = buildSnapshot({ items: collected, asOf });
  const errors = validate(snapshot, readSchema(root));
  if (errors.length > 0) {
    // Name the source behind each failing item so the summary is actionable.
    const attributed = errors.map((message) => {
      const match = /^\$\.items\[(\d+)\]/.exec(message);
      const source = match ? snapshot.items[Number(match[1])]?.source : undefined;
      return source ? `${message} (source: ${source})` : message;
    });
    throw new FetchError('snapshot does not validate against schema/now.schema.json', {
      errors: attributed,
      snapshot,
    });
  }

  // Nothing has touched the filesystem until here.
  fs.writeFileSync(path.join(root, 'now.json'), serializeSnapshot(snapshot));
  return snapshot;
}

function reportFailure(error) {
  const lines = [];
  if (error.sourceId) lines.push(`- source: \`${error.sourceId}\``);
  for (const message of error.errors ?? []) lines.push(`- ${message}`);
  lines.push(`- error: ${error.message}`);
  lines.push('');
  lines.push('Nothing was written. The last tagged snapshot keeps serving.');
  appendSummary(`## now fetch failed\n\n${lines.join('\n')}\n`);

  console.error(`fetch failed: ${error.message}`);
  if (error.sourceId) console.error(`  source: ${error.sourceId}`);
  for (const message of error.errors ?? []) console.error(`  - ${message}`);
  console.error('nothing was written; the last tagged snapshot keeps serving');
}

if (isMain(import.meta.url)) {
  try {
    const snapshot = await runFetch();
    console.log(
      `fetch: wrote now.json (${snapshot.items.length} item(s), asOf ${snapshot.asOf})`,
    );
  } catch (error) {
    reportFailure(error);
    process.exitCode = 1;
  }
}
