// One GraphQL request per source. No retries, no redirect chasing, honest
// user-agent. Errors never echo a response body or a token.

export const USER_AGENT =
  'ChristianLuciani-now/1.0 (+https://github.com/ChristianLuciani/now)';

const RELEASES_QUERY = `query($first: Int!) {
  viewer {
    repositories(first: $first, privacy: PUBLIC, ownerAffiliations: OWNER, orderBy: {field: NAME, direction: ASC}) {
      nodes {
        nameWithOwner
        releases(last: 1) {
          nodes { tagName url publishedAt }
        }
      }
    }
  }
}`;

const PRS_QUERY = `query($query: String!, $first: Int!) {
  search(query: $query, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        title
        url
        mergedAt
        repository { nameWithOwner }
      }
    }
  }
}`;

export function resolveApiUrl(env = process.env) {
  const raw = env.GITHUB_API_URL || 'https://api.github.com';
  return raw.replace(/\/+$/, '');
}

export async function graphql({
  apiUrl,
  token,
  query,
  variables,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
}) {
  const response = await fetchImpl(`${apiUrl}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`github graphql: HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors.map((entry) => entry.message).filter(Boolean);
    throw new Error(`github graphql: ${messages.join('; ') || 'unknown error'}`);
  }
  return payload.data;
}

function releaseItems(nodes) {
  const items = [];
  for (const repo of Array.isArray(nodes) ? nodes : []) {
    const nameWithOwner = repo?.nameWithOwner;
    const release = repo?.releases?.nodes?.[0];
    if (!nameWithOwner || !release?.tagName || !release?.url || !release?.publishedAt) {
      continue;
    }
    const repoName = nameWithOwner.split('/').pop();
    items.push({
      kind: 'release',
      title: `${repoName} ${release.tagName}`,
      url: release.url,
      date: String(release.publishedAt).slice(0, 10),
      source: `github:${nameWithOwner}`,
    });
  }
  return items;
}

function prItems(nodes) {
  const items = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const nameWithOwner = node?.repository?.nameWithOwner;
    if (!nameWithOwner || !node?.title || !node?.url || !node?.mergedAt) continue;
    items.push({
      kind: 'pr',
      title: node.title,
      url: node.url,
      date: String(node.mergedAt).slice(0, 10),
      source: `github:${nameWithOwner}`,
    });
  }
  return items;
}

async function fetchGithubReleases(source, context) {
  const data = await graphql({
    ...context,
    query: RELEASES_QUERY,
    // A single request, capped server-side. Following endCursor would be a
    // crawler; AGENTS.md §2 forbids it and issue #1 mandates one request.
    variables: { first: 100 },
  });
  return releaseItems(data?.viewer?.repositories?.nodes);
}

async function fetchGithubPrs(source, context) {
  const data = await graphql({
    ...context,
    query: PRS_QUERY,
    variables: {
      query: String(source.query),
      first: source.first === undefined ? 5 : Number(source.first),
    },
  });
  return prItems(data?.search?.nodes);
}

const FETCHERS = {
  'github-releases': fetchGithubReleases,
  'github-prs': fetchGithubPrs,
};

export async function fetchSource(source, context) {
  const fetcher = FETCHERS[source.kind];
  if (!fetcher) {
    throw new Error(`unsupported source kind ${JSON.stringify(source.kind)}`);
  }
  return fetcher(source, context);
}
