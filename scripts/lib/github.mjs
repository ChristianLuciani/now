// GraphQL access. No retries, no redirect chasing, honest user-agent. Errors
// never echo a response body or a token.
//
// The workflow authenticates with the ephemeral GITHUB_TOKEN, which is an
// installation token: `viewer` is github-actions[bot], not the feed's owner.
// Every query that must see the owner's repos therefore names the login
// explicitly (`user(login: $owner)`), resolved from sources.yaml or
// GITHUB_REPOSITORY_OWNER.

export const USER_AGENT =
  'ChristianLuciani-now/1.0 (+https://github.com/ChristianLuciani/now)';

// Bounded pagination: AGENTS.md §2 forbids unbounded pagination, so the walk
// has an explicit page cap. 5 pages x 100 repos = at most 500 public repos.
export const RELEASES_PER_PAGE = 100;
export const MAX_RELEASE_PAGES = 5;

const RELEASES_QUERY = `query($owner: String!, $first: Int!, $after: String) {
  user(login: $owner) {
    repositories(first: $first, after: $after, privacy: PUBLIC, ownerAffiliations: OWNER, orderBy: {field: NAME, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
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

export function resolveOwner(source, env = {}) {
  return source.owner || env.GITHUB_REPOSITORY_OWNER || '';
}

async function fetchGithubReleases(source, context) {
  const owner = resolveOwner(source, context.env);
  if (!owner) {
    throw new Error(
      'owner is not set: add "owner:" to sources.yaml or set GITHUB_REPOSITORY_OWNER',
    );
  }

  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_RELEASE_PAGES; page += 1) {
    const data = await graphql({
      ...context,
      query: RELEASES_QUERY,
      variables: { owner, first: RELEASES_PER_PAGE, after },
    });
    // A named `user` that comes back null is an auth/lookup failure, not an
    // account with zero repos: never let it masquerade as a valid empty pass.
    if (page === 0 && data?.user == null) {
      throw new Error(`GitHub user ${JSON.stringify(owner)} was not returned`);
    }
    const repositories = data?.user?.repositories;
    const pageNodes = Array.isArray(repositories?.nodes) ? repositories.nodes : [];
    nodes.push(...pageNodes);

    const pageInfo = repositories?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    // Defensive stop: a page that came back short is the last one, even if the
    // server still claims there is more.
    if (pageNodes.length < RELEASES_PER_PAGE) break;
    after = pageInfo.endCursor;
    if (!after) break;
  }
  return releaseItems(nodes);
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
