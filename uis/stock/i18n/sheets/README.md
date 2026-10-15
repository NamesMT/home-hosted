# Strings

One row per string, one column per language. `pnpm run build:locales` merges every `*.csv` here into
the single catalog per locale that the UI imports (into `../generated/`, git-ignored).

## Which sheet does a key go in?

A sheet is named after the key's own prefix, so a key's home is decided by the key, never by choice:

| key | sheet |
| --- | --- |
| `common.cancel` | `common.csv` |
| `serverForm.portHint` | `serverForm.csv` |
| `settings.ddns.updates` | `settings.ddns.csv` |
| `settings.host.cpuTemp` | `settings.host.csv` |

`settings.*`, `proxy.*` and `views.*` are large enough to shard one level deeper; every other prefix
keeps all its keys in the file named after it. `test/i18n-catalog.test.ts` fails if a row sits in the
wrong sheet, so this stays true without anyone remembering it.

## A row

`KEY`, then one column per locale — `en`, `vi`, `zh-CN`, `ja`, `es`, `ko`, `ru`, `fr`, `de`. Keys are
flat dotted paths; quotes and commas are ordinary CSV, so a value with either needs quoting.

Add a language by adding its column here **and** its entry to `LOCALES` in
`src/i18n/locales.ts`.

## Plurals

One row per CLDR category: `key[one]`, `key[few]`, `key[many]`, `key[other]`, folded back into a
message object. Leave a category blank when the language has no such form — Spanish `many` only
occurs at a million and reads from `other`. A blank non-plural cell is a bug.
