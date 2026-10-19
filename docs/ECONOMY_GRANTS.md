# Economy grants (manual coin top-ups)

Manual grants go through the ledger like everything else. Never `INSERT` into
`point_transactions` or `UPDATE` `user_coin_balances` by hand.

## The one command

```sh
node scripts/grant-coins.mjs <username|email|uuid> --amount <n> --reason "..." [--currency free|pro] [--dry-run]
npm run economy:grant -- good --amount 1000 --reason "..."
```

The script resolves the user, calls the real `grantPoints` writer from `dist/`,
and prints the result plus balances. `--dry-run` prints the plan without writing.

## Rules the script already enforces

- Type is `admin_adjust`, source is `admin` — the only manual-grant pair the
  `ptx_type_check` constraint accepts. `reward`/`iap_purchase`/`spend`/`refund`
  belong to their own flows, not to humans.
- A fresh idempotency key per run, so a double-invoked command replays
  instead of double-paying. Same key + same user = `replayed`, zero granted.
- Amount capped at `ADMIN_GRANT_MAX` (`src/features/economy/config.ts`).
- `--reason` is required and lands in the ledger row.

## Environment gotchas

- The script imports from `dist/`: rebuild first (`npm run build`, i.e. `tsc`)
  if `src/features/economy` or `src/database` changed since the last build.
- It defaults `NODE_ENV` to `development` so the production env strictness
  (32-byte `JWT_SECRET`, `SYNC_OPEN=false`, Google client IDs) does not block
  a local run. The target database still comes from `DATABASE_URL`, so a
  `.env` pointing at the prod pooler writes to prod — that is the point, but
  confirm the URL before running.

## After every grant

```sh
npm run economy:reconcile
```

Expect `mismatches: 0`. Anything else means the ledger and the wallet
disagree — stop and investigate, do not grant again.
