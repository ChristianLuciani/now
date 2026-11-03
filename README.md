# now

What I'm working on now — a small, committed snapshot that feeds the public surfaces
that must stay current: the GitHub profile README and
[christianluciani.github.io](https://christianluciani.github.io).

**Status: skeleton.** The contract and the v1 shape are fixed here; the producer is
tracked in #1.

## Why a repo and not "just an Action"

A scheduled workflow needs somewhere to put its output, and more than one surface reads
it. Keeping the feed in its own repository means:

- one producer, N consumers (the profile README, the site, anything later);
- no cross-repo write token: every consumer **pulls**, nobody pushes;
- the snapshot is a commit — diffable, reviewable, revertible;
- no coupling to the private workspace or to the engine.

This is deliberately **not** part of `profile-as-code`. The engine compiles curated
facts into a static artifact; this feed carries chrome that changes over time. Keeping
them apart is what preserves the engine's determinism (SPEC §15.1/§19.5 in
[profile-as-code](https://github.com/ChristianLuciani/profile-as-code)).

## Contract

1. **One producer.** Only the workflow in this repo writes `now.json` / `now.md`.
   Never hand-edit either.
2. **Snapshot, not crawler.** The workflow fetches declared sources, writes what it
   got, and stops. No runtime API here, no per-visitor fetch.
3. **Committed output.** `now.json` + `now.md` are committed, dated, and tagged.
4. **Absolute time only.** Source dates are `YYYY-MM-DD`; `asOf` is the fetch instant
   in UTC. Never "2 hours ago" — it rots in cache and it lies.
5. **Public sources only, declared.** `sources.yaml` is the allowlist. No tokens in
   the output; only the workflow's ephemeral `GITHUB_TOKEN`.
6. **Failure keeps the last good snapshot.** A broken source never writes a partial
   file: the job fails loudly and the previous tag keeps serving.
7. **No vanity metrics.** No stars, followers or visits. The feed says what shipped
   and what is being worked on, never how popular it is.

## Outputs

| File | Who reads it |
|---|---|
| `now.json` | machine consumers (the site build, embeds) |
| `now.md` | the GitHub profile README block |

`now.md` is **generated from** `now.json` — one renderer, one home. Two hand-written
copies would drift.

### Shape (v1)

```json
{
  "schema": "now/v1",
  "asOf": "2026-11-03T19:00:00Z",
  "items": [
    {
      "kind": "release",
      "title": "profile-as-code v0.3.7",
      "url": "https://github.com/ChristianLuciani/profile-as-code/releases/tag/v0.3.7",
      "date": "2026-10-31",
      "source": "github:ChristianLuciani/profile-as-code"
    }
  ]
}
```

Constraints live in [`schema/now.schema.json`](schema/now.schema.json): max 5 items,
sorted by `date` desc then `url` asc, `https://` only, `kind` ∈ `release | post | pr | note`.

### Markdown block

`now.md` is spliced into the profile README between markers, **below** the engine's
generated footer:

```
<!-- now starts -->
…generated…
<!-- now ends -->
```

The block is *chrome*: it sits outside the region the engine owns, so it can change
hourly without being read as drift, and it never contains the engine's footer literal.

## Consumers

| Surface | How it reads | Where |
|---|---|---|
| GitHub profile README | `raw.githubusercontent.com` at a pinned tag, spliced by that repo's workflow | [ChristianLuciani/ChristianLuciani](https://github.com/ChristianLuciani/ChristianLuciani) |
| Site | jsDelivr at a pinned tag during the build, committed as generated data | [christianluciani.github.io](https://github.com/ChristianLuciani/christianluciani.github.io) |

Consumers **pin a tag** and record the digest in a `now.lock.json`, the same pattern as
`brand-kit.lock.json`: a feed that changes under a consumer's feet is a supply-chain
surprise.

## License

MIT — see [LICENSE](LICENSE).
