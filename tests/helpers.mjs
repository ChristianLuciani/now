import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const FIXTURES = path.join(HERE, 'fixtures');
export const FETCH = path.join(REPO_ROOT, 'scripts', 'fetch.mjs');
export const RENDER = path.join(REPO_ROOT, 'scripts', 'render.mjs');
export const CHECK = path.join(REPO_ROOT, 'scripts', 'check.mjs');

export async function tmpRepo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'now-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(path.join(REPO_ROOT, 'schema'), path.join(dir, 'schema'), { recursive: true });
  await fs.copyFile(path.join(FIXTURES, 'sources.yaml'), path.join(dir, 'sources.yaml'));
  return dir;
}

export async function writeFixture(dir, fixtureName) {
  const text = await fs.readFile(path.join(FIXTURES, fixtureName), 'utf8');
  const snapshot = JSON.parse(text);
  await fs.writeFile(path.join(dir, 'now.json'), text);
  const { renderMarkdown } = await import(path.join(REPO_ROOT, 'scripts', 'lib', 'render.mjs'));
  await fs.writeFile(path.join(dir, 'now.md'), renderMarkdown(snapshot));
  return snapshot;
}

export function runNode(script, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function stubServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        payload = {};
      }
      const result = (await handler(payload, req)) ?? {};
      res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body ?? {}));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export const RELEASES = {
  viewer: {
    repositories: {
      nodes: [
        {
          nameWithOwner: 'ChristianLuciani/alpha',
          releases: {
            nodes: [
              {
                tagName: 'v1.0.0',
                url: 'https://github.com/ChristianLuciani/alpha/releases/tag/v1.0.0',
                publishedAt: '2026-10-31T10:00:00Z',
              },
            ],
          },
        },
        {
          nameWithOwner: 'ChristianLuciani/beta',
          releases: {
            nodes: [
              {
                tagName: 'v2.0.0',
                url: 'https://github.com/ChristianLuciani/beta/releases/tag/v2.0.0',
                publishedAt: '2026-10-31T10:00:00Z',
              },
            ],
          },
        },
        {
          nameWithOwner: 'ChristianLuciani/gamma',
          releases: {
            nodes: [
              {
                tagName: 'v0.1.0',
                url: 'https://github.com/ChristianLuciani/gamma/releases/tag/v0.1.0',
                publishedAt: '2026-11-02T09:00:00Z',
              },
            ],
          },
        },
        {
          nameWithOwner: 'ChristianLuciani/delta',
          releases: {
            nodes: [
              {
                tagName: 'v3.0.0',
                url: 'https://github.com/ChristianLuciani/delta/releases/tag/v3.0.0',
                publishedAt: '2026-10-28T08:00:00Z',
              },
            ],
          },
        },
      ],
    },
  },
};

export const PRS = {
  search: {
    nodes: [
      {
        title: 'Fix thing',
        url: 'https://github.com/other/repo/pull/12',
        mergedAt: '2026-11-01T12:00:00Z',
        repository: { nameWithOwner: 'other/repo' },
      },
      {
        title: 'Add feature',
        url: 'https://github.com/other/repo/pull/13',
        mergedAt: '2026-11-02T09:00:00Z',
        repository: { nameWithOwner: 'other/repo' },
      },
    ],
  },
};

export function githubHandler({ fail = null, releases = RELEASES, prs = PRS } = {}) {
  return (payload) => {
    const query = String(payload.query ?? '');
    if (query.includes('repositories(')) {
      if (fail === 'releases') return { status: 500, body: { message: 'boom' } };
      return { status: 200, body: { data: releases } };
    }
    if (query.includes('search(')) {
      if (fail === 'upstream') return { status: 500, body: { message: 'boom' } };
      return { status: 200, body: { data: prs } };
    }
    return { status: 200, body: { data: {} } };
  };
}
