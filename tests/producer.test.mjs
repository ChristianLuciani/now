import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { compareItems, isSortedTotal } from '../scripts/lib/snapshot.mjs';
import { isDate, isDateTime } from '../scripts/lib/schema.mjs';
import { loadSources, parseSources, validateSources } from '../scripts/lib/sources.mjs';
import { renderMarkdown } from '../scripts/lib/render.mjs';
import { runFetch } from '../scripts/fetch.mjs';
import {
  CHANGED,
  CHECK,
  FETCH,
  FIXTURES,
  PRS,
  RELEASES,
  RELEASES_MULTI,
  REPO_ROOT,
  RENDER,
  githubHandler,
  makeReleaseNodes,
  releasesPage,
  runNode,
  stubServer,
  tmpRepo,
  writeFixture,
} from './helpers.mjs';

const ENV = (server) => ({ GITHUB_API_URL: server.url, GITHUB_TOKEN: 'test-token-not-real' });

const SOURCES_WITHOUT_OWNER = `sources:
  - id: releases
    kind: github-releases
  - id: upstream
    kind: github-prs
    query: "is:pr is:merged author:ChristianLuciani"
    first: 5
`;

function recordingGithub(options) {
  const requests = [];
  const handler = githubHandler(options);
  return {
    requests,
    handler: (payload) => {
      requests.push(payload);
      return handler(payload);
    },
  };
}

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
  const { requests, handler } = recordingGithub();
  const server = await stubServer(handler);
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

  // F1: the installation token's `viewer` is github-actions[bot]; the query
  // must name the owner. The stub models that `viewer` owns no repos, so a
  // regression here would also empty the snapshot.
  const releasesRequest = requests.find((payload) =>
    String(payload.query).includes('repositories('),
  );
  assert.ok(releasesRequest, 'a releases request was made');
  assert.ok(!String(releasesRequest.query).includes('viewer'), 'must not query viewer');
  assert.match(String(releasesRequest.query), /user\(login: \$owner\)/);
  assert.equal(releasesRequest.variables.owner, 'ChristianLuciani');
});

test('fetch: resolves the owner from GITHUB_REPOSITORY_OWNER when sources.yaml omits it', async (t) => {
  const { requests, handler } = recordingGithub();
  const server = await stubServer(handler);
  t.after(() => server.close());
  const root = await tmpRepo(t, SOURCES_WITHOUT_OWNER);

  const result = await runNode(FETCH, {
    cwd: root,
    env: { ...ENV(server), GITHUB_REPOSITORY_OWNER: 'ChristianLuciani' },
  });
  assert.equal(result.code, 0, result.stderr);

  const releasesRequest = requests.find((payload) =>
    String(payload.query).includes('repositories('),
  );
  assert.equal(releasesRequest.variables.owner, 'ChristianLuciani');
});

test('fetch: fails when neither sources.yaml nor the env names an owner', async (t) => {
  const server = await stubServer(githubHandler());
  t.after(() => server.close());
  const root = await tmpRepo(t, SOURCES_WITHOUT_OWNER);

  const result = await runNode(FETCH, {
    cwd: root,
    env: { ...ENV(server), GITHUB_REPOSITORY_OWNER: '' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /owner is not set/);
  assert.match(result.stderr, /"releases"/);
});

test('fetch: follows endCursor for a second page', async (t) => {
  const page1 = releasesPage(makeReleaseNodes(100, { prefix: 'page1', date: '2026-11-01' }), {
    hasNextPage: true,
    endCursor: 'cursor-1',
  });
  const page2 = releasesPage(makeReleaseNodes(10, { prefix: 'page2', date: '2026-11-02' }), {
    hasNextPage: false,
    endCursor: null,
  });
  const { requests, handler } = recordingGithub({ releasesPages: [page1, page2] });
  const server = await stubServer(handler);
  t.after(() => server.close());
  const root = await tmpRepo(t);

  const result = await runNode(FETCH, { cwd: root, env: ENV(server) });
  assert.equal(result.code, 0, result.stderr);

  const releasesRequests = requests.filter((payload) =>
    String(payload.query).includes('repositories('),
  );
  assert.equal(releasesRequests.length, 2, 'two pages');
  assert.equal(releasesRequests[0].variables.after, null);
  assert.equal(releasesRequests[1].variables.after, 'cursor-1');

  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'now.json'), 'utf8'));
  assert.equal(snapshot.items.length, 5);
});

