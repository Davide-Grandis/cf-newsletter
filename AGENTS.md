# Agent notes

## Verification

- Web typecheck: `cd web && node_modules/.bin/tsc -b`
- Unit tests (`tests/*.test.ts` use extensionless imports, so bundle first):
  ```sh
  T=$(mktemp -d)
  web/node_modules/.bin/esbuild tests/mail-merge.test.ts --bundle --platform=node --format=esm --outfile=$T/t.mjs
  node --test $T/t.mjs
  ```
  `tests/updates.test.ts` imports `cloudflare:` modules and needs a stub to run under Node.
- Worker bundling smoke test:
  `web/node_modules/.bin/esbuild workers/<name>/src/index.ts --bundle --format=esm --platform=neutral --external:cloudflare:* --external:postal-mime --loader:.md=text --outfile=/tmp/<name>.js`

## Database changes

- Fresh installs use `db/schema.sql`; existing installs get `db/updates/NNNN_*.sql`
  listed in `db/updates/manifest.json` (with a `checkSql` postcondition). The updater
  runs migrations before deploying workers and releases declare migrations as
  additive, so avoid dropping or renaming columns in a migration.
