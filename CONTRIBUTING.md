# Contributing to Claudex

Thanks for helping. Bug reports, fixes, translations and features are all
welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree
  on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setting up

```sh
npm ci
npm run dev
```

[docs/building.md](docs/building.md) covers the web app, runner, server and
phone apps; [docs/architecture.md](docs/architecture.md) explains how the
parts fit.

## Making a change

- Keep a pull request to one change, and include tests for behaviour you add
  or fix (`tests/`, using `node:test`).
- Run before pushing:

  ```sh
  npx tsc --noEmit
  npm run format:check
  npm test
  ```

  For web-facing changes also run `npm run build:web`; for server changes the
  Go and frontend tests in `backend/`.
- Code style is whatever Prettier produces. Match the surrounding code's
  naming and comment style: comments say what something is for, in plain
  sentences, without history ("changed from…") or ticket numbers.
- Interface text goes through `t()`, keyed by its English text, with
  translations in `shared/i18n/catalogs/` (see [docs/i18n.md](docs/i18n.md)).
- The renderer must not reach Node or the network directly: add a method to
  the preload bridge (`shared/*-api.ts`) and handle it in `electron/ipc/`, and
  say in `shared/web-bridge-methods.ts` how the web app gets it.
- Changes to `backend/` keep upstream Sub2API's layout. Mark changes to
  upstream files with a `CLAUDEX:` comment and list them in
  `backend/CLAUDEX_CHANGES.md`.

## Commit messages

Write the subject as what the change does for the person using the app, in
a full sentence. Add a body when the reason isn't obvious.

## Licensing

By contributing you agree that your contribution is licensed under the
license of the part of the repository it changes: the Apache License 2.0,
or the GNU LGPL v3.0 for `backend/`.
