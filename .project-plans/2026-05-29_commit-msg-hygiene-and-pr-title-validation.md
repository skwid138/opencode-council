## Plan: Commit-message hygiene + PR-title validation

> **Status:** Approved for persistence
> **Created:** 2026-05-29
> **Source:** User-approved Saruman/council-reviewed plan

### 1. Goal

Apply identical commit-message hygiene and PR-title validation to `~/code/opencode-council` and `~/code/opencode-tui`. Each repo will validate local commit messages with Husky + commitlint and validate PR titles in GitHub Actions because squash merges use the PR title as the commit subject.

### 2. Scope and non-goals

In scope for each repo: add `commitlint.config.js`, `.husky/commit-msg`, `.github/workflows/pr-title.yml`; update `package.json`; verify `.gitignore`; update `README.md`; run local commitlint verification; commit, push, and add `validate` to main branch required status checks while preserving existing checks.

Out of scope: CI/release path filters, changes to test job or `release.yml`, `CONTRIBUTING.md`, sync-check script, semantic prefix-vs-diff matching.

### 3. Context

Apply identically to `~/code/opencode-council` and `~/code/opencode-tui`.

Verified facts:
- `@commitlint/cli` `21.0.2`, `@commitlint/config-conventional` `21.0.2`, and `husky` `9.1.7` are real and current on npm.
- `amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50` is `v6.1.1`.
- Both repos are at `/Users/hunter/code/opencode-council` and `/Users/hunter/code/opencode-tui`.
- Both have remote `origin` pointing at GitHub repos `skwid138/opencode-council` and `skwid138/opencode-tui`.

### 4. Approach

Use the same toolchain and files in both repositories. `package.json` adds commitlint/Husky dependencies plus a `prepare` script. `npm install` installs Husky and creates `.husky/_/`. A Husky v9 `commit-msg` hook runs commitlint locally, and a pinned GitHub Action validates PR titles. README development documentation explains install/test/build commands and Conventional Commit behavior.

### 5. Implementation steps

#### Files per repo

1. `commitlint.config.js` (new)

```js
// keep in sync with opencode-council and opencode-tui
export default {
  extends: ['@commitlint/config-conventional'],
};
```

2. `.husky/commit-msg` (new, `chmod +x`; Husky v9 format — no shebang)

```sh
# keep in sync with opencode-council and opencode-tui
npx --no -- commitlint --edit "$1"
```

3. `.github/workflows/pr-title.yml` (new)

```yaml
# keep in sync with opencode-council and opencode-tui
name: PR Title

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  pull-requests: read

jobs:
  validate:
    name: validate
    runs-on: ubuntu-latest
    steps:
      - uses: amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50 # v6.1.1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

4. `package.json` (edit)

`devDependencies` adds:
- `"@commitlint/cli": "^21.0.2"`
- `"@commitlint/config-conventional": "^21.0.2"`
- `"husky": "^9.1.7"`

`scripts` adds:
- `"prepare": "husky || true"`

5. `.gitignore` (verify)

Ensure `.husky/_/` is ignored or absent.

6. `README.md` (edit)

`opencode-tui`: extend existing `## Development` section.

`opencode-council`: add new `## Development` section before `## Security`, mirroring tui's structure (install/test/coverage/typecheck/build commands).

Both append this subsection:

```markdown
### Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). A local
[husky](https://typicode.github.io/husky/) hook runs
[commitlint](https://commitlint.js.org/) on every commit, and PR titles are validated
by GitHub Actions (`.github/workflows/pr-title.yml`) since this repo squash-merges
with the PR title as the commit subject.

Allowed types: `feat`, `fix`, `perf`, `refactor` (patch), `docs`, `chore`, `ci`,
`style`, `test`, `build`, `revert`.

Notes:
- Use `git commit --no-verify` to bypass the hook in unusual cases (e.g. WIP commits
  you'll squash later).
- A `BREAKING CHANGE:` footer in the commit body triggers a major release regardless
  of the type prefix — use deliberately.
- The conventional prefix governs the release type, but the human is responsible for
  matching prefix to actual change (a `feat:` whose diff is a README typo will still
  publish a minor release).
```

7. Branch protection (one-time, after merge)

```sh
for REPO in skwid138/opencode-council skwid138/opencode-tui; do
  gh api repos/$REPO/branches/main/protection/required_status_checks > /tmp/rsc.json
  jq '{strict: .strict, contexts: (.contexts + ["validate"] | unique)}' /tmp/rsc.json \
    > /tmp/rsc-patch.json
  gh api -X PATCH repos/$REPO/branches/main/protection/required_status_checks \
    --input /tmp/rsc-patch.json
done
```

#### Execution order per repo

1. Edit `package.json` (devDeps + prepare script).
2. Run `npm install` (installs Husky, runs prepare, creates `.husky/_/`).
3. Write `commitlint.config.js`, `.husky/commit-msg`, `.github/workflows/pr-title.yml`.
4. Run `chmod +x .husky/commit-msg`.
5. Update `README.md`; verify `.gitignore`.
6. Local verify: `echo "bad" | npx commitlint` fails; `echo "feat: x" | npx commitlint` passes.
7. Commit: `chore: add commitlint + husky + PR title validation`.
8. Push to main.
9. Run branch-protection script for this repo.
10. Repeat for the other repo.

### 6. Testing strategy

Executable code behavior is limited to local hooks and GitHub workflow validation. Verify per repo that `npm install` exits 0, `echo "garbage" | npx commitlint` exits non-zero, `echo "feat: test" | npx commitlint` exits zero, and the conventional commit used for the repo commit passes the installed Husky hook. After pushing, wait for CI to start; no need to wait for completion.

### 7. Data shapes

N/A — no application data shapes, API contracts, or schema changes involved.

### 8. Risks and open questions

- Stop and report if the commit hook rejects a conformant message, `npm install` fails, `gh api` errors, README structure is unexpected, or either local commitlint check fails the expected outcome.
- Existing CI/release workflows must remain untouched.
- The new sync-header comments must be present in all new synced files.

### 9. Verification

Acceptance criteria:
- Both repos contain all five new/edited files.
- `npm install` from clean clone succeeds.
- Garbage commits fail locally; conventional commits pass; standard `git revert` passes.
- `validate` is in `required_status_checks.contexts` for `main`; existing checks are preserved.
- All new files contain the sync header comment.
- README `## Development` sections are present in both with identical `### Commit messages` block.
- Existing CI/release workflows are untouched.

Final sanity sweep:
- Both READMEs include the sync header and Commit messages block; grep for the strings.
- Both `.github/workflows/pr-title.yml` files are identical; diff them.
- Both `commitlint.config.js` files are identical; diff them.
- Both `.husky/commit-msg` files are identical; diff them.
- Branch protection on both repos lists `validate` in contexts.

### 10. Cross-repo coordination

Execute in `/Users/hunter/code/opencode-council` first, then `/Users/hunter/code/opencode-tui`. For each repo, commit with `chore: add commitlint + husky + PR title validation`, push to `main`, wait for CI to start, then update branch protection for that repo only before moving to the next repo.
