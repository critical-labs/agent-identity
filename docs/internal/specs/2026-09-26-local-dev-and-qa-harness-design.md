# Local dev server and side-by-side PR QA

**Date:** 2026-09-26 (C2 revised 2026-09-29) · **Status:** approved design. C1 merged (#133).

## Goal

A reviewer should be able to try a pull request against real fleet data before merging it. They open two copies of agent-identity side by side (**base** = `main`, **PR** = the branch), each with its own API, fleet dashboard and database, and they post a verdict (a comment plus a label) back to the PR.

The harness is [`@critical-labs/qa-conductor`](https://github.com/critical-labs/qa-conductor). It owns sessions, the harness UI, the mirrored pane proxies and verdicts, and it reaches the app only through five adapters. agent-identity is its second consumer, after homefree. This design specifies agent-identity's side: a local dev server (C1) and the QA adapters (C2).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where panes run | Locally, on the reviewer's machine, as processes | agent-identity has no staging or preview environment, and there is no Docker locally. Remote hosting is a later stage. |
| Database per pane | **DynamoDB Local**, the official emulator (Java), started with `-inMemory -sharedDb -disableTelemetry` | dynalite lacks `TransactWriteItems`, which registration and mailbox creation use. |
| Pane shape | One process per pane: a **dev server** that serves the API at its normal paths and the fleet dashboard at `/ui/` | A single origin means no CORS problem and no path prefix, so signed requests are unchanged. The server lives in the app, so it versions with the code. |
| Data | Real prod table, scanned read-only once per session, **mail redacted**, held in memory only | QA against realistic data, while mailboxes can hold live credentials. |
| Where adapters live | This repo, `packages/qa`, on qa-conductor 0.2.0's built-in `build-worktree` and `provisioner-process` | Consumers own their app-specific adapters; the generic process and git-worktree pieces live in qa-conductor. |
| Whose PRs can boot | Authors with write access to this repo, **plus `trust.logins: ['critical-agent-zero']`** | The agent contributes fork-and-PR with read-only access, and must stay that way. `trust.logins` is a local decision about running its code; it grants nothing on GitHub. |
| Network exposure | DynamoDB Local listens on every interface (it has no bind option). `pnpm qa` refuses to start unless the macOS firewall blocks inbound connections to the Java binary it runs. | Panes hold redacted but real fleet data, including activity for private repos. |

## C1: local dev server (`pnpm dev`), merged in #133

C1 is useful without QA: it's the first way to run the API and dashboard locally.

- **`packages/api/src/deps.ts`:** `buildDeps({ env, ddb, readBody })` turns env vars into `Deps`. The rules are the ones `lambda.ts` had: `TABLE_NAME` and `MAIL_DOMAIN` are required, `RETENTION_DAYS` defaults to 90, `FLEET_KEY_REQUIRED` is on unless set to exactly `false`, and `PUBLIC_REPOS` / `AUTO_CAPABILITIES` fail closed when empty. `lambda.ts` is a thin caller, so the Lambda and dev entries can't drift.
- **`packages/api/src/dev-app.ts`:**
  - `createDevApp(deps, { uiFile })` answers `GET /ui` (redirect) and `GET /ui/` (the dashboard, read on every request) **before** mounting `createApp(deps)` at `/`, and adds the GET CORS headers API Gateway adds in production.
  - `ensureTable(client, tableName)` creates the table from the shared `TABLE_KEYS` if it's missing. A stack test ties `TABLE_KEYS` to the CDK table.
  - `assertLocalEndpoint(env)` refuses to run without `AWS_ENDPOINT_URL_DYNAMODB` or `AWS_ENDPOINT_URL`.
- **`packages/api/src/dev.ts`** is the entry point. It serves on `127.0.0.1:${PORT ?? 8787}`.

## C2: QA adapters (`packages/qa`, private workspace package)

`pnpm qa` starts the conductor locally: the harness on `127.0.0.1:3100` and the panes on `3101` / `3102`. `pnpm qa:setup` installs DynamoDB Local once. The package depends on `@critical-labs/qa-conductor` from git at `v0.2.0`.

### Modules (`packages/qa/src/`)

- **`config.ts`:** loads `.env.qa` at the repo root, or `QA_ENV_FILE`, through qa-conductor's `loadConfig`, with these defaults:
  - `QA_REPO=critical-labs/agent-identity`;
  - `QA_BASE_ORIGIN=http://127.0.0.1:3101` and `QA_PR_ORIGIN=http://127.0.0.1:3102`.

  App keys come from `cfg.env`:
  - `QA_MAIL_DOMAIN` (optional override). The panes need the prod mail domain so the fleet mail redaction behaves as in prod, and by default `snapshot.ts` derives it from the agents' addresses, so a reviewer doesn't supply it. When set, it wins over the derived domain. It must be a bare, lower-case domain name (`isMailDomain`: labels of `[a-z0-9-]`, not starting or ending in `-`, joined by at least one dot, at most 253 characters, with no scheme, port, path or `@`); otherwise the config check fails with an error that doesn't echo the value, since logs may be pasted publicly (revised 2026-09-29: it was required);
  - `QA_PUBLIC_REPOS` and `QA_AUTO_CAPABILITIES` (optional);
  - `QA_TRUSTED_LOGINS`, comma-separated, defaulting to `critical-agent-zero`;
  - `QA_BASE_REF`, defaulting to `main`;
  - `QA_STACK_NAME`, defaulting to `AgentIdentity`;
  - `QA_AWS_REGION` (optional; the prod stack's region for the snapshot, see `snapshot.ts`). It must look like a region (`^[a-z]{2}(-[a-z]+)+-\d+$`), so a value that isn't one fails at `pnpm qa`'s config check rather than at the first pane's snapshot. qa-conductor's env parser keeps an inline `# comment` as part of the value, so the README's `.env.qa` template puts every comment on its own line.

  The GitHub token must be able to comment and label on this repo. It's the reviewer's token, **not** the agent's, since the agent is read-only.
- **`dynamodb-local.ts`:** the `database` plugin for `createProcessProvisioner`, plus install helpers.
  - The home is `${cacheDir}/dynamodb-local`, holding the extracted tarball. `DDB_LOCAL_SHA256` pins the tarball checksum, and `pnpm qa:setup` refuses a download that doesn't match.
  - **`DDB_LOCAL_FILES`** (`dynamodb-local-files.ts`) pins, in source, the SHA-256 of every file the pinned tarball extracts, by relative path: the jar, every `DynamoDBLocal_lib` jar its manifest's `Class-Path` names, and the native sqlite4java libraries loaded through `-Djava.library.path`. It is bumped together with `DDB_LOCAL_SHA256`. (Revised after review: the first version hashed only the jar, against a checksum stored next to it in the install marker, and only at `pnpm qa` start. Whoever could replace the jar could rewrite that record too, the libraries were never checked, and a file changed during a session ran unchecked in the next pane.)
  - The install marker (`.sha256`, written last) records the tarball pin and marks the install complete; it vouches for nothing else.
  - `checkInstall(home, { sha256, files, hashFile })` passes only when the marker names the pinned tarball and the home holds exactly the files in `DDB_LOCAL_FILES`, each re-hashed and matching. Any other file or directory is refused, since the jar's `Class-Path` includes `.` (the home itself) and `log4j2.xml`, and so is anything that isn't a plain file or directory, such as a symlink. `files` and `hashFile` are injectable for tests.
  - It runs at `pnpm qa` start and again before each pane's emulator starts: `createQaAdapters` wraps the provisioner's `provisionDatabase` with it, because `database.command` is synchronous. A pane's code runs as the reviewer's user and could change the home during a session. `pnpm qa:setup` reinstalls whenever the check fails. A same-user process could still swap a file between the check and Java reading it; the check catches a tree changed at rest, not that race.
  - `installDynamoDbLocal` checks the extracted tree against `DDB_LOCAL_FILES` before it replaces the old install, so a pin bumped without its manifest fails at setup.
  - `javaBinary()` resolves the **real** binary (`$(/usr/libexec/java_home)/bin/java` on macOS, rather than the `/usr/bin/java` stub, so the firewall rule and the process agree). It requires Java 17 or later.
  - `command({ port })` → `{ cmd: javaBinary, args: ['-Djava.library.path=<home>/DynamoDBLocal_lib', '-jar', '<home>/DynamoDBLocal.jar', '-inMemory', '-sharedDb', '-disableTelemetry', '-port', String(port)], cwd: home }`.
  - `ready({ port, signal })` polls `ListTables` with a short per-call timeout until it succeeds or the signal aborts.
  - `handle({ port })` → `{ dsn: 'http://127.0.0.1:<port>', db: { endpoint, tableName: 'agent-identity-qa', region: 'us-east-1' } }`.
  - `localClient(db)` builds a `DynamoDBClient` with that endpoint, region `us-east-1` and the fixed dummy credentials `local` / `local`. Every harness-side call uses it, and the pane env uses the same values. With `-sharedDb`, credentials don't partition the data anyway. It refuses any endpoint that isn't loopback `http:`, so a harness-side write can never reach a real table.
- **`firewall.ts`:** `assertJavaInboundBlocked(javaBinary)`.
  - On `darwin`, it runs `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` and `--getappblocked <java>`. The firewall must be enabled and the output must say the app is blocked. Otherwise it throws an error containing the exact `sudo socketfilterfw --add … --blockapp …` commands to run. Parsing is a pure function with tests.
  - On other platforms it throws "unsupported platform: bind a host firewall rule for DynamoDB Local and set QA_ALLOW_UNFIREWALLED=1". The environment variable is the explicit override.
- **`snapshot.ts`:** `loadSnapshot({ stackName, cfn, ddb })`.
  - It gets the table's physical name from CloudFormation (`DescribeStackResources`, logical id starting `Table`), then runs a **read-only** paginated `Scan`.
  - It returns `{ items, dropped, droppedAttributes, mailDomain, mailDomainCounts }`: the items after `redactItem`, held only in memory, the drop report (see `redact.ts`), and the fleet mail domain. `createSnapshotLoader` hands each snapshot to an `onLoaded` callback once, which `serve.ts` uses to log `describeSnapshot`.
  - **`deriveMailDomain(items)`** takes the kept agent records (`AGENT#…` + `AGENT`) and, for each `address`, the text after its last `@`, lower-cased (ASCII only) and valid by `isMailDomain`, after a non-empty local part. Invalid addresses don't count. `mailDomain` is the most common domain when it covers more than half of the agents with a valid address; with no valid address, a tie or a plurality short of a majority, it is `null`. `mailDomainCounts` holds `{ matching, addresses }`.
  - **The domain is never logged**: logs may be pasted publicly. `describeSnapshot` ends with `mail domain: derived from N of M agent address(es)`, `not derivable (…)` with the count, or `set by QA_MAIL_DOMAIN` when the override is set.
  - It runs once per conductor process and is memoized: the first call (normally the first pane's seed) triggers it, and `readBaseEnv` and later sessions reuse it until restart. Clients use the default credential chain, which is the reviewer's AWS profile. The region comes from `QA_AWS_REGION` when set; otherwise it comes from the default chain. The prod stack's region is the deploy workflow's `AWS_REGION` variable, and the default chain may not match it.
- **`redact.ts`:** `redactItem(item)`, a pure function returning the item to keep or `null`. **It fails closed at both levels: item shapes, and each shape's attributes, are allowlists.** (Revised after review: the first version copied unknown item shapes and masked only ASCII digit runs, which let common code formats through; a later version still copied every attribute of the four non-mail shapes.)
  - **Item shapes, keyed on (`PK` prefix, `SK`), matching every writer in the repo** (`api/src/db/*`, `admin/src/commands.ts`):
    - `AGENT#…` + `AGENT`: an agent, keeping the `AgentRecord` fields (`agentId`, `address`, `publicKey`, `status`, `createdAt`, `capabilities`, `mailbox`, `allowlist`, `catchAll`);
    - `ADDR#…` + `ADDR`: an address mirror, keeping `fingerprint`;
    - `AGENT#…` + `ACT#…`: activity, keeping the `ActivityEvent` fields (`agentId`, `ts`, `class`, `type`, `summary`, `detail`, `ref`) and the TTL `expiresAt`;
    - `AGENT#…` + `STATUS`: status, keeping the `AgentStatus` fields (`state`, `label`, `updatedAt`);
    - `MAILBOX#…` + `EMAIL#…`: an email, redacted as below.
    - **Every other shape is dropped.** That covers `FLEET#`, `ADMINKEY#`, `VIEWER#` and `NONCE#` today, and any future record type. `loadSnapshot` reports how many items it dropped, per `PK` prefix and `SK` prefix (the text up to and including the first `#`), so a new legitimate type is noticed and added deliberately. Values are never logged.
    - Every shape also keeps `PK` and `SK`, and **drops any attribute it doesn't list**, so a field added to a record later (a webhook secret, a key hash, a session token) never reaches a pane by default. The lists are typed against `AgentRecord`, `ActivityEvent`, `AgentStatus` and `NewEmail`, so a renamed field fails to compile. `unlistedAttributes(item)` names what was dropped without being known (emails' rewritten and removed attributes are known), and `loadSnapshot` counts those names per shape in `droppedAttributes` (`AGENT#/AGENT .webhookSecret ×3`), so a new legitimate attribute is added deliberately. A name that isn't a camelCase identifier is reported as `?`.
    - Audited against the writers on 2026-09-29: besides the five listed shapes, the repo writes only `FLEET#…` + `FLEET`, `ADMINKEY#…` + `ADMINKEY`, `VIEWER#…` + `VIEWER` (key hashes, `admin/src/commands.ts`) and `NONCE#…` + `SIG#…` (replay nonces, `api/src/db/nonces.ts`), all dropped. `UpdateCommand`s touch only `AGENT#…` + `AGENT`.
    - In the drop report, a key part with a `#` is reported up to and including the first `#` when that prefix is an upper-case type tag (`NONCE#/SIG#`). A part without a `#` is reported whole only when it's one of the tags the repo writes (`AGENT`, `ADDR`, `STATUS`, `FLEET`, `ADMINKEY`, `VIEWER`; others are added to `KNOWN_TAGS` on purpose), because an upper-case whole key can't be told from an upper-case value such as a letter-only code. Anything else could be a value and is reported as `?` (`OTP#/?`, `MAILBOX#/?`). `pnpm qa` logs the report once per snapshot.
  - **Emails:**
    - kept: `PK`, `SK`, `id`, `messageId`, `from`, `receivedAt`, `rawS3Key`, `auth`, `unsolicited` and `expiresAt`, plus `subject` masked as below;
    - replaced: `text` becomes `[redacted for QA]`, and `links` becomes `[]`;
    - removed: `html`, `bodyS3Key` and **any attribute not in the keep list**.
  - **Subject masking works on whitespace-separated tokens: keep plain words, mask everything else.** (Revised after review: a rule that masked only tokens with a digit or a host/path shape let letter-only codes such as `XKQ-RPT`, `QWERTY` or `dog-cat-fish` through; about 1 in 7 random 6-character `[A-Z0-9]` codes has no digit.) A token is kept only when its NFKC form is:
    - a plain word, `^[("'“‘]*\p{Lu}?\p{Ll}+(?:['’]\p{Ll}+)?[)"'”’.,:;!?]*$`: lower-case letters, optionally after one capital and with one inner apostrophe, in optional quotes or brackets and with optional trailing punctuation (`Welcome`, `don't`, `world.`, `(aside)`);
    - a single capital letter (`I`, `A`);
    - or punctuation only, with no letter or number (`—`, `&`, `-`).

    Every other token becomes `••••`. So `Your verification code is 123 456` becomes `Your verification code is •••• ••••`, `Sign in at login.example.test/magic/k9F` becomes `Sign in at ••••`, `Your code is XKQ-RPT` becomes `Your code is ••••`, and `Welcome to the fleet` is unchanged. Numbers, all-caps and mixed-case tokens are masked too, acronyms and `[GitHub]` included, so `PR #12 merged` becomes `•••• •••• merged`; that's an accepted loss of fidelity. Checking the NFKC form means full-width and other compatibility forms count as what they stand for (`１２３` is a number, `ⓍⓀⓆ` capitals).
    - **Known gap:** a code made of one lower-case or capitalised word (e.g. `kxqprt`) is kept, since it can't be told from a word without a dictionary.
  - Tests include a "nothing sensitive survives" property:
    - no original `text`, `html` or link;
    - no subject token that isn't `••••` or allowed by the rule above (restated in the test, not imported), and no generated code anywhere in the subjects;
    - no item of an unlisted shape;
    - the corpus includes `123 456`, `123-456`, `12 34 56`, `1.2.3.4.5.6`, `X4K-9PQ`, `AB12CD`, full-width digits, random letter-only codes (`[A-Z]{3}-[A-Z]{3}`, `[A-Z]{6}`, `[A-Z]{4}-[A-Z]{4}`, lower-case `word-word-word`) and scheme-less links.
- **`seed.ts`:** `createSeed({ snapshot })` → `{ databases: ['agent-identity-qa'], seedPane({ db }) }`. It runs `ensureTable(localClient(db), db.tableName)`, then batch-writes in chunks of 25, retrying `UnprocessedItems` with backoff and failing after a bounded number of attempts.
  - `ensureTable` is imported from `@agent-identity/api`, which exports it along with `TABLE_KEYS`, so the seed and the dev server share the schema code.
  - **Known limitation:** the seed runs in the harness, so it creates the pane table with the harness checkout's `ensureTable` (the schema from `main`, normally). The pane's own dev server starts afterwards, and its `ensureTable` is a no-op on an existing table. A PR that changes the key schema therefore runs against the old schema, and its QA needs the pane table recreated with the PR's schema. The harness doesn't do that yet.
- **`env.ts`:** `derivePaneEnv({ prodEnv, pane })` → `{ api: {…} }`, with exactly these keys:
  - `PORT`: from `pane.services.api.port`;
  - `TABLE_NAME=agent-identity-qa`;
  - `AWS_ENDPOINT_URL_DYNAMODB`: `pane.dsn`;
  - `AWS_REGION=us-east-1`, `AWS_ACCESS_KEY_ID=local`, `AWS_SECRET_ACCESS_KEY=local`;
  - `MAIL_DOMAIN`, `PUBLIC_REPOS` and `AUTO_CAPABILITIES`: from `prodEnv`;
  - `FLEET_KEY_REQUIRED=true`.

  `readBaseEnv` supplies `prodEnv` from config and the snapshot's mail domain (see `adapters.ts`). `derivePaneEnv` still refuses a `prodEnv` without `MAIL_DOMAIN`. The pane never sees the harness's environment, because qa-conductor's provisioner passes only `PATH` plus this map.
- **`auth.ts`:** `requiresDb: true`. `establishSession({ pane, db })` works like this:
  1. Mint `randomBytes(32).toString('hex')`.
  2. `PutItem` `{ PK: 'VIEWER#' + sha256hex(key), SK: 'VIEWER', label: 'qa', createdAt }` into the pane table via `localClient(db)`. This must be the same hash scheme as `AgentsRepo.verifyViewerKey`; a test asserts it round-trips through the real repo.
  3. Return `{ landingUrl: \`${pane.publicOrigin}/ui/?api=${encodeURIComponent(pane.publicOrigin)}#key=${key}\` }`. The harness appends `&qa=…` to the fragment, and the dashboard reads `#key` with `URLSearchParams`.
- **`adapters.ts`:** `createQaAdapters({ cfg, github, cacheDir, java, onSnapshot?, verifyInstall? })` → `{ adapters, readBaseEnv }` composes everything. `java` is the binary `javaBinary()` resolved (the one the firewall check passed), because the provisioner calls `database.command` synchronously while resolving Java is async:
  - **build:** `createWorktreeBuild` with:
    - `repo`, `cacheDir: <cache>/build`, `github`, `baseRef`;
    - `trust: { logins: <QA_TRUSTED_LOGINS> }` (the other trust defaults stay: associations plus `requirePush`, and forks allowed);
    - `install: { cmd: 'npx', args: ['-y', 'pnpm@9.15.9', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'] }`, the same pnpm major as CI;
    - `servicesFor: dir => ({ api: dir })`.
  - **provisioner:** `createProcessProvisioner` with:
    - `stateDir: <cache>/state` and `database: <dynamodb-local plugin>`;
    - `command: ({ ref, port }) => ({ cmd: join(ref, 'node_modules/.bin/tsx'), args: ['packages/api/src/dev.ts'], cwd: ref })`. This is direct, never through pnpm, per the launch contract.
    - `healthPath: '/ui/'` and `healthy: s => s === 200`.

    Its `provisionDatabase` is wrapped to run `verifyInstall` first (by default `assertInstalled` on the DynamoDB Local home), so no pane's emulator starts from a changed install. Every other provisioner method passes straight through.
  - **seed, envTransform, auth:** from the modules above. The seed gets the items of the one memoized snapshot loader, which `readBaseEnv` shares.
  - **`readBaseEnv`:** `PUBLIC_REPOS` and `AUTO_CAPABILITIES` from the config. `MAIL_DOMAIN` is `QA_MAIL_DOMAIN` when set (without waiting for a scan), else the memoized snapshot's `mailDomain`: `readBaseEnv` awaits the same loader as the seed, so it doesn't depend on the conductor seeding first, and prod is scanned once either way. When neither exists, it throws `the mail domain is not derivable (…): set QA_MAIL_DOMAIN in .env.qa and restart pnpm qa`, which fails that boot.
- **`serve.ts`:** the `pnpm qa` entry.
  1. Load the config, then run `assertJavaInboundBlocked` and check the DynamoDB Local install against `DDB_LOCAL_FILES`. Each failure prints how to fix it and exits non-zero. A missing `QA_MAIL_DOMAIN` is not a failure: the domain comes from the snapshot.
  2. Create the GitHub client with qa-conductor's `createGithub` and the configured labels.
  3. Start the conductor, and on SIGINT, SIGTERM or SIGHUP `await shutdown()`.
  4. Print the harness URL.
  5. When the first pane's seed loads the snapshot, log one line with the kept count, the drop report (dropped items per shape, and unlisted attributes dropped from kept items) and where the mail domain comes from (counts only, never the domain).
- **`setup.ts`:** the `pnpm qa:setup` entry. Unless `checkInstall` passes, it downloads the DynamoDB Local tarball from AWS's official URL, verifies `DDB_LOCAL_SHA256`, extracts it into the cache, checks every file against `DDB_LOCAL_FILES` and writes the marker. It then prints the firewall commands if the rule is missing.
- **`qa-conductor.d.ts`:** minimal ambient module declarations for the qa-conductor specifiers used, since qa-conductor ships plain JS. This keeps the root `tsc --noEmit` green.
- **Root scripts:** `"qa": "tsx packages/qa/src/serve.ts"` and `"qa:setup": "tsx packages/qa/src/setup.ts"`. `.env.qa` is gitignored.
- **README:** a "Side-by-side PR QA" section covering setup (including the jar checksum), the firewall step, `.env.qa` (including `QA_AWS_REGION`, and `QA_MAIL_DOMAIN` as an optional override of the derived mail domain, which is never logged), `pnpm qa`, the trust model (write access or `QA_TRUSTED_LOGINS`, and the caveat that logins can change hands), what the redaction keeps and drops, and the table-schema limitation.

### Lockfile

Add dependencies with `npx pnpm@9.15.9`. The lockfile diff must contain only the new importer and package entries; restore any unrelated `libc:` lines that pnpm 9 strips. CI's `pnpm install --frozen-lockfile` must pass.

### Security summary

- The trust gate (in qa-conductor) is the boundary: write access, or listing in `QA_TRUSTED_LOGINS`, plus a head in this repo or the author's own fork.
- `trust.logins` is keyed on GitHub logins, which can be renamed and later registered by someone else. The README says to keep the list short and review it; write access remains the default gate.
- Installs skip scripts and pnpmfiles.
- Panes run with only `PATH` plus their declared env, and bind to loopback. DynamoDB Local is covered by the enforced firewall rule. Its tarball is checksum-pinned, and every file it extracts is pinned in source and re-checked, with no extra file allowed, at `pnpm qa` start and before each pane's emulator starts.
- Real AWS credentials exist only in the harness process, for one read-only Scan. The snapshot is redacted before it's written anywhere and is never persisted.
- The prod mail domain, derived or overridden, goes to the panes only as `MAIL_DOMAIN`. No harness log line or error names it: the summary gives counts, and an invalid `QA_MAIL_DOMAIN` is refused without echoing it. (A pane's own code runs as the reviewer and could print its env; that is the trust gate's concern.)

## Testing

- **C1:** merged with 16 new tests, and checked end to end in the browser.
- **C2:** vitest unit tests for:
  - `redactItem`, including the "nothing sensitive survives" property;
  - `derivePaneEnv`, with its exact key set;
  - key minting round-tripping through the real `AgentsRepo.verifyViewerKey`, with `aws-sdk-client-mock`;
  - the seed's batching and `UnprocessedItems` retry;
  - the snapshot table lookup and pagination;
  - the mail domain: derivation (majority, plurality, tie, no address, invalid addresses, agent records only), `QA_MAIL_DOMAIN` validation and precedence, `readBaseEnv` sharing the seed's snapshot, the error when the domain can't be derived, and that no log line names the domain;
  - the firewall output parser;
  - the DynamoDB Local command, ready check and handle;
  - the setup checksum check, and the install check against a pinned manifest: changed, missing, extra and symlinked files, a rewritten marker, and the check before each pane's emulator (on real temp trees, with an injected manifest and hash);
  - the adapter composition (trust logins, install command, launch command).
- **C2 end-to-end (manual):** boot the C2 PR itself (by `critical-agent-zero`, from its fork) against `main`, then:
  - check that both dashboards list the real agents and that mail shows no bodies or links;
  - check that mirroring works;
  - tear down, and confirm no Java or dev-server processes remain.
