// Minimal, strict parser for the sources allowlist.
//
// `sources.yaml` is a format we own, not general YAML. We support exactly:
//
//   # comment
//   sources:
//     - id: releases
//       kind: github-releases
//
// Scalars may be plain, single-quoted or double-quoted. Anything outside this
// subset (nested maps, flow style, anchors, block scalars, unknown fields) is
// rejected with a line number instead of being silently ignored.

const SOURCE_KINDS = new Set(['github-releases', 'github-prs']);
const COMMON_FIELDS = new Set(['id', 'kind']);
const KIND_FIELDS = {
  'github-releases': new Set(['owner']),
  'github-prs': new Set(['query', 'first']),
};

export class SourcesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourcesError';
  }
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return '';
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (!value.endsWith(quote) || value.length < 2) {
      throw new SourcesError(`unterminated ${quote === '"' ? 'double' : 'single'}-quoted scalar`);
    }
    const body = value.slice(1, -1);
    if (quote === '"') {
      try {
        return JSON.parse(value);
      } catch {
        throw new SourcesError('invalid double-quoted scalar');
      }
    }
    return body.replace(/''/g, "'");
  }
  return value;
}

const KEY_VALUE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

function assign(target, text, lineNo) {
  const match = KEY_VALUE.exec(text);
  if (!match) {
    throw new SourcesError(`sources.yaml:${lineNo}: expected "key: value", got ${JSON.stringify(text)}`);
  }
  const [, key, rawValue] = match;
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new SourcesError(`sources.yaml:${lineNo}: duplicate field "${key}"`);
  }
  try {
    target[key] = parseScalar(rawValue ?? '');
  } catch (error) {
    throw new SourcesError(`sources.yaml:${lineNo}: ${error.message}`);
  }
}

export function parseSources(text) {
  const doc = { sources: [] };
  let inSources = false;
  let current = null;
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const withoutComment = stripComment(lines[index]);
    if (withoutComment.trim() === '') continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const content = withoutComment.trim();

    if (indent === 0) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*):$/.exec(content);
      if (!match) {
        throw new SourcesError(
          `sources.yaml:${lineNo}: expected a top-level mapping key ("sources:")`,
        );
      }
      if (match[1] !== 'sources') {
        throw new SourcesError(`sources.yaml:${lineNo}: unknown top-level key "${match[1]}"`);
      }
      if (inSources) {
        throw new SourcesError(`sources.yaml:${lineNo}: duplicate "sources:" section`);
      }
      inSources = true;
      current = null;
      continue;
    }

    if (!inSources) {
      throw new SourcesError(`sources.yaml:${lineNo}: content outside the "sources:" section`);
    }

    if (indent === 2 && content.startsWith('- ')) {
      current = {};
      doc.sources.push(current);
      const rest = content.slice(2).trim();
      if (rest === '') {
        throw new SourcesError(`sources.yaml:${lineNo}: empty sequence item`);
      }
      assign(current, rest, lineNo);
      continue;
    }

    if (indent === 4 && current) {
      assign(current, content, lineNo);
      continue;
    }

    throw new SourcesError(
      `sources.yaml:${lineNo}: unsupported indentation (expected 2 for "- id:" and 4 for fields)`,
    );
  }

  if (!inSources) {
    throw new SourcesError('sources.yaml: missing the required "sources:" section');
  }

  return doc;
}

export function validateSources(doc) {
  if (!doc || !Array.isArray(doc.sources)) {
    throw new SourcesError('sources.yaml: "sources" must be a sequence');
  }

  const seen = new Set();
  doc.sources.forEach((source, index) => {
    const where = `sources[${index}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new SourcesError(`${where}: expected a mapping`);
    }

    if (typeof source.kind !== 'string') {
      throw new SourcesError(`${where}: missing required field "kind"`);
    }
    if (!SOURCE_KINDS.has(source.kind)) {
      throw new SourcesError(
        `${where}: unsupported kind ${JSON.stringify(source.kind)} (expected one of ${[...SOURCE_KINDS].join(', ')})`,
      );
    }

    const allowed = new Set([...COMMON_FIELDS, ...KIND_FIELDS[source.kind]]);
    for (const field of Object.keys(source)) {
      if (!allowed.has(field)) {
        throw new SourcesError(`${where}: unknown field "${field}" for kind ${source.kind}`);
      }
    }

    if (typeof source.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(source.id)) {
      throw new SourcesError(`${where}: "id" must be lowercase kebab-case (a-z, 0-9, -)`);
    }
    if (seen.has(source.id)) {
      throw new SourcesError(`${where}: duplicate source id "${source.id}"`);
    }
    seen.add(source.id);

    if (source.kind === 'github-releases') {
      if (source.owner !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(source.owner)) {
        throw new SourcesError(`${where}: "owner" must be a GitHub login`);
      }
    }

    if (source.kind === 'github-prs') {
      if (typeof source.query !== 'string' || source.query.trim() === '') {
        throw new SourcesError(`${where}: "query" is required for github-prs`);
      }
      if (source.first !== undefined) {
        const first = Number(source.first);
        if (!Number.isInteger(first) || first < 1 || first > 100) {
          throw new SourcesError(`${where}: "first" must be an integer between 1 and 100`);
        }
      }
    }
  });

  return doc;
}

export function loadSources(text) {
  const doc = parseSources(text);
  return validateSources(doc);
}
