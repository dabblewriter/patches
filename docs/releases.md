# Releases & versioning

## The short version

**Nothing in a feature PR touches `package.json`'s version.** You write
conventional commits; release-please works out the version, and merging its
release PR publishes to npm.

```
feature PR merges to main
        ↓
release-please opens/updates a release PR   ← the version lives ONLY here
        ↓
you approve + merge it
        ↓
tag vX.Y.Z + GitHub release + npm publish   ← all automatic
```

## Why it changed

Releases used to be a hand-written `chore(main): release X.Y.Z` PR followed by
someone running `npm publish` from a local clone. That worked, but the version
number was chosen while a branch was open, so two branches prepared the same
day could — and did, in `@dabble/quillui` — both claim the same version. Whoever
published second either clobbered the first fix or had to redo the bump.

Because release-please computes the version at merge time, from the commits
that are actually on `main`, two branches cannot collide. There is no version to
collide over until the release PR is cut.

## What you have to do

Write [conventional commits](https://www.conventionalcommits.org/). That is the
whole contract:

| Commit subject                                  | Effect on the next release          |
| ----------------------------------------------- | ----------------------------------- |
| `fix: …`                                        | patch — `0.30.1` → `0.30.2`         |
| `feat: …`                                       | minor — `0.30.1` → `0.31.0`         |
| `feat!: …` / `BREAKING CHANGE:` footer          | minor while below 1.0.0 (see below) |
| `chore: …`, `test: …`, `refactor: …`, `docs: …` | none — no release is cut            |

A PR of nothing but `test:` and `chore:` commits produces no release PR at all.
That is correct: there is nothing for a consumer to install.

### Pre-1.0 breaking changes

`bump-minor-pre-major: true` in `release-please-config.json` means a breaking
change bumps the **minor** (`0.30.1` → `0.31.0`) rather than jumping to `1.0.0`.
This package is deliberately pre-1.0 and has shipped breaking changes inside
`0.x` before; going to `1.0.0` should be a decision someone makes out loud, not
something a `!` earns by accident.

To cut `1.0.0` when that day comes, put a `Release-As` footer on a conventional
commit on `main` (release-please only reads footers on commits it can parse, so
the subject must be `chore: …`, not `Merge pull request …`):

```
chore: release 1.0.0

Release-As: 1.0.0
```

## The release PR

release-please keeps **one** open PR, titled `chore(main): release X.Y.Z`. It
rewrites itself every time something lands on `main`, so the version and the
changelog always reflect everything unreleased. You do not need to close and
reopen it, and you should not push to it.

Merging it is the act of releasing. `main`'s ruleset requires an approving
review, so a human still says yes — that is the intended gate.

## What happens on merge

1. release-please creates the tag `vX.Y.Z` and a GitHub release with the changelog.
2. The `publish` job checks out **that tag** (not `main`, which may have moved),
   runs `npm ci` (whose `prepare` builds `dist/`), and runs `npm publish`.

You do not need to run `npm publish` locally, and you should not — a local
publish from a dirty or stale tree is exactly what the tag checkout exists to
prevent.

### If the publish fails

The tag and the GitHub release already exist, so nothing is lost. Fix the cause
and **re-run the failed job** — do not cut a new version.

The likeliest cause is `NPM_TOKEN`. The job runs `npm whoami` before building so
an expired or rotated token fails immediately with that diagnosis rather than
halfway through a publish. Mint a granular token with publish access to
`@dabble/patches` and update the repo secret.

## Consumers

`@dabble/patches` is consumed by `dabble-writer-3.0`, `pup`, `dabble-rest` and
`dabble-admin`. Publishing does not update them — bump the dependency in each
consumer as a normal PR once the release lands. `dabble-writer-3.0` and `pup`
pin exact versions; keep them aligned with each other, since they run the same
sync protocol on opposite ends of the wire.

## Configuration

| File                            | What it does                                         |
| ------------------------------- | ---------------------------------------------------- |
| `release-please-config.json`    | Release type, tag format, pre-1.0 bump behaviour     |
| `.release-please-manifest.json` | The last released version — release-please owns this |
| `.github/workflows/release.yml` | Runs release-please, then publishes                  |

`bootstrap-sha` pins where the changelog starts. It points at the merge of #161,
which is the tree `0.30.1` was published from, so the first release PR reports
only what landed after it. It is read once, when no release exists yet; leave it
in place as a record of where the automation began.

`CHANGELOG.md` is generated. Don't hand-edit it.
