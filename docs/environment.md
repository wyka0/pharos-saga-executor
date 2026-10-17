# Environment inspection

Inspection date: **2026-10-17**
Machine: Windows 11, PowerShell 7, Node **v24.14.1**, npm **11.11.0**, git **2.53.0**.
Project: `C:\pharos-saga-executor`.
Target environment: <https://ai.pharos.xyz/>.

> This document records what was actually observed. It deliberately separates
> observed behaviour from undocumented assumptions. No wallet was used, no
> authenticated session was created, and no transaction was sent.

## 1. What `ai.pharos.xyz` actually is

| Check | Observed result |
| --- | --- |
| `GET https://ai.pharos.xyz/` | `HTTP 200`, `Content-Type: text/html`, 1,424 bytes, served by Amazon S3 + CloudFront |
| Page shell | Vite/React SPA: `<div id="root">` plus `/assets/index-CKPzKtjm.js` and `/assets/index-Ck3uhakH.css` |
| JS bundle | `2,399,635` bytes, downloaded for static inspection only |
| Product name | `AI.PHAROS` — "Start with docs, tools, code, or an open-source task." |
| Backend used by the SPA | `https://flow.anvita.xyz` (the bundle constant is `PT="https://flow.anvita.xyz"`) |
| Agent Center app key | `agent_center` (bundle constant `bw="agent_center"`) |

### Four agent surfaces in the bundle

The SPA defines an allow-list of exactly four hosted agent types:

```text
PHAROS_PERSONAL_AGENT   -> "General Chat"          route /
PHAROS_DOCS             -> "Pharos Docs MCP"       routes /network-info, /build-tools
PHAROS_SKILL_ENGINE     -> "Pharos Official Skill" route  /skill-engine
PHAROS_MCP              -> "Pharos MCP"            route  /pharos-mcp
```

`/skill-engine` is described in the UI as **"Callable Pharos actions packaged as
an installable skill."** Its only call-to-action is a GitHub link. The page does
**not** contain an upload form, a skill registry, a "register your skill" button,
or any endpoint for third-party skill registration.

## 2. How skills are packaged and invoked

The Skill Engine page offers:

```bash
npx skills add https://github.com/PharosNetwork/pharos-skill-engine
pnpm dlx skills add https://github.com/PharosNetwork/pharos-skill-engine
bunx skills add https://github.com/PharosNetwork/pharos-skill-engine
```

The linked public repository `https://github.com/PharosNetwork/pharos-skill-engine`
contains:

```text
SKILL.md
assets/       (network config, Solidity helpers)
references/   (query, transaction, contract, script-generation guidance)
```

Its `SKILL.md` begins with YAML front matter:

```yaml
---
name: pharos-skill-engine
description: >
  REQUIRED for any Pharos blockchain task. ...
version: 0.1.0
requires:
  anyBins:
    - cast
    - forge
---
```

That establishes the packaging contract used by this project:

- a skill is a directory with a `SKILL.md` carrying `name` and `description`
  front matter (the official skill also uses `version` and `requires`);
- supporting files live in the same directory and are referenced by relative
  path;
- distribution is a Git repository (or a local directory), installed with the
  `skills` CLI from `vercel-labs/skills` (`npm view skills version` returned
  **1.7.2**; its README explicitly lists **OpenCode** as a supported agent);
- invocation is by the local coding agent that has the skill installed. The
  `skills` CLI copies/symlinks the skill into that agent's skills directory.

The `skills` CLI documentation also confirms local-path installation:

```bash
npx skills add ./my-local-skills
```

### Packaging validation (observed)

The skill package was validated without installing it globally:

```powershell
npx --yes skills@1.7.2 add . --list
```

Observed:

```text
◇ Source: C:\pharos-saga-executor
◇ Local path validated
◇ Found 1 skill
◇ Available Skills
    pharos-saga-executor
      Run a resumable, receipt-verified APPROVE -> SWAP -> DEPOSIT workflow ...
```

This confirms that the `SKILL.md` front matter and repository layout are
recognised by the same `skills` CLI the Pharos Skill Engine page documents. The
command only listed the skill; no global installation was performed.

### What the environment does **not** support (observed gap)

- There is no documented or visible **custom skill upload/registration** flow in
  `ai.pharos.xyz`. The SPA's only skill route is the official Skill Engine page,
  which points at the official GitHub repository.
- `allowedAgentIds` in the bootstrap config was `[]`; the four agent IDs are
  fixed in the bundle. There is no fifth "bring your own skill" agent.
- The Pharos documentation inspected by earlier tasks does not document a
  registration API for third-party skills. Nothing in this project invents one.

**Consequence:** this project is delivered as an **installable skill repository**.
It can be installed into OpenCode (or another supported agent) from the local
path today, and from GitHub after publication. It is **not** registered inside the
hosted `ai.pharos.xyz` chat, because that workflow is not documented or exposed.
The exact installation command is in [README](../README.md) and [SKILL.md](../SKILL.md).

## 3. Authentication findings

Only unauthenticated inspection was performed.

### Guest bootstrap (observed)

```http
POST https://flow.anvita.xyz/api/v1/widget/bootstrap
Origin: https://ai.pharos.xyz
Referer: https://ai.pharos.xyz/
Content-Type: application/json

{"appKey":"agent_center","clientNonce":"inspect-saga-20261017-a"}
```

