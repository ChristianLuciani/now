import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { compareItems, isSortedTotal } from '../scripts/lib/snapshot.mjs';
import { isDate, isDateTime } from '../scripts/lib/schema.mjs';
import { parseSources, validateSources } from '../scripts/lib/sources.mjs';
import { renderMarkdown } from '../scripts/lib/render.mjs';
import { runFetch } from '../scripts/fetch.mjs';
import {
  CHECK,
  FETCH,
  FIXTURES,
  PRS,
  RELEASES,
  RENDER,
  githubHandler,
  runNode,
  stubServer,
  tmpRepo,
  writeFixture,
} from './helpers.mjs';

const ENV = (server) => ({ GITHUB_API_URL: server.url, GITHUB_TOKEN: 'test-token-not-real' });

test('fetch: same sources + same asOf produce byte-identical now.json', async (t) => {
  const root = await tmpRepo(t);
  const fakeFetch = async (url, init) => {
    const { query } = JSON.parse(init.body);
    const data = query.includes('repositories(') ? RELEASES : PRS;
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const options = {
    root,
    env: { GITHUB_TOKEN: 'fake' },
    asOf: '2026-11-05T18:00:00Z',
    fetchImpl: fakeFetch,
  };

  await runFetch(options);
  const first = await fs.readFile(path.join(root, 'now.json'), 'utf8');
  await runFetch(options);
  const second = await fs.readFile(path.join(root, 'now.json'), 'utf8');

  assert.equal(second, first, 'same input + same asOf -> same bytes');
  assert.match(first, /"asOf": "2026-11-05T18:00:00Z"/);
});

test('fetch: builds a sorted snapshot cut at 5 from a stub GraphQL API', async (t) => {
  const server = await stubServer(githubHandler());
  t.after(() => server.close());
  const root = await tmpRepo(t);

  const result = await runNode(FETCH, { cwd: root, env: ENV(server) });
  assert.equal(result.code, 0, result.stderr);

  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'now.json'), 'utf8'));
  assert.equal(snapshot.schema, 'now/v1');
  assert.match(snapshot.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(snapshot.items.length, 5, 'cut at 5');
  assert.ok(isSortedTotal(snapshot.items), 'total order');
  assert.ok(snapshot.items.every((item) => item.url.startsWith('https://')));

  assert.deepEqual(
    snapshot.items.map((item) => item.url),
    [
      'https://github.com/ChristianLuciani/gamma/releases/tag/v0.1.0',
      'https://github.com/other/repo/pull/13',
      'https://github.com/other/repo/pull/12',
      'https://github.com/ChristianLuciani/alpha/releases/tag/v1.0.0',
      'https://github.com/ChristianLuciani/beta/releases/tag/v2.0.0',
    ],
    'delta (2026-10-28) is the one dropped by the cut',
  );
});

test('fetch: empty sources are valid and render one _Nothing in flight._ line', async (t) => {
  const server = await stubServer(
    githubHandler({
      releases: { viewer: { repositories: { nodes: [] } } },
      prs: { search: { nodes: [] } },
    }),
  );
  t.after(() => server.close());
  const root = await tmpRepo(t);

  const fetched = await runNode(FETCH, { cwd: root, env: ENV(server) });
  assert.equal(fetched.code, 0, fetched.stderr);

  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'now.json'), 'utf8'));
  assert.deepEqual(snapshot.items, []);

  const rendered = await runNode(RENDER, { cwd: root });
  assert.equal(rendered.code, 0, rendered.stderr);

  const markdown = await fs.readFile(path.join(root, 'now.md'), 'utf8');
  assert.match(markdown, /^<!-- now starts -->\n_Nothing in flight\._\n<!-- now ends -->\n$/);
  assert.ok(
    !markdown.split('\n').some((line) => line.startsWith('- ')),
    'no bullet when empty',
  );

  const checked = await runNode(CHECK, { cwd: root });
  assert.equal(checked.code, 0, checked.stderr);
});

test('fetch: a broken source writes nothing and exits non-zero, naming the source', async (t) => {
  const server = await stubServer(githubHandler({ fail: 'releases' }));
  t.after(() => server.close());
  const root = await tmpRepo(t);

  const sentinel = '{"schema":"now/v1","asOf":"2026-01-01T00:00:00Z","items":[]}\n';
  await fs.writeFile(path.join(root, 'now.json'), sentinel);
  const summaryPath = path.join(root, 'summary.md');
  await fs.writeFile(summaryPath, '');

  const result = await runNode(FETCH, {
    cwd: root,
    env: { ...ENV(server), GITHUB_STEP_SUMMARY: summaryPath },
  });

  assert.notEqual(result.code, 0, 'non-zero exit');
  assert.equal(await fs.readFile(path.join(root, 'now.json'), 'utf8'), sentinel, 'last snapshot untouched');
  assert.match(result.stderr, /releases/);

  const summary = await fs.readFile(summaryPath, 'utf8');
  assert.match(summary, /source: `releases`/);
});