test('fetch: stops at the bounded page cap (5 pages)', async (t) => {
  const pages = Array.from({ length: 5 }, (_, index) =>
    releasesPage(makeReleaseNodes(100, { prefix: `p${index}`, date: '2026-11-01' }), {
      hasNextPage: true,
      endCursor: `cursor-${index}`,
    }),
  );
  const { requests, handler } = recordingGithub({ releasesPages: pages });
  const server = await stubServer(handler);
  t.after(() => server.close());
  const root = await tmpRepo(t);

  const result = await runNode(FETCH, { cwd: root, env: ENV(server) });
  assert.equal(result.code, 0, result.stderr);

  const releasesRequests = requests.filter((payload) =>
    String(payload.query).includes('repositories('),
  );
  assert.equal(releasesRequests.length, 5, 'never requests a sixth page');
});

test('fetch: fails when the named user is not returned instead of writing an empty snapshot', async (t) => {
  const server = await stubServer(() => ({
    status: 200,
    body: { data: { user: null } },
  }));
  t.after(() => server.close());
  const root = await tmpRepo(t);

  const result = await runNode(FETCH, { cwd: root, env: ENV(server) });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /was not returned/);
  await assert.rejects(fs.readFile(path.join(root, 'now.json')), /ENOENT/);
});

