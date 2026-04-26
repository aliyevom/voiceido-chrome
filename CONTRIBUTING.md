# Contributing to Voiceido — Full Page Capture

Thanks for your interest. This repo follows a strict trunk-based workflow:
**`main` is always releasable, every change lands via a Pull Request, and CI
must be green before merge.** Direct pushes to `main` are not allowed.

## Branching rules

1. Branch off the latest `main`:
   ```bash
   git fetch origin
   git switch -c <prefix>/<short-slug> origin/main
   ```

2. Use one of these prefixes (chosen so reviewers and CI can reason about
   scope at a glance):

   | Prefix       | Use for                                                            |
   | ------------ | ------------------------------------------------------------------ |
   | `feat/`      | A user-visible new capability (popup state, capture mode, etc.)    |
   | `fix/`       | Correcting a broken behaviour                                      |
   | `chore/`     | Tooling, dependencies, build, CI, internal cleanup                 |
   | `refactor/`  | Internal restructuring with no behaviour change                    |
   | `docs/`      | README / CONTRIBUTING / inline doc-only changes                    |
   | `perf/`      | Performance-only changes                                           |

   Examples: `feat/expand-scrollables-toggle`, `fix/pdf-blank-page`,
   `chore/cws-publishing-prep`.

3. Keep each branch **small and focused**. If a change naturally splits in
   two, open two PRs.

## Pull Request rules

1. Open the PR against `main`.
2. Fill out the PR template (`.github/pull_request_template.md`) — every
   section matters; CI cannot verify the manual UI checks for you.
3. Wait for CI to go green. Both jobs must pass:
   - **Extension** — typecheck, production build, ZIP packaging, ZIP-layout
     verification.
   - **Cloud microservice** — typecheck and build.
4. Address review comments via additional commits (do not force-push during
   review unless asked — it makes the diff hard to follow).
5. Merge with **Squash and merge**. Keep the squashed commit subject line
   in the form `<type>: <imperative summary>` (e.g.
   `feat: add expand-scrollables popup toggle`).

## Required local checks before pushing

These are exactly what CI will run, so you can catch failures locally first:

```bash
# Extension
npm ci
npm run typecheck
npm run build
npm run package      # produces release/voiceido-full-page-capture-<ver>.zip

# Cloud microservice (only if you touched cloud/)
cd cloud
npm ci
npx tsc --noEmit
npm run build
```

## What CI runs (`.github/workflows/ci.yml`)

On every push to a branch and on every PR targeting `main`, GitHub Actions
runs two jobs in parallel:

1. **`extension`** —
   - `npm ci`
   - `npm run typecheck`
   - `npm run build`
   - `npm run package`
   - asserts `manifest.json` is at the ZIP root
   - uploads the built ZIP as a downloadable workflow artifact (14 day
     retention) so you can grab the exact upload candidate from any
     reviewer's PR
2. **`cloud`** — `npm ci`, `tsc --noEmit`, `npm run build` inside `cloud/`

If you need to debug a failing run, open the workflow run on GitHub → click
the failing job → expand the failing step.

## Recommended branch-protection settings (repo admin only)

To enforce this workflow on GitHub:

1. Repo → **Settings** → **Branches** → **Add classic branch protection rule**
   for `main`.
2. Enable:
   - ☑ Require a pull request before merging (require 1 approval)
   - ☑ Require status checks to pass before merging
     - Required checks: `Extension (typecheck + build + package)`,
       `Cloud microservice (typecheck + build)`
   - ☑ Require branches to be up to date before merging
   - ☑ Require linear history
   - ☑ Do not allow bypassing the above settings (applies to admins too)
3. Save.

After this, a direct `git push origin main` from anyone — including the
repo owner — will be rejected, and merges become possible only via a green
PR.

## Releases

The `package.json` `version` field is the source of truth for the Chrome
Web Store version. Bump it in the same PR that introduces the change you
want to ship, and the next CI run will produce a correctly-named
`voiceido-full-page-capture-<version>.zip`.

## Privacy & store-policy considerations

Any PR that:

- adds a new permission to `manifest.json`,
- introduces a network call to a new origin,
- or changes how user data is captured, stored, or transmitted

…must also update `PRIVACY.md` in the same PR. Reviewers will block the
merge otherwise. CWS rejects extensions whose privacy disclosures
contradict their actual behaviour.

## Where things live

```
src/                  # extension TypeScript source
public/               # static assets copied verbatim into dist/
scripts/              # build, package, icon, screenshot, promo-tile generators
cloud/                # Cloud Run microservice (Express + TypeScript)
store-assets/         # Chrome Web Store upload artifacts (icon, promo tiles, screenshots)
.github/workflows/    # CI definitions
```

Questions: <https://github.com/aliyevom/voiceido-chrome/issues>
