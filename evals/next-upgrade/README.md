# Next.js upgrade evals

Run upgrade agents locally through Vercel Sandbox and AI Gateway, then verify the delivered app in a separate credential-free Sandbox. Keep local credentials and raw results untracked.

## Local setup

Use your existing Vercel CLI login and project. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build-all
vc link --yes --scope vercel-labs --project next-agentic-upgrade
vc env pull --environment=development --scope vercel-labs
chmod 600 .env.local
pnpm eval:upgrade --list
pnpm eval:upgrade security-same-major --dry
NEXT_UPGRADE_EVAL_EXPERIMENT=codex pnpm eval:upgrade security-same-major
```

Only VERCEL_OIDC_TOKEN is required. Use claude instead of codex to select the other harness. The case prompt invokes the candidate CLI; committed, dirty and untracked worktree source is captured before grading. Results retain the actual source, command output and passed/failed/invalid verdict. Only invocation-owned VMs and snapshots are cleaned up.
