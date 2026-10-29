# Forge access — the code-forge proxy

Agents need to act on code forges (GitHub, GitLab): read repos, commit, open
pull/merge requests, comment. The naive way is to hand each agent a credential
and let it call the forge directly. That has three problems — every agent needs
its own account, every machine needs the secret copied to it, and a credential
in an agent's hands can be used however the agent (or a prompt injection) likes.

The **forge access proxy** solves all three. It is a service on the same
signed API as the mailbox: agents authenticate to it with their existing
Ed25519 identity, and it holds the forge credentials server-side and executes
*typed operations* on the agent's behalf. The agent never sees the credential.

- **`forge_repo`** — read a repo's default branch and head SHA.
- **`forge_fork`** — fork a source repo into the agent's own namespace.
- **`forge_sync`** — fast-forward a branch of the agent's fork to its
  upstream (GitHub). Never creates a commit.
- **`forge_commit`** — create a commit. Authorship is set server-side to the
  calling identity; the request carries no author field, so it cannot be
  forged.
- **`forge_open_pr` / `forge_comment`** — open a PR/MR or comment, with a
  footer attributing the acting identity.
- **`forge_provision`** — provision this identity on a forge that supports it
  (GitLab).

Two properties hold *by construction*, not by policy: commit authorship is
always the acting identity, and force-push / branch deletion do not exist in
the surface. `forge_sync` keeps both: it only ever fast-forwards a fork branch
to its upstream and never creates a commit — a branch the forge would have to
*merge* is refused before the forge is asked, so no commit under the shared
fork account can appear outside the authored commit path. On GitHub, commits
can also be cryptographically **signed** so they show the *Verified* badge
while authorship stays the agent — see [commit signing](commit-signing.md).

## The fork-and-PR model

Agents never write to a source repo. They **fork** it, commit to their **own
fork**, and open a PR/MR back:

```
forge_fork(source)  →  [forge_sync(fork)]  →  forge_commit(fork, …)  →  forge_open_pr(source, head=<fork>:<branch>)
```

(`forge_sync` is the optional step: call it when the fork may be behind.)

"No write to source" is enforced two ways: the credential is scoped to the
bot's fork namespace (it *cannot* write upstream), and a deterministic proxy
policy refuses any commit whose target isn't the identity's fork namespace (it
*won't*). That policy is the first rule on the guard-rail seam that a fuller
policy engine (scope allow-lists, rate limits, destructive-action gates) will
grow into.

A fork goes stale, and GitHub never syncs one on its own — so a PR opened
from an old fork gets an old base. The agent cannot fix that itself: it holds
no token, and even a fork-scoped token the operator might hand it could not
*read* a private upstream — so today only the operator, by hand, can give a
PR a fresh base. **`forge_sync`** closes that gap: the proxy already holds
the fork account's credential, so it asks GitHub to sync the fork branch from
upstream. Call it on the fork (owner = the fork namespace) before
`forge_commit` when the fork may be behind. It is a write to the fork, so the
same fork-namespace policy pins it. It only ever fast-forwards: GitHub's own
sync would *merge* a fork branch that has commits of its own (a merge commit
under the shared fork account, neither authored as the agent nor signed), so
the proxy compares the branch to its upstream first and refuses any branch
that is ahead — by any commit, conflicting or not — as `fork_diverged`
before GitHub is asked. Start a new branch from the fresh base instead. The
result's `mergeType` is `fast-forward` (the branch moved) or `none` (already
level); `merge` is kept in the type only so that, should a commit land
between the check and the sync, the ledger records the merge GitHub made
rather than hides it. GitLab has no equivalent and needs none: each identity
forks into its own namespace, so a stale GitLab fork is simply re-forked.

## Why GitLab beats GitHub for agents

Both forges work through the same proxy port, but GitLab fits autonomous agents
far better — because of how each platform treats machine accounts.

| | GitHub | GitLab |
|---|---|---|
| **Getting an account** | Blocked for automation. ToS + CAPTCHA force a human to create every account. | API-sanctioned: a group Owner token creates a **service account** via `POST /groups/:id/service_accounts`. |
| **Onboarding** | Human-in-the-loop for every agent. | **Self-onboarding.** The service account's email is the agent's own mailbox (`<id>@<domain>`), so GitLab's confirmation email arrives *in the agent's inbox* — the agent reads it with `wait_for_email` and follows the link. No CAPTCHA, no human. |
| **Credentials** | One shared PAT for all agents (fine-grained tokens can't even act outside their owner, so cross-owner fork→source PRs need a broad classic PAT). | **Per-identity.** Each agent gets its own service-account PAT, minted and stored per identity. |
| **Fork isolation** | All agents share one fork account — they share fork repos and must use distinct branch names. | Each agent forks into its **own namespace**; no sharing. |
| **Attribution** | Commits show the one shared account; per-agent attribution lives only in the proxy audit log. | Each service account is a distinct GitLab user — attribution is native. |

The headline: **on GitLab an agent can go from "just an identity" to "a
working forge account" entirely on its own** — provision, receive its own
confirmation email, confirm, and start opening MRs — with no human step. On
GitHub, a person must still create each account by hand (the one step ToS and
CAPTCHA reserve for humans), after which the agent takes over. GitLab's Free
tier allows 100 service accounts per top-level group, which is plenty for a
fleet.

## Operator setup (brief)

The proxy reads credentials from SSM (`/agent-identity/forge/…`), granted only
to the proxy Lambda. Enable an identity with `mailctl agent tag <id>
github|gitlab`.

- **GitLab:** store a group **Owner** token at `.../gitlab/admin-token` and the
  numeric group id at `.../gitlab/group`. Agents then self-provision via
  `forge_provision`.
- **GitHub:** store a fork-namespace-scoped PAT at `.../github/pat`, deploy with
  `-c githubForkOwner=<bot-login>` (GitHub commits fail closed until it is set),
  and create each account human-assisted (see [GitHub onboarding
  flow](../README.md#github-onboarding-flow)).
- **Commit signing (GitHub, optional):** make agent commits show GitHub's
  *Verified* badge — author stays the agent, a bot account signs — by
  configuring an ed25519 signing key. See [commit signing](commit-signing.md).

The original design specs live under [`docs/internal/`](internal/) —
historical internal planning documents, possibly stale, kept for provenance.
This document is the current adopter-facing description.
