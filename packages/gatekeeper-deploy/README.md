# Deploy Gatekeeper

Gives a CloudflareOS workspace the ability to deploy application code to **exactly one Worker**
on the workshop account. Built for the ChangeGuard workshop: every attendee's app deploys to
their own roster-assigned Worker, and nobody's workspace can reach anyone else's resources.

## Security model

- **One credential, server-side.** The gatekeeper Worker holds a Cloudflare API token
  (`CLOUDFLARE_API_TOKEN` secret) scoped Workers Scripts:Edit plus KV/D1/R2 read on the workshop
  account. Workspaces and agents never see it; they call the session API over RPC.
- **One Worker per binding.** A session is bound to `deploy://workers/<worker-name>`, and the
  name must start with the configured `DEPLOY_WORKER_PREFIX` (`changeguard-` for ChangeGuard). Every
  mutation is confined to that Worker.
- **Owned bindings only.** A deploy may attach KV/D1/R2 resources whose own names start with the
  Worker's name (`changeguard-terrific-tiger-sessions`, `changeguard-terrific-tiger-db`, ...), verified against the
  account before upload. No secrets, service bindings, Durable Objects, or static assets in this
  phase.
- **No secret values ever.** `vars` are plain text. Secrets are set out of band
  (`wrangler secret put`) and survive every deploy.
- **Audit.** Versions and deployments carry `workers/message` and
  `workers/triggered_by: gatekeeper-deploy` annotations.

Phase 1 executes deploys immediately when the agent calls `deploy()`; in-UI approval
(`submitAction`/`applyAction`), simulation, and per-observer verification are Phase 2, per
upstream's [`write-gatekeeper` skill](../../cloudflare-os/.agents/skills/write-gatekeeper/SKILL.md).

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `workers.deployGatekeeper.name` | `deployment.jsonc` | The gatekeeper Worker's own name |
| `deployGatekeeper.workerPrefix` | `deployment.jsonc` | Prefix deployable Worker names must carry |
| `CLOUDFLARE_ACCOUNT_ID` | generated var | Workshop account the API token operates on |
| `DEPLOY_WORKER_PREFIX` | generated var | Same prefix, on the Worker |
| `DEPLOY_COMPATIBILITY_DATE` | generated var | Default compatibility date for deploys |
| `CLOUDFLARE_API_TOKEN` | secret | `CLOUDFLARE_ACCOUNT_ID=... pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --name <worker>` |

`pnpm cf-os check` warns while the secret is missing, and `wrangler deploy` refuses without it.

## Session API

See `src/types.d.ts` (and the agent-facing mirror `src/types-code.ts`): `getTarget`,
`getStatus`, `listVersions`, `validate`, `deploy`, `rollback`. Agents should call `validate`
before `deploy` and fix reported errors; `deploy` refuses invalid specs.

## Check

```sh
pnpm run gen:configurator   # rebuilds the configurator HTML and its importable TS module
pnpm run types:check
pnpm exec vitest run
pnpm exec wrangler deploy --dry-run
```
