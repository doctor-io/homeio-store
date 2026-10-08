# homeio-store

The app catalog for [Homeio](https://github.com/doctor-io/homeio).

## Layout

```
store.yml                 format version, categories, featured apps
Apps/<id>/
  homeio.yml              what the store shows
  docker-compose.yml      what gets installed
  icon.svg|png|webp
  screenshots/1-3.webp    up to three
  .no-smoke               optional: heavy app, static checks only
```

## homeio.yml

| Field | Meaning |
|---|---|
| `id` | Same as the folder and the compose `name`. |
| `name`, `developer`, `website` | Shown on the app page. |
| `tagline`, `description` | `{ en, fr }`. Tagline is the card line. |
| `category` | An id from `store.yml`. |
| `main` | The compose service that has the web UI. |
| `port` | Container port of the web UI, published by `main`. |
| `scheme`, `index` | Optional, default `http` and `/`. |
| `env` | Optional. `label` and `description` (`{ en, fr }`) for compose `environment` variables the user is asked to fill. |

## Variables

Only the variables listed under `env` in `homeio.yml` are asked at install time. The answers are written to the stack's `.env`, so the compose has to read them as `NAME: ${NAME:-default}`; a literal value would ignore what the user typed. `npm run validate` checks that. Anything not listed stays internal.

## Rules

- Image tags are pinned, never `latest`. Renovate raises the tags; patch updates merge on their own once the checks pass.
- App data lives under `/DATA/AppData/$AppID/`.
- No default secret shared by every install: use SQLite when the app can, keep any database on the compose's private network, and leave a password empty rather than guessing one.
- `npm run validate` checks all of it. `npm run smoke -- <id>` really starts an app (`--keep` leaves it running, `npm run smoke:down` stops it).
- Screenshots: `node scripts/shoot.mjs out.png <url> [steps]` drives Chrome, `npm run webp -- in.png <id> <n>` writes `Apps/<id>/screenshots/<n>.webp`.