test('fetch: empty sources are valid and render one _Nothing in flight._ line', async (t) => {
  const server = await stubServer(
    githubHandler({
      releases: {
        user: {
          repositories: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
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
        user: {
          repositories: {
            pageInfo: { hasNextPage: false, endCursor: null },
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

test('render: wraps a URL that would break a markdown link', () => {
  const render = (url) =>
    renderMarkdown({
      items: [{ kind: 'note', title: 'odd', url, date: '2026-01-01', source: 'x' }],
    });

  assert.match(render('https://example.com/a)b'), /\[odd\]\(<https:\/\/example\.com\/a\)b>\)/);
  assert.match(render('https://example.com/a b'), /\[odd\]\(<https:\/\/example\.com\/a b>\)/);
  assert.match(render('https://example.com/a'), /\[odd\]\(https:\/\/example\.com\/a\)/);
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
  ['invalid-token-npm.json', /token-shaped npm token/],
  ['invalid-token-gitlab.json', /token-shaped GitLab token/],
  ['invalid-token-openai.json', /token-shaped OpenAI key/],
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

test('check: detects a token that appears only in now.md', async (t) => {
  const root = await tmpRepo(t);
  await writeFixture(root, 'valid.json');
  const markdown = await fs.readFile(path.join(root, 'now.md'), 'utf8');
  await fs.writeFile(path.join(root, 'now.md'), `${markdown}\nghp_${'B'.repeat(36)}\n`);

  const result = await runNode(CHECK, { cwd: root });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /token-shaped GitHub token in now\.md/);
});

function git(root, args) {
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args],
    { cwd: root, stdio: 'ignore' },
  );
}

async function committedFixture(t) {
  const root = await tmpRepo(t);
  await writeFixture(root, 'valid.json');
  git(root, ['init', '-q']);
  git(root, ['add', 'now.json', 'now.md']);
  git(root, ['commit', '-qm', 'seed']);
  return root;
}

test('changed: exits 1 when only asOf differs from HEAD', async (t) => {
  const root = await committedFixture(t);
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'now.json'), 'utf8'));
  snapshot.asOf = '2026-11-06T09:00:00Z';
  await fs.writeFile(path.join(root, 'now.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

  const result = await runNode(CHANGED, { cwd: root });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /items and now\.md identical to HEAD/);
});

test('changed: exits 0 when the item list differs from HEAD', async (t) => {
  const root = await committedFixture(t);
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'now.json'), 'utf8'));
  snapshot.items[0].title = 'changed title';
  await fs.writeFile(path.join(root, 'now.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

  const result = await runNode(CHANGED, { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /items differ from HEAD/);
});

test('changed: exits 0 when items are identical but now.md renders differently', async (t) => {
  const root = await committedFixture(t);

  // Simulate a renderer change: HEAD carries the old markdown, the working
  // now.json keeps the same items.
  await fs.writeFile(
    path.join(root, 'now.md'),
    '<!-- now starts -->\n- old renderer output\n<!-- now ends -->\n',
  );
  git(root, ['add', 'now.md']);
  git(root, ['commit', '-qm', 'old renderer']);

  const result = await runNode(CHANGED, { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /now\.md render differs from HEAD/);
});

test('changed: exits 0 when HEAD has no now.json yet', async (t) => {
  const root = await tmpRepo(t);
  await writeFixture(root, 'valid.json');

  const result = await runNode(CHANGED, { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no now\.json in HEAD/);
});

test('sources parser: accepts the allowlist shape and rejects unknown fields', () => {
  const text = `# comment
sources:
  - id: releases
    kind: github-releases
    owner: ChristianLuciani
  - id: upstream
    kind: github-prs
    query: "is:pr is:merged author:ChristianLuciani"
    first: 5
`;
  const doc = validateSources(parseSources(text));
  assert.equal(doc.sources.length, 2);
  assert.equal(doc.sources[0].owner, 'ChristianLuciani');
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

// The first real run published v0.2.0 (2026-10-09) while v0.4.0 (2026-11-04)
// was out: `releases(last: 1)` takes the TAIL of a newest-first connection.
// The stub models that ordering, so flipping `first` back to `last` fails here.
test('fetch: each repo contributes its NEWEST release, not the oldest', async (t) => {
  const { requests, handler } = recordingGithub({ releases: RELEASES_MULTI });
  const server = await stubServer(handler);
  t.after(() => server.close());
  const root = await tmpRepo(t);

  const result = await runNode(FETCH, { cwd: root, env: ENV(server) });
  assert.equal(result.code, 0, result.stderr);

  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'now.json'), 'utf8'));
  const urls = snapshot.items.map((item) => item.url);
  assert.ok(
    urls.includes('https://github.com/ChristianLuciani/alpha/releases/tag/v3.0.0'),
    `expected alpha's newest release, got ${JSON.stringify(urls)}`,
  );
  assert.ok(
    urls.includes('https://github.com/ChristianLuciani/beta/releases/tag/v3.1.0'),
    `expected beta's newest release, got ${JSON.stringify(urls)}`,
  );
  assert.ok(!urls.some((url) => url.endsWith('/v1.0.0')), 'the oldest release must not win');

  const releasesRequest = requests.find((payload) =>
    String(payload.query).includes('repositories('),
  );
  assert.match(String(releasesRequest.query), /releases\(first: 1\)/);
  assert.ok(!String(releasesRequest.query).includes('releases(last:'), 'must not take the tail');
});

// The committed allowlist is part of the feed's shape: a source that asks for
// as many items as the global cut starves every other source (measured: 5 PRs,
// 0 releases), and the feed's own plumbing PRs are not "what I'm working on".
test('sources.yaml: upstream is bounded and excludes the feed repo', async () => {
  const text = await fs.readFile(path.join(REPO_ROOT, 'sources.yaml'), 'utf8');
  const doc = loadSources(text);
  const upstream = doc.sources.find((source) => source.id === 'upstream');
  assert.ok(upstream, 'upstream source is declared');
  assert.ok(upstream.first <= 2, `upstream must not fill the cut alone, got first: ${upstream.first}`);
  assert.match(upstream.query, /-repo:ChristianLuciani\/now\b/);
});
