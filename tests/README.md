# Tests

Run with Node ≥22.6 (this repo is verified on Node 26, which strips TypeScript types
natively — no test framework or build step is needed):

```bash
npm test        # node --test tests/*.test.ts
node --test tests/selection.test.ts
```

These files test the **pure** decision helpers extracted from the UI so the rules can be
asserted without a DOM or a host:

| File | Covers |
|---|---|
| `selection.test.ts` | Which room the snapshot loop may select: a poll answer never re-points a user pick; an explicit `preferId` only wins when its request started after the last pick. |
| `ledger-window.test.ts` | Transcript window rules: merge by id/rev, one row per id, the answer-row backfill cursor, and the "terminal run with no answer row" detector. |

The tests import source `.ts` modules directly. This is deliberate: the same rules that
run in the browser are the ones under test, rather than a copy that can drift.