test('fetch: a schema-invalid item writes nothing and exits non-zero', async (t) => {
  const longTag = `v${'x'.repeat(200)}`;
  const server = await stubServer(
    githubHandler({
      releases: {
        viewer: {
          repositories: {
            nodes: [
              {
                nameWithOwner: 'ChristianLuciani/long',
                releases: {
                  nodes: [
                    {
                      tagName: longTag,
                      url: `https://github.com/ChristianLuciani/long/releases/tag/${longTag}`,
                      publishedAt: '2026-11-01T00:00:00Z',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
      prs: { search: { nodes: [] } },
    }),
  );
  t.after(() => server.close());
  const root = await tmpRepo(t);
  const summaryPath = path.join(root, 'summary.md');
  await fs.writeFile(summaryPath, '');

  const result = await runNode(FETCH, {
    cwd: root,
    env: { ...ENV(server), GITHUB_STEP_SUMMARY: summaryPath },
  });

  assert.notEqual(result.code, 0);
  await assert.rejects(fs.readFile(path.join(root, 'now.json')), /ENOENT/);
  assert.match(result.stderr, /at most 120/);
  const summary = await fs.readFile(summaryPath, 'utf8');
  assert.match(summary, /source: github:ChristianLuciani\/long/);
});

test('render: running twice over the same now.json is byte-identical', async (t) => {
  const root = await tmpRepo(t);
  const snapshot = await writeFixture(root, 'valid.json');

  const first = await runNode(RENDER, { cwd: root });
  assert.equal(first.code, 0, first.stderr);
  const firstBytes = await fs.readFile(path.join(root, 'now.md'));

  const second = await runNode(RENDER, { cwd: root });
  assert.equal(second.code, 0, second.stderr);
  const secondBytes = await fs.readFile(path.join(root, 'now.md'));

  assert.deepEqual(secondBytes, firstBytes, 'idempotent bytes');
  assert.equal(firstBytes.toString('utf8'), renderMarkdown(snapshot));
});

test('render: is deterministic for the same input and asOf', async (t) => {
  const root = await tmpRepo(t);
  await writeFixture(root, 'valid.json');
  const original = await fs.readFile(path.join(root, 'now.json'), 'utf8');

  await runNode(RENDER, { cwd: root });
  const first = await fs.readFile(path.join(root, 'now.md'), 'utf8');
  await runNode(RENDER, { cwd: root });
  const second = await fs.readFile(path.join(root, 'now.md'), 'utf8');

  assert.equal(await fs.readFile(path.join(root, 'now.json'), 'utf8'), original);
  assert.equal(second, first);
});

test('check: passes a valid fixture', async (t) => {
  const root = await tmpRepo(t);
  await writeFixture(root, 'valid.json');

  const result = await runNode(CHECK, { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /check: ok/);
});

for (const [fixture, expected] of [
  ['invalid-schema.json', /missing required property "source"/],
  ['invalid-unsorted.json', /not sorted/],
  ['invalid-relative-date.json', /absolute YYYY-MM-DD/],
  ['invalid-non-https.json', /not https:\/\//],
  ['invalid-too-many.json', /at most 5/],
  ['invalid-token.json', /token-shaped GitHub token/],
]) {
  test(`check: fails on ${fixture}`, async (t) => {
    const root = await tmpRepo(t);
    await writeFixture(root, fixture);

    const result = await runNode(CHECK, { cwd: root });
    assert.notEqual(result.code, 0, 'check must fail');
    assert.match(result.stderr, expected);
  });
}

test('check: fails when now.md is not the render of now.json', async (t) => {
  const root = await tmpRepo(t);
  await writeFixture(root, 'valid.json');
  await fs.writeFile(
    path.join(root, 'now.md'),
    '<!-- now starts -->\n- 2026-11-02 · [hand-written](https://example.com/x)\n<!-- now ends -->\n',
  );

  const result = await runNode(CHECK, { cwd: root });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not the byte-identical render/);
});

test('sources parser: accepts the allowlist shape and rejects unknown fields', () => {
  const text = `# comment
sources:
  - id: releases
    kind: github-releases
  - id: upstream
    kind: github-prs
    query: "is:pr is:merged author:ChristianLuciani"
    first: 5
`;
  const doc = validateSources(parseSources(text));
  assert.equal(doc.sources.length, 2);
  assert.equal(doc.sources[1].first, '5');

  assert.throws(
    () =>
      validateSources(
        parseSources(`sources:\n  - id: releases\n    kind: github-releases\n    repos: [a]\n`),
      ),
    /unknown field "repos"/,
  );
  assert.throws(
    () => validateSources(parseSources(`sources:\n  - id: releases\n    kind: rss\n`)),
    /unsupported kind/,
  );
});

test('snapshot order: date desc, then url asc, then deterministic dedupe', () => {
  const items = [
    { kind: 'note', title: 'b', url: 'https://b', date: '2026-01-01', source: 'x' },
    { kind: 'note', title: 'a', url: 'https://a', date: '2026-01-01', source: 'x' },
    { kind: 'note', title: 'old', url: 'https://old', date: '2025-12-31', source: 'x' },
    { kind: 'note', title: 'b duplicate', url: 'https://b', date: '2026-01-01', source: 'x' },
  ];
  const sorted = [...items].sort(compareItems);
  assert.deepEqual(
    sorted.map((item) => item.url),
    ['https://a', 'https://b', 'https://b', 'https://old'],
  );

  const snapshot = (() => {
    const seen = new Set();
    return sorted.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  })();
  assert.equal(snapshot.length, 3, 'duplicate url collapsed');
  assert.ok(isSortedTotal(snapshot));
});

test('schema: date formats are absolute only', () => {
  assert.ok(isDate('2026-02-28'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate('2 hours ago'));
  assert.ok(isDateTime('2026-11-05T18:00:00Z'));
  assert.ok(!isDateTime('2026-11-05T18:00:00+00:00'));
  assert.ok(!isDateTime('2026-13-05T18:00:00Z'));
});

test('fixtures directory is present', async () => {
  const names = await fs.readdir(FIXTURES);
  assert.ok(names.includes('sources.yaml'));
});