Observed: `HTTP 200`, `code:"000000"`, a guest access token (redacted, not
stored), `guestLimit: 10`, and a widget session with `remainingQuota: 10`.

### Guest scope limits (observed)

| Request | Result |
| --- | --- |
| `GET /api/v1/widget/account` with guest token | `HTTP 403` `WIDGET_TOKEN_SCOPE_FORBIDDEN` — "Scope GUEST not allowed" |
| `GET /api/v1/widget/onboarding/status` with guest token | `HTTP 403` — same scope error |
| `GET /api/v1/pharos/conversations/session` with guest token | `HTTP 401` — "Unauthorized, please login first" |

The site's own wallet sign-in and guardian EIP-712 onboarding flow is documented
in the read-only prior-task evidence at
`C:\pharos-doc-search-cli\README.md` and
`C:\pharos-docs-mcp-onboarding\docs\onboarding-log.md`. Chat requires an
`AUTHENTICATED` session. This task did not sign in because the Saga Executor
must not require a wallet, and the simulator needs no hosted chat.

**No session token, wallet file, private key or signature was copied into this
project.** No `.env` is needed or created.

## 4. Task page findings

`https://pharos-agent-arena.vercel.app/tasks/saga-executor` returned `HTTP 200`.
It describes the task as **Hard / SkillEngine / 200 points (+50 with video)** and
lists five reviewer requirements:

1. at least three dependent steps, each verified by a receipt before the next;
2. a defined retry policy for transient failures;
3. a defined compensation/rollback path for permanent failure, with a demo;
4. a state log showing the current step at all times;
5. one successful run and one forced-failure run with recovery.

The page's wording "rollback" is interpreted conservatively: on-chain state
cannot be globally rolled back, so this project implements **explicit
compensation**, never a fake rollback. See [architecture](architecture.md).

The submission page asks for a proof link, a repo link, and optionally a video.
Because this first iteration is explicitly simulated, there is no transaction
hash to submit as live proof. The honest proof is the repository, the demos, and
the test suite. See [verified-output](verified-output.md).

## 5. GitHub target check

```text
git ls-remote https://github.com/wyka0/pharos-saga-executor
remote: Repository not found.
fatal: repository 'https://github.com/wyka0/pharos-saga-executor/' not found
```

At inspection time the target repository **does not exist** (or is not public).
No repository was created and nothing was pushed. The local repository is
prepared with branch `main` and no remote push, as requested.

## 6. Existing Tasks 1–4 (read-only)

The following existing projects were inspected only as references, and were not
modified:

- `C:\pharos-doc-search-cli`
- `C:\pharos-docs-mcp-onboarding`
- `C:\pharos-event-log-monitor`
- `C:\pharos-ecosystem-asset-tracker`

They supplied the documented Agent Center transport, the four agent IDs, and the
official skill packaging examples. No file inside them was edited.

## 7. Implications for this implementation

| Finding | Decision |
| --- | --- |
| No custom skill registration endpoint | Ship as an installable `SKILL.md` repository; document the exact install command |
| Hosted chat requires wallet authentication | Do not integrate hosted chat; the executor is a local CLI/library |
| Official skill format uses `SKILL.md` front matter | Use the same format and keep the skill dispatchable by the `skills` CLI |
| Task demands 3 dependent steps + verification | Implement an explicit guarded state machine with receipt verification |
| No verified testnet adapter exists in this iteration | Use a deterministic simulated adapter behind a stable `ChainAdapter` seam |
| Real funds/wallet must not be touched | No RPC, no signing library, no key handling, no network dependency in `src/` |

## 8. Reproduction notes

The static inspection commands were read-only HTTP requests and `git ls-remote`.
The guest bootstrap response contained a token; it was printed only in redacted
form and was never written to disk. Anyone re-running the inspection should do
the same and must not commit captured tokens.

The project's own **simulation runtime** makes zero network calls. This was
checked by a static test (`test/safety.test.ts`) that rejects `http://`,
`https://`, `fetch(`, wallet/signing APIs, and key material in the simulation
surface. Files that are intentionally network-capable (the gated testnet
adapter/client, the test-only local Anvil adapter and the read-only deployment
plan script) are excluded from that specific scan and are instead covered by
dedicated isolation checks: no mainnet targets, no key literals, no send/sign
path in read-only tooling.

## 9. Local tooling environment (Task 5 continuation)

- OpenCode runs commands through **Windows PowerShell 5.1**.
- **Foundry is installed inside WSL Ubuntu** at `/home/wyka/.foundry/bin`
  (`forge`/`anvil`/`cast` **1.2.3-stable**, commit
  `a813a2cee7dd4926e7c56fd8a785b54f32e0d10f`). It is not installed on the
  Windows side, which is why Windows-direct invocations fail. All Solidity work
  uses absolute WSL paths via `wsl.exe -d Ubuntu -- ...`.
- **No PATH or shell startup files were modified.** One unrelated finding is
  reported but untouched: `/home/wyka/.bash_profile` references a missing
  `/home/wyka/.wasmedge/env`; this is not related to Foundry or this project.
- WSL interop expands `$PATH` from Windows before Bash sees it, which breaks
  one-liners on parentheses (e.g. `Program Files (x86)`). Use absolute paths
  and avoid `$PATH` expansions in `wsl.exe ... bash -c` strings.

Details and exact commands: [`local-anvil.md`](local-anvil.md).
