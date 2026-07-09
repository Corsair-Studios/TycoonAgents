---
name: git
description: Branch, commit, PR, and history workflows with safe defaults.
---

# Git

Practical git workflows for day-to-day changes, with defaults that avoid
losing work. When in doubt, prefer the reversible operation.

## Everyday workflow

1. `git status` — see what's changed and what's staged.
2. `git diff` (unstaged) and `git diff --staged` — review the actual content
   before committing, not just the file list.
3. Stage specific files by name: `git add path/to/file.ts` — avoid `git add -A`
   or `git add .`, which can sweep in `.env` files, credentials, or build
   output you didn't mean to commit.
4. `git commit -m "..."` — write the *why*, not a restatement of the diff.
5. `git push` — push to the branch's existing upstream. If it has none yet,
   `git push -u origin <branch>` sets it.

## Branching for changes

Don't commit new work directly on the default branch (`main`/`master`).
Branch first:

```
git checkout -b feature/short-description
```

Base new branches on an up-to-date default branch (`git pull` first, or
`git fetch && git rebase origin/main` if the branch already exists).

## Safe defaults

- **Don't commit or push unless asked.** Making changes and leaving them
  uncommitted is fine; committing is a decision the user should drive unless
  they've told you to commit as part of the task.
- **Branch, don't commit to default.** If no branch exists yet for the work,
  create one before the first commit.
- **New commits over rewriting history.** Prefer a fresh commit to
  `git commit --amend` or an interactive rebase, especially once anything
  has been pushed — rewriting shared history breaks other clones.
- **Never force-push** (`git push --force`) without being explicitly asked,
  and never to `main`/`master` even then without confirming — it can discard
  a collaborator's commits with no warning.
- **Don't skip hooks or signing.** Avoid `--no-verify`, `--no-gpg-sign`, or
  `-c commit.gpgsign=false` unless the user explicitly asks for it. A failing
  hook is signal, not an obstacle — fix the underlying issue and recommit.

## Pull requests (`gh` CLI)

```
gh pr create --title "Short summary" --body "What changed and why."
gh pr view --web
gh pr checks
gh pr diff
```

Keep PR titles short and put detail in the body. Squash-merge or regular
merge is a repo-policy choice — check `gh pr merge --help` rather than
guessing at flags.

## Inspecting history

- `git log --oneline -20` — recent commits at a glance.
- `git log -p -- path/to/file` — full history of one file.
- `git show <sha>` — a specific commit's diff.
- `git blame path/to/file` — who last touched each line, and in which commit.
- `git diff <shaA>..<shaB>` — compare two points in history.

## Recovery (undo without losing work)

- Unstage a file, keep edits: `git restore --staged path/to/file`
- Discard unstaged edits to one file: `git restore path/to/file` (this *does*
  discard — check `git diff` first, or stash instead).
- Stash work-in-progress instead of discarding it: `git stash push -u` (keep
  it), later `git stash pop`.
- Undo a *pushed* commit: `git revert <sha>` — creates a new commit that
  undoes the change, safe for shared history. Prefer this over
  `git reset --hard`, which rewrites history and can drop commits others
  already have.
- Recover a deleted-looking commit: `git reflog` still has it for a while.

## Gotchas

- `git reset --hard`, `git push --force`, `git checkout -- <file>`, and
  `git clean -f` are all destructive and hard to undo. Before running one,
  check `git status`/`git diff` for anything uncommitted that would be lost,
  and consider `git stash` or `git revert` as a non-destructive alternative.
- Don't commit large or generated files (build output, `node_modules`,
  binaries produced by a build step) — add them to `.gitignore` instead.
- A merge conflict is not an error to route around with `--force` or
  `--theirs` blindly — read both sides of the conflict markers and resolve
  intentionally.
