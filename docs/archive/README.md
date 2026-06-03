# Archive

Historical analysis and incident docs that are preserved for reference
but are no longer part of the working documentation set.

Anything moved here was:

- **Time-bound** — a snapshot of state at a specific date (test reviews,
  RCAs) that doesn't update when the codebase moves on.
- **Decision-shaped** — an analysis written to support a one-time call
  (e.g. choosing between two PR approaches) where the decision has
  since landed and the analysis is no longer load-bearing.
- **Superseded** — the doc's content has been integrated into the
  current working docs and the original is kept only as provenance.

If you're looking for **current** state of the suite, start with:

- [`../../README.md`](../../README.md) — what the suite does, how to run it
- [`../../CLAUDE.md`](../../CLAUDE.md) — conventions + per-app gotchas
- [`../spec-coverage.md`](../spec-coverage.md) — current audit table
- [`../spec-coverage-deferred.md`](../spec-coverage-deferred.md) — gap pile
- [`../spec-review-checklist.md`](../spec-review-checklist.md) — PR-time discipline
- [`../../TRIAGE.md`](../../TRIAGE.md) — failure-pattern → action runbook
- [`../../skills.md`](../../skills.md) — findings, link-coverage rules, bug-staging workflow

Don't edit anything in this directory. If something here is still
load-bearing, promote it back to working docs (and update the working
docs to absorb the content). If nothing depends on it, leave it
archived — `git log` preserves provenance forever.
