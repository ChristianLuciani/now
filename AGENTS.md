# AGENTS.md — now

## What this is

The feed of what I'm working on now: a committed snapshot consumed by the GitHub profile
README and the site. The producer lives in `scripts/`; the workflow in
`.github/workflows/update.yml` owns the committed output.

## Rules

1. **One writer.** Only the workflow writes `now.json` / `now.md`. Never by hand.
2. **Snapshot, not crawler.** One pass over the declared sources per run; no retry loop,
   no unbounded pagination.
3. **Absolute dates.** `YYYY-MM-DD` from the source; `asOf` in UTC. Never a relative time.
4. **Public data only.** Nothing from a private repo, a token, or a private surface.
5. **No vanity metrics.** No stars, followers, visits.
6. **Schema first.** Change `schema/now.schema.json` and the shape together. Consumers
   pin a tag, so a shape change is a new minor, never an edit in place.
7. **Determinism.** Same sources + same `asOf` → same bytes. Every sort is total
   (`date` desc, then `url` asc).
8. **Branch + PR.** The human merges; never push to `main`.

## Commands

```sh
npm run fetch     # sources → now.json (needs GITHUB_TOKEN; the workflow has it)
npm run render    # now.json → now.md (idempotent)
npm run check     # schema + sorted + no secrets in the output
npm test          # fixtures and a local GraphQL stub; no network
```
