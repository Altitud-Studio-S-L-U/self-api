# Branching

- Use `main` as the integration branch; submit changes through pull requests.
- Finish each task with the primary checkout on main. Merge through PRs only after required reviews and checks; preserve unmerged work in its branches/PRs before removing extra worktrees and disposable task files.
- Name work branches `feat/<short-name>`, `fix/<short-name>`, or `hotfix/<short-name>`.
- Use `feat` for features, `fix` for regular corrections, and `hotfix` for urgent fixes.
- Keep the name after `/` short, descriptive, and lowercase kebab-case.
- Do not use `codex/`, agent names, or other work-branch prefixes.

Examples: `feat/api-scan`, `fix/schema-diff`, `hotfix/token-expiry`.

## README scope

Keep READMEs technical: implemented architecture, data contracts, dependencies, installation, operation and known limitations. Exclude hosting price comparisons, product pricing and commercial plans.

Keep development plans, roadmaps, backlogs and delivery tracking outside repositories in an external temporary directory; technical documentation describes current contracts and operating procedures.
