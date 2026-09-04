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

| Commit subject                                           | Effect on the next release          |
| -------------------------------------------------------- | ----------------------------------- |
| `fix: …`                                                 | patch — `0.30.1` → `0.30.2`         |
| `feat: …`                                                | minor — `0.30.1` → `0.31.0`         |
| `feat!: …` / `BREAKING CHANGE:` footer                   | minor while below 1.0.0 (see below) |
| `chore: …`, `test: …`, `refactor: …`, `docs: …`, `ci: …` | none — no release is cut            |

A PR of nothing but `test:` and `chore:` commits produces no release PR at all.
That is correct: there is nothing for a consumer to install.

⚠️ **Use `ci:` for workflow-only changes, not `fix(ci):`.** release-please reads
the _type_, not the scope, so `fix(ci):` is a `fix` and cuts a patch release — it happened in quill-ui, which ended up with a release carrying nothing but a workflow change. Harmless, but it puts a meaningless entry in the consumer-facing changelog.

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

The tag and the GitHub release already exist, so nothing is lost — the version
just has no tarball yet. Fix the cause, then republish that same tag:

**Actions → Release → Run workflow → tag = `vX.Y.Z`**

That path skips release-please entirely and publishes the tag you name. It is
safe to run twice: if the version turns out to be on npm already, the job says
so and exits clean.

> ⚠️ **Do not use "Re-run all jobs" on the failed run.** release-please is
> idempotent but not repeatable — on a second run it finds the release already
> cut, reports `release_created: false`, and the publish job is _skipped_ rather
> than retried. You then can't "re-run failed jobs" either, because nothing
> failed. ("Re-run failed jobs" on the original run does work, because it reuses
> the successful release-please job's outputs — but "Run workflow" above is the
> path that always works.)

Never cut a new version to work around a failed publish.

**Backfilling an old tag is safe.** npm points `latest` at whatever was published
most recently, not at the highest version, so republishing an older tag once a newer one is already out would otherwise drag
`latest` backwards. The job detects that and publishes the older version under a
`backfill` dist-tag instead. You can also just skip it: a newer tag's tarball
already contains everything the older one did, and a release with no tarball
costs nothing but tidiness.

The likeliest cause is `NPM_TOKEN`. The job tells three failures apart, because
npm's own errors do not:

| Symptom                                               | Cause                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `npm whoami` fails                                    | token expired or rotated                                          |
| `whoami` prints a name, publish gives `E403` on `PUT` | token authenticates but is **read-only**                          |
| publish gives `EOTP`                                  | token is a classic **Publish** token — those still prompt for 2FA |

**Token type matters more than the permission checkbox.** A classic _Publish_
token cannot work unattended on a 2FA account: npm asks it for a one-time
password, which no CI job can answer. Use a classic **Automation** token or a
**Granular Access Token** with read+write on `@dabble/patches` — both are designed to
bypass 2FA. Update the `NPM_TOKEN` repo secret, then republish the tag with Run
workflow.

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
