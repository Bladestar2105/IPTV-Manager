# Optional AI assistance

AI is disabled on new and upgraded installations. Existing playback, playlists,
EPG and provider sync work without an AI connection. Enable a small group of
test users and individual functions before a broader rollout.

## Setup

1. Open **AI** in the Web UI as an administrator. Enable the server policy,
   select allowed users by name and allowed functions, and decide whether users may configure
   their own connections.
2. Either create an administrator connection and share it with selected users,
   or let an allowed user create a private connection. Users explicitly enable
   AI in their own preferences. A shared connection needs no user-supplied URL,
   key or model ID.
3. Enter the API base address and, where required, its key. Check the displayed
   destination before requesting discovery or a test. Entering or saving an
   address makes no network request. Custom proxy prefixes are preserved;
   known `/models` and `/chat/completions` suffixes are normalized.
4. Discover models, then select and test up to three candidates. Tests send only synthetic
   text and can incur provider charges. Select the tested recommendation or
   another tested model and finish setup. If model discovery is unavailable,
   use a manual model ID and explicitly test it.
5. As an administrator, select the library user by name (leave it empty only
   for global diagnosis). Choose a function, describe the task, and inspect the result. List changes
   require selection and confirmation of the stored before/after proposal.
   Applying or undoing a proposal does not call a model.

User access lists support multiple selections with Ctrl/Cmd-click. Empty access
lists grant no users access. Previously saved selections that no longer appear
in the administrator user list are labeled unavailable rather than silently
removed; they can be deselected. API requests continue to use numeric IDs, and
current permissions are still checked by the server.

The UI supports German, English, French and Greek. Language and IANA timezone
are personal preferences. The advanced token option selects `max_tokens` or
`max_completion_tokens`. Changing the API address or key invalidates model
compatibility and selection. A manual profile change also invalidates them,
unless you explicitly adopt a model successfully tested with that exact profile.
Model recommendations reflect observed compatibility, not a price/quality
ranking. There is no automatic fallback to a different provider or credential.

### Model discovery and bounded compatibility tests

The selected model, including a personal selection on an owned connection,
survives discovery refreshes. A removed ID remains visible as **not in the
current model list** until explicitly changed. Testing another model does not
replace a saved selection. A sole successful candidate can be adopted without
typing its ID; finishing setup confirms the model and tested token profile.

Documented provider profiles are handled as follows:

| API profile | Discovery and request behavior |
| --- | --- |
| OpenAI's [model list](https://developers.openai.com/api/reference/resources/models/methods/list) | IDs do not prove chat or schema support. Multiple unknown candidates require selection; neither model names nor list order imply suitability. |
| OpenRouter's [model metadata](https://openrouter.ai/docs/guides/overview/models) | Valid `architecture.input_modalities` and `output_modalities` containing text suggest candidates. Only this bounded hint and the ID are retained; a successful request test is still required. Compatible proxies exposing this metadata use the same rule. |
| Chat Completions token profiles | [OpenAI documents](https://developers.openai.com/api/reference/resources/chat) `max_completion_tokens` (including reasoning tokens), and deprecates `max_tokens`, which some reasoning models reject. Other compatible servers may require `max_tokens`. Both are tested under the rule below, without changing the configured endpoint or identity. |
| Unknown aliases or proxies | Remain selectable and testable, including through the manual ID field. Missing metadata is unknown, not evidence of incompatibility. |

Setup and request controls show their current status beside the action, with a
spinner while a request is queued or running. Model-test selection is validated
before saving preferences, keys or connection sharing. Rejected empty or oversized
selections leave those settings unchanged. If a status read fails, use **Refresh
status** beside the request controls to resume polling the same job. This only
reads status and never submits a new model request. A cancellation that reaches
the server after completion displays the actual completed result or failure.

Each explicit test accepts at most three model IDs. Per model it sends one
plain JSON request, then one structured-output request if plain JSON passed.
**Only** an explicit HTTP 400/422 rejection identifying the submitted token
parameter as unsupported/unknown permits one alternate parameter probe before
the structured check. A rejected parameter value, ambiguous response, timeout,
5xx or authorization failure never triggers that probe. The bound is three
requests per model, nine per batch, with 128 output tokens per request; all
attempts consume the existing local call budget and may incur provider charges.
There is no automatic budget increase. An incomplete answer stays **unverified**,
including when a model needs more reasoning tokens than this test allows.

Each connection retains at most 100 tested model profiles. The connection's
selected model and its owner's current personal selection are protected;
unselected older profiles are removed only to make room for newly tested IDs.
Retesting existing IDs replaces their profiles without evicting unrelated ones.
Removed profiles can be tested again explicitly. Legacy oversized maps are
bounded on reads without database writes, then trimmed on the next connection save,
discovery refresh or completed test. Model IDs returned by discovery remain
separately bounded to 500 and do not replace the selected model. Every accepted
connection write advances its version, including discovery, test results and
model-unavailability records. Stale concurrent results are rejected.

Explicit chat/schema incompatibilities are recorded separately from model
availability, authentication, permission, rate-limit and connection failures.
Plain JSON success with rejected schema support is a usable JSON fallback.
Choose another batch explicitly after incompatible candidates; those rejections
do not trip the connection outage breaker. Authentication, permission, rate
limits and real outages stop the batch. Provider error bodies are never exposed
or persisted. A tested alternate token profile takes effect only on explicit
adoption; an in-use model is never silently switched to it.

For an EPG description, choose the channel, load its available programs, and
select the actual program as the text source. Loading this local source list
does not call the model. Movies and series can use their original description.

## Functions

| Function | Behavior |
| --- | --- |
| List assistant | Proposes categories, personal names, assignments and order changes using the user's authorized editor catalog. Existing radio categories accept live provider sources, following the normal list editor. |
| Cleanup | Proposes personal/category renames, hiding and order cleanup; never creates assignments or EPG mappings. Confirmed literal name transformations can become reusable rules. |
| Duplicates | Groups local identities and name variants, shows uncertainty, and proposes hiding entries. Reachability and picture quality require separate measured evidence. |
| EPG | Runs local matching first, presents existing source candidates and program evidence, and protects manual mappings unless explicitly selected. |
| Sync report | Explains a recorded successful before/after difference. Counts come from actual changes; missing or incomplete history is not reconstructed. |
| Search | Converts requests and follow-ups into visible filters, then searches the current authorized catalog and EPG locally. New Search clears the conversation. |
| Diagnosis | Reads assignment, visibility, local account export filters, configured EPG mapping and recorded user-connection limits. Separates observations, possible explanations and unimplemented measurements; no repairs. Administrators may request aggregate findings without selecting a user. |
| Text | Translates, summarizes or tags an existing description. The original remains intact and the marked AI version is invalidated when its source changes. |

Sync counts cover the complete recorded difference after current authorization
filtering. The model and UI receive at most 20 detail rows, with separate
shown/total/partial preview metadata. Authorization changes anywhere in that
difference invalidate the result, including changes outside the preview.
Results stored with the earlier snapshot-only evidence hash become stale and
require a new analysis; the underlying snapshots are preserved and no model
request is automatically replayed.

Normal users keep their existing list-editing rights with `provider_access=0`.
AI cannot grant access, change provider URLs or security settings, delete global
providers, or execute SQL, scripts or arbitrary tools. Applied list changes use
the normal shared database and assignment origins; they are visible through
the existing M3U, Xtream and Stalker outputs.

Manual names, hidden rows and pinned positions are protected unless explicitly
selected for editing. Proposals carry exact source state and dependencies.
Stale proposals and undo conflicts require a fresh review; Undo does not
restore a whole backup or overwrite intervening user edits.

Reading a completed job, applying a stored proposal and saving confirmed
literal rules are local operations. They require current account/Web UI access,
enabled server/personal AI and the relevant feature permission, but can continue
after a connection or
selected model is removed or disabled. Completed result reads do not require
the former connection sharing grant or connection-specific feature access;
current server/user feature permissions and source rights still apply. They
make no inference request. Source, ownership, confirmation and conflict checks
still apply.

Existing channel, assignment and category IDs returned by the model must belong
to the exact request batch, even when omitted entries belong to the same user.
Sync proposals use only their supplied current candidates, and EPG proposals
use only their supplied channel cases and mapping candidates. Valid dependencies
on newly proposed categories remain available regardless of their declaration
order in the response. Category creation precedes dependent actions in the
preview; other action order is preserved. References to earlier batches must
be present in the planned-category context actually supplied to the model.

The output schema, proposal creation and Apply share a closed action contract:
`list` allows category creation/renaming, assignment, personal renaming, hiding
and reordering; `cleanup` allows only renaming, hiding and reordering;
`duplicates` only hiding; `epg` only EPG mapping; and `sync` category creation,
assignment and personal renaming. Read-only functions have no mutation actions.
Apply validates **every stored action**, including unselected actions in legacy
proposals, before any write and rechecks the current feature permission. EPG
actions always require the EPG feature and current channel/source/program
evidence. Full reorder transactions and conflict-protected Undo remain atomic;
Undo cannot restore revoked rights or add actions.

### Local diagnosis coverage

Select an allowed provider channel ID or list-entry `selected_ids` to diagnose
an individual entry. Own editable hidden assignments are included when selected;
foreign or revoked content is rejected. Local findings include assignment and
hidden status; eligibility in the account catalog; stream content type; cached
series episodes relevant to M3U; HDHomeRun enablement/live-channel filtering;
and configured manual/provider EPG mapping. These are filter/configuration
observations, not proof that an export or program reached a player.

User limits use a timestamped snapshot from the configured SQLite or Redis
session store and the manager's existing stale-session and grouping rules.
The reader does not clean up records, stop streams, or modify provider settings.
A locally reached limit is observed; blocking a new connection remains a
possible explanation because an existing session may be reusable. Missing or
unreadable session storage is **unknown**, never zero. No raw session identities,
IP addresses, provider credentials or stream URLs are sent to the model.
Details cover at most 40 entries per context page, with explicit shown/total
coverage. Aggregate findings describe that page, not unseen entries.

The following measurements are **not implemented**: network reachability,
actual M3U/Xtream/Stalker/HDHomeRun export delivery, client/share-specific request
filters, EPG program delivery, upstream provider connection limits, playback
health and identification of the selected entry's active session. They remain
separate unknown findings in the UI. No global scan or external playback probe
is started. A diagnosis menu entry is not approval of this entire pilot scope.
Local technical findings survive a failed optional AI explanation. AI job and
usage bookkeeping still writes private operational records; the diagnostic
domain checks themselves are read-only and do not trigger retention cleanup.

Rules support literal prefix removal or replacement with exceptions. Save a
rule from an applied rename, inspect its preview, then separately enable future
use. Automatic summaries after sync have a separate personal switch. Both are
off initially; summaries run as separate jobs, and enabled rules need no model
call. Rules can be renamed, enabled, disabled or deleted after their original
proposal and change records expire. Creating a rule or changing its
transformation or confirmation references requires an applied rename with both
records still within the 30-day retention period, even before cleanup removes
expired rows. Each rule stays bound to its original target user; create a
separate rule to use a confirmed transformation for another user.
Large syncs apply rules in batches of at most 5,000 new channel IDs, yielding
between batches. Each batch loads its eligible authorized assignments once.
Up to 100 enabled rules run in stored creation order; the first matching rule
sets each blank personal name, and later rules only consider unchanged entries.
Exceptions, existing personal names and revoked assignments remain protected.
Each rule's changes retain conflict-protected Undo within the batch transaction.
A failed rule batch stops further rule batches for that user but
does not prevent the separately enabled summary from being requested. A failed
summary is not automatically retried against the model.

## Network and data boundaries

Public API targets require HTTPS and valid certificates. Private/loopback
targets require an administrator's exact normalized base-address allowlist
entry, including its port and path. Plain HTTP is limited to explicitly allowed
internal addresses. Metadata/link-local targets stay blocked. DNS addresses
are checked and pinned to the connection; redirects are rejected. These
exceptions do not change IPTV-provider network policy.

The model receives only the selected function's bounded titles, sanitized
descriptions, metadata and reference IDs. Provider credentials, stream URLs,
headers, DRM data and raw global logs are excluded. Source/model content is
untrusted and displayed as text. Keys are write-only in the UI and encrypted
with the existing application encryption key. The server operator can access
application secrets; this is not encryption against the operator.

Owner IDs include separate administrator/user namespaces. Current catalog and
source rights are checked before inference, result access and writes. Jobs
also bind the connection version, selected model and login-token version.
Canceled or uncertain submitted requests are not blindly retried.

## Limits and retention

- One active provider request per owner and connection across workers; at most
  2 pending jobs per owner, 3 per connection and 20 globally.
- At most 60 calls per owner/hour, 180 per connection/hour and 30 per
  owner/function/hour. Discovery and synthetic tests count as setup calls.
  Limits include failed submissions, not only successful answers.
- Provider requests time out after 30 seconds. Normal jobs have a 2-minute
  deadline, explicit large analyses 10 minutes; queued jobs expire after
  30 minutes. Three consecutive connection failures/5xx/timeouts within five
  minutes pause a connection temporarily; expected capability, model, credential
  and permission rejections do not count as connection outages.
- Responses are limited to 512 KiB; inference requests set a 2,048-token
  output ceiling. Truncated, oversized or malformed outputs are rejected.
- Default catalog analysis examines up to 240 entries; explicit large-list
  processing uses pages of up to 2,000. Follow the displayed continuation to
  process later pages. A partial page never claims the whole list was checked.
  Cross-page duplicate grouping uses the authorized local catalog.
- EPG matching examines at most 5,000 source records; search returns at most
  100 results and examines at most 5,000 program rows using stable pages under
  the channel/source/start primary key. Existence probes distinguish exact
  terminal boundaries from omitted rows. Any omitted rows, or a capped source
  catalog, produce `truncated: true`, including zero-match searches. Unknown
  language, region or runtime stays unknown.
- Sync history skips providers affecting more than 50,000 visible assignments
  rather than recording a misleading partial removal report.
- Job inputs/results are retained for 7 days; conversations, proposals,
  change/undo records, enrichments and sync snapshots for 30 days. Cleanup
  removes bounded batches during AI operations. Expired results are hidden
  even if physical cleanup has a backlog. Connections, preferences and enabled
  rules persist until removed. Deleting an account removes its private records
  and records targeting that user.
- Usage records are retained for 30 days. Each provider-request reservation,
  including discovery and compatibility tests, removes up to 100 expired,
  inactive records, oldest first. Job/history access uses the same cleanup;
  active reservations and current quota/outage evidence remain intact.
- Snapshot cleanup after a provider sync removes up to the larger of 100 or
  the number of snapshots just inserted, so expiry cleanup keeps pace with
  syncs affecting many users. Snapshots within 30 days are preserved.
- Automatic rule writes also run the existing bounded private-history cleanup,
  even when automatic summaries are off. It removes up to 100 expired records
  per table per rule batch, preserving enabled rules and current Undo records.

Clear History cancels pending personal jobs and removes job history,
conversations and enrichments. Change/undo records remain for their retention
period; reusable rules are managed separately. Provider-reported token counts
are shown where available; missing counts and prices are **unknown**. There is
no configured tariff or promise of an exact monetary cap. A submitted request
may already have incurred a charge even if it is canceled locally.

## Backup, restore and credential rotation

Normal user backups, clones and JSON system exports do not contain AI
connections, keys or conversations. Use a consistent administrative database
backup for disaster recovery. Keep `secret.key` (or the configured
`ENCRYPTION_KEY`) in a separate protected secret backup; restore it with the
matching database. A raw database copy contains encrypted AI credentials and
private AI history and must be protected accordingly.

Rotate a provider-issued AI key by saving its replacement on that connection,
retesting and selecting a model, then revoking the old key at the provider.
Do not replace the application's encryption key alone: it also encrypts
existing IPTV credentials. Application-key rotation requires re-encrypting
all affected secrets with the old and new key; this feature adds no automatic
application-key rotation command. A lost encryption key cannot be recovered
from the database.

## Optional personal ChatGPT connection

A second connection type lets each user and each administrator link **their own**
ChatGPT account instead of supplying an OpenAI platform API key. It is an
addition, not a replacement: the OpenAI-compatible API connection above is
unchanged, and both types run the same eight functions through the same checks,
source limits, proposals, confirmations and conflict-protected undo.

### What it is and what it is not

The adapter drives the officially documented **Codex app server** over its
newline-delimited JSON-RPC protocol and uses its managed ChatGPT sign-in
(device code). It does not use a private ChatGPT web interface, does not turn a
browser OAuth token into an API key, and never routes a ChatGPT sign-in through
the existing `chat/completions` transport.

* Even asking the runtime for its version executes it, so that probe runs inside
  the verified sandbox as well; the boundary exists before the runtime does.
* The runtime is resolved to an absolute path once — including a configured
  relative path, which the sandbox could not resolve from its own working
  directory — and the same path is both version-probed and launched, so an
  installation that only the host `PATH` can find cannot report itself available
  and then fail inside the sandbox. The executable itself, the file a
  symlink points at and the interpreter of a script launcher are bound read-only
  as individual files, never as their directories, so a launcher sitting beside
  unrelated application files such as a mounted `.env` does not carry them into
  the sandbox. Only the Codex distribution's own package root is bound as a
  directory, because a packaged launcher needs the files it ships with; a
  launcher that resolves into an unrelated application or monorepo package does
  not carry that package's other files in, and fails visibly instead. Those locations are kept on
  the sandbox `PATH`, which is what a global npm install needs; the
  version probe uses that same `PATH`, so a launcher the probe can start is one
  the sandbox can start. A launcher placed in or above the data directory is
  refused outright (`AI_CODEX_BINARY_UNSAFE_LOCATION`), because mounting it would
  hand the runtime the database, the encryption key and every other identity.
  The containment self-test carries the configured launcher's mounts, so such a
  configuration also fails the canary rather than slipping past a probe built
  only around a shell.
* Pinned and tested Codex release: **0.154.0**. Accepted range: `>= 0.154.0` and
  `< 0.156.0`, release versions only. A version outside that range, and any
  prerelease or build-tagged binary whose numbers fall inside it, keeps the
  adapter unavailable unless an operator names that exact version string —
  suffix included, prerelease and build metadata together — in
  `AI_CODEX_VERSION_OVERRIDE` after validating it separately. The version probe and the runtime handshake read the same token,
  so an allowed build passes both gates rather than one.
* A compatibility test spends one budget across the whole batch, not one per
  probe: a slow but working provider would otherwise keep a request — and its
  billable calls — running for many minutes after the browser gave up. What was
  proven is kept, and every model the batch could not reach is reported as
  untested and replaces its stored profile. The budget covers starting a runtime
  as well, not only the request it then makes, so a retest never leaves an obsolete
  model marked compatible.
* A discarded sign-in is signed out even when the connection keeps an older
  link, because the runtime authenticated an account either way and only the
  sign-out ends that session upstream. That includes a sign-in that could not be
  read back: the authorization succeeded, so the session exists whether or not
  the manager managed to look at it.
* A request spends one deadline across everything it does: waiting for the
  identity to be handed over, the handshake, the authentication check and then
  the turn or the model catalog. The startup is part of the operation, so a slow
  host cannot make it outlive the reservation that bounds it.
* A turn spends one deadline across all of its phases — opening the thread,
  submitting it and waiting for the answer — so a slow server cannot hold a
  runtime for a multiple of the caller's limit and outlive the reservation that
  bounds the request.
* Access is checked once more immediately before a turn is submitted, not only
  before the thread is started: starting a thread has its own thirty-second
  budget, and a compatibility test has neither a job monitor nor an abort signal
  behind it, so that is its last gate before a billable request.
* Model discovery pages through `model/list` under one deadline for the whole
  catalog, matching the provider's advertised setup timeout, so a slow or
  endlessly paging server cannot hold a runtime past the reservation that bounds
  the operation.
* Used methods: `initialize`, `account/login/start` (`chatgptDeviceCode`),
  `account/login/cancel`, `account/logout`, `account/read`,
  `account/rateLimits/read`, `getAuthStatus`, `model/list`, `thread/start`,
  `turn/start`, `turn/interrupt`, and the `account/login/completed`,
  `item/completed`, `turn/completed` and `thread/tokenUsage/updated`
  notifications.
* Device-code sign-in is a **beta** path of that release and must be permitted
  by the personal ChatGPT security settings or by a workspace administrator.
  Where it is not permitted, the sign-in fails with a specific message and
  nothing is stored.
* The presence of a sign-in function is **not** a blanket permission for every
  hosted multi-user arrangement. Separating accounts does not by itself make an
  operator's deployment contract- or fair-use-compliant. Check the applicable
  ChatGPT and Codex terms for the plans involved before enabling this in a
  hosted setting.

### Required runtime containment

A Codex runtime is an execution-capable agent host. A prompt, a read-only
filesystem mode or a disabled tool flag are defence in depth, never the
boundary. The adapter is therefore offered only where all of the following hold:

1. An operating-system sandbox is available and passes a **canary self-test** at
   startup: from inside the sandbox, a file outside it must be unreadable — the
   probe places one beside the runtime directory and one inside `DATA_DIR`, so a
   data directory reachable through a mounted system root is detected — and a
   write into `DATA_DIR` must fail. The data directory, the manager's working
   directory and its installation root are additionally masked inside the
   namespace — each under both its given and its resolved path — so a bare-metal
   installation that lives beneath a mounted system root exposes neither its
   working tree nor the `.env` file loaded from it, whatever `DATA_DIR` points
   at. The root that holds the per-identity runtime directories is masked the
   same way wherever an operator places it, and only the identity that is
   running is restored inside, so a neighbouring identity is unreachable on
   every backend rather than only where that root happens to sit under the data
   directory. A launcher that lives inside one of those masked trees — a local install
   in the application's own `node_modules` — is bound again after the masks,
   together with its `@openai/codex` package root and the vendored binaries in
   it, whether the configured path is a `.bin` symlink or the package entrypoint
   itself. No other package around a launcher is ever bound whole, so the
   documented bare-metal layout stays usable without carrying an application's
   own files in. The macOS profile denies reads
   of the same three trees and re-allows exactly those launcher paths. The probe
   itself uses no shell redirection: a denied `2>/dev/null` makes the shell skip
   the command entirely, which would let a canary read that never happened count
   as containment, so every read probe also reads a control file inside its own
   tree and the result is only accepted when that control appears. Linux uses bubblewrap (`bwrap`), which is the
   only grade accepted for hosted multi-user operation. macOS `sandbox-exec` is
   classified as development grade and refused unless an operator explicitly
   opts in: its profile denies writes outside the identity's own tree and reads
   of the manager's data directory, but still permits reads elsewhere on the
   host and execution of other binaries, so it is a development convenience
   rather than a multi-user boundary.
2. Every runtime is started with `--strict-config`, so a renamed or removed
   Codex option is a hard startup failure rather than a silent capability grant.
3. Shell, unified exec, file view, sleep, browser control, computer use, apps,
   hooks, plugins, marketplaces, skill discovery and web search are disabled by
   flag; MCP servers are emptied; the sandbox mode is `read-only` and the turn is
   started with `sandboxPolicy: readOnly` and no network access for the sandbox.
4. The effective policy the server echoes back on `thread/start` is verified. A
   weaker approval policy, a different sandbox policy or any loaded instruction
   source aborts the turn.
5. Every approval or capability request from the runtime is **denied** — there is
   no automatic approval — and any turn that contains a command, file change,
   MCP call, dynamic tool call, web search or generated image is discarded whole.
6. The runtime environment is built from scratch. `CODEX_HOME`, `HOME`, `PATH`,
   `TMPDIR` and the locale are set explicitly; nothing else is inherited, so an
   operator's `OPENAI_API_KEY`, proxy settings, plugin roots or manager secrets
   cannot reach it. `getAuthStatus` must report `chatgpt` before any request; an
   API-key mode is refused rather than used.

On bare metal the same requirements apply: install bubblewrap, run the web
process unprivileged, and keep `AI_CODEX_RUNTIME_DIR` on a filesystem the web
user owns. Separate directories under one privileged operating-system account
are **not** multi-user isolation. Where a requirement is unmet the adapter stays
disabled and reports the specific cause (`AI_CODEX_SANDBOX_MISSING`,
`AI_CODEX_SANDBOX_READ_ESCAPE`, `AI_CODEX_SANDBOX_WRITE_ESCAPE`,
`AI_CODEX_SANDBOX_GRADE_REJECTED`, `AI_CODEX_BINARY_MISSING`,
`AI_CODEX_VERSION_UNSUPPORTED`).

### Ownership, quota and multi-process behavior

* A ChatGPT connection is **private**. `shared` is forced to false and its user
  list to empty on every write, refused when a request tries to set them, and
  ignored again on read, so a manipulated record cannot become a service for
  other accounts.
* Administrators enable the feature centrally but use only their own sign-in for
  work they trigger themselves. There is no delegate mode that quietly uses a
  target user's account.
* Withdrawing a user's AI access never strands their sign-in: their own linked
  connections stay listed in a form that offers nothing but the disconnect, which
  the unlink endpoint allows without the policy. Otherwise the stored credential
  and the ChatGPT session behind it could only be removed by an administrator
  restoring access first.
* `user:<id>` and `admin:<id>` stay separate namespaces, each with its own
  credential, runtime directory and session.
* Granting a lease is the last point at which a request can be stopped, because
  by then it has long passed its own authorization. The owner must still exist
  still satisfy every access field the rest of the subsystem checks — active,
  Web UI access, not expired, and the session token version the caller
  authenticated with, which the authentication middleware keeps on the request
  for exactly this comparison because a password reset advances it and thereby
  revokes the session — the connection must exist and not be tearing
  down, and the same policy gates the request itself passed — the server switch,
  the owner's allowance and their personal preference — must still hold, all
  checked in the same transaction that inserts the lease; only the teardown that owns the
  marker is exempt. Ownership is verified once more after the handshake, because
  that can outlast a revocation's wait, and a session is never handed to its
  caller once its identity has been released.
* A lease records the sandboxed process it belongs to. When a worker dies — and
  again at startup, for a manager that was killed rather than drained — that
  process is ended, signalled and then killed, and the lease is only released
  once it is really gone: bubblewrap dies with its parent, the macOS
  backend has no equivalent, and an orphan sharing an identity with its
  replacement would mean two processes on one credential. A process that cannot
  be ended keeps its identity claimed, marked revoked, until its lease expires.
  What a teardown reads to decide whether an identity came back follows the same
  rule: an expired lease whose process is still there counts as held, so an
  unlink or a deletion cannot mistake it for an acknowledgement.
  A lease that names a process is never released on its expiry alone: a
  timestamp from before a restart is already past, and sweeping it would hand a
  live identity to a replacement. Such a lease is released by its owner's exit,
  by those reapers, or by an acquisition that first proves the process is gone —
  and the same holds for the cleanup that removes an identity's files, which
  refuses to claim an identity whose recorded process is still running.
  A recorded process is only ever signalled when it still looks like that
  identity's own runtime — every sandbox command carries the identity's
  directory — because a recorded number is meaningless once it has been recycled,
  which across a restart it usually has. That question is asked of `/proc` on
  Linux, because the container image ships BusyBox, whose `ps` does not take a
  process number at all; a host that cannot answer it keeps the identity claimed —
  the opposite guess frees a live one — but nothing is ever signalled then,
  because an unidentifiable number may belong to any other process of this user.
* One runtime per identity and connection, held by a database lease with a
  heartbeat. The lease is the promise that no process is using that identity, so
  a stopping runtime keeps it until its child has actually exited — closing only
  sends a termination signal — and a replacement waits for that hand-off instead
  of starting beside a process that is still running. The same holds for a start
  that failed its handshake: its child is signalled but still alive, so its lease
  is released on that child's exit too. A lease held by a runtime
  that is not terminating is a genuine conflict and is refused at once. A concurrent start, a competing token refresh or the reuse of
  another identity's session is rejected across workers with `AI_BUSY`. There is
  no shared process that is switched between personal logins.
* Linking the same reliably reported external account twice is refused, so a
  second connection cannot multiply one personal plan's quota. The address is
  never stored: only a keyed fingerprint and a masked label.
* The existing call, size, runtime and queue limits apply unchanged. A Codex turn
  has a longer provider deadline than the 30-second API transport, so each
  reservation records its own deadline; a crashed worker's reservation expires on
  that deadline instead of a single global one.
* No account rotation, no account pool, no automatic credit purchase and no
  silent switch to an API-key connection after an error or a quota block.
* Only deliberately triggered work runs on this connection type. Automatic sync
  summaries and unattended catalog analysis are blocked (`ai_codex_manual_only`).
  A deliberate large-list analysis stays bounded, cancellable, and shows scope
  and partial coverage before and after the run. Confirmed local cleanup rules
  keep working without any model request.

### Signing in and disconnecting

The setup panel offers **Connect my ChatGPT account** only when the server
reports a contained runtime. Choosing it asks for a connection name and nothing
else: no address, no key, no model ID and no token parameter. Starting the
sign-in shows the verification address supplied by the official flow and the
one-time device code.

* The address is checked against the documented targets (`auth.openai.com`,
  `chatgpt.com`, `auth.chatgpt.com`) on the server and again in the browser. Any
  other address is reported and never turned into a link.
* Typing in the panel makes no network request. An attempt is bound to the
  current account, its token version and the current session, and is limited to
  five attempts per owner and hour. Only an attempt that actually produced a
  device code counts against that budget, and the count is taken in the same
  transaction that records one, so starts on several connections — which hold
  separate runtime leases and therefore really do run side by side — cannot all
  read the same count and each publish a code. Clicking again supersedes the previous
  attempt instead of opening another one; when that attempt is held by a
  different worker the replacement waits briefly for its runtime to be handed
  over, and refuses without recording an attempt if it is not.
* A discarded sign-in signs the runtime out, ends it and waits for its child to
  exit before removing anything. Removing the identity while that child is alive
  would delete the attempt's own lease and free the directory for a new sign-in
  that recreates it underneath the old process; the removal then reserves the
  identity for itself, exactly as a dropped credential does.
* Storing a credential requires, in the same transaction as the write, that the
  connection exists and is not tearing down, that the owner still passes the
  subsystem's access rule — one definition, shared by the lease, the account
  service and the credential store — and that the attempt the credential belongs
  to is still the one that claimed the identity, with the session version that
  attempt was started under still current — a password reset during a completion
  revokes the session, and storing the credential would hand it exactly what the
  reset took away. A deletion revokes access
  before it tears anything down, so a completion in flight on another worker
  cannot slip a credential in behind it, whether or not the deletion then
  succeeds.
* Winning the lease also requires the attempt to still be open. A second click
  can supersede the first before it ever reaches the lease — a version probe or
  a slow start is long enough — and the superseded request must lose the
  identity rather than hold it against the request that replaced it.
* A sign-in attempt never stores a credential on teardown. Only a completed,
  claimed attempt does, so cancelling a second sign-in on an already linked
  connection cannot replace the stored token while its recorded account stays the
  old one.
* A completion the runtime cannot back with an account is not a sign-in: it is
  discarded rather than reported as linked. The same applies when the interface
  reports an account it cannot identify, because the one-account rule rests on a
  reported identity and could not be enforced without one.
* A rejected replacement keeps the link that already worked. If a second sign-in
  on a linked connection is refused — for instance because the account it
  authenticated is already linked elsewhere — only that attempt's own state is
  discarded; the existing credential stays. Two connections can both pass that
  check before either stores anything; the unique account fingerprint then
  decides, and the one that loses is told its account is already linked rather
  than that storage failed.
* Claiming an attempt is not yet a success. The claim moves it to an internal,
  non-terminal state that no cancel or supersede can take either, and the
  attempt is published as completed only once the credential is actually stored;
  a poll on any worker keeps reporting the sign-in as still running until then.
  Publishing re-applies the whole completion gate in the same transaction —
  policy, account, the session version the attempt was started under, the
  connection, and a browser still watching — because sealing takes time and
  polling an attempt deliberately re-applies none of it: a sign-in finalized after access was
  withdrawn would otherwise be reported as a working link. What that attempt
  stored is removed with the rest of its state.
  A worker that dies in that window leaves the attempt claimed but unfinished,
  and the credential store — not the claim — decides how it is resolved on the
  next poll, so a failed seal can never leave a permanent report of a link that
  does not exist. That resolution answers to the same gates as any other
  completion — policy, session version, account, connection, and a browser still
  watching — because a crash window is not a way past them; a credential it
  cannot adopt is dropped rather than kept. What counts there is which attempt stored the credential, not
  that one exists or that its version moved: a record names the sign-in that
  wrote it, an ordinary token refresh keeps that name, and relinking an already
  linked connection is therefore only reported as successful once its own
  replacement is on record. A cancel that arrives while a completion is storing
  its credential reports the sign-in as still running, and the browser keeps
  polling it: the attempt was not cancelled and can still succeed.
* Cancellation, expiry, refusal, a workspace without device-code sign-in, an
  interrupted worker and success each produce a distinct localized message. A
  cancellation that arrives after the sign-in already completed reports that
  completion rather than claiming success it did not have. A
  runtime that dies after issuing the device code ends its attempt immediately
  and releases its lease, rather than reporting the sign-in as still running
  until the fifteen-minute expiry.
* Refreshing the account is also a check: when the interface reports no account
  for a stored credential, or an authentication mode other than ChatGPT, the
  local link is removed rather than shown as connected again on the next load.
  The removal keeps its reservation until the last file is gone — dropping it
  first would let a replacement recreate the very directory being deleted.
  The record itself is dropped while the runtime that found it dead still owns
  the identity, because everything that asks whether a connection is linked
  reads that row; only the files wait for the child to hand the identity back,
  so a relink never starts beside a process that is still running and never has
  its own files removed.
* An attempt belongs to the browser session that started it. Only that session
  can poll it, and its polling is what keeps the attempt alive: sign-out in this
  application is client side and does not invalidate the token, so a session that
  stops watching its own attempt for more than two minutes no longer owns it. A
  success arriving after that, after a cancellation, after the attempt was
  superseded, or after the account was disabled or its tokens invalidated, is
  discarded — the runtime is signed out again and nothing is kept.
* Polling is not pinned to a worker. Whether a sign-in is still running is read
  from the shared runtime lease, not from the process that happens to answer, so
  a poll routed elsewhere never ends a running attempt.
* Browser cookies and existing `auth.json` files from a developer or operator
  profile are never imported.

Disconnecting marks the connection as being torn down for the whole operation, so
no sign-in, discovery, compatibility test, queued job or inference can start
after its scan and have its runtime removed underneath it; the marker is counted, so an
overlapping teardown keeps it in place, and it is cleared again once the last one
finishes, because the connection itself survives an unlink. A marker abandoned by
a process that died mid-teardown is cleared on the next start, so no connection
stays blocked. A removal authorizes once, immediately before the irreversible
part, and never again after it: refusing afterwards — a session revoked while
the sign-out was running — would leave a connection standing whose credential
and identity directory are already gone. A removal whose local teardown fails — an attempt that cannot be
ended, a credential that cannot be removed — does not delete the connection
either: the deletion trigger would drop the lease and the credential record for
a teardown that never happened. Only a remote sign-out that could not be
confirmed is a reported outcome rather than a failure. A removal that is itself
refused — by a session revoked while
the sign-out was running, say — clears its own marker instead of leaving a
surviving connection unusable. Storing a credential re-checks the marker in the same transaction,
so a sign-in that was already authorized — including one whose completion is in
flight on another worker — cannot put a credential back behind a teardown. A
teardown also ends every attempt that is still running, a claimed one included:
the completion publishes its success only while the attempt is still claimed, so
ending it is what stops a disconnected connection from later reporting a
successful sign-in. It then
cancels queued and running jobs and ends the runtime. A runtime owned by another worker is stopped by marking its lease
revoked; that worker's guard sees this within a second and releases the lease,
and only that release counts as an acknowledgement that it has actually stopped.
The sign-out runs after the acknowledgement, so two runtimes never share one
identity directory. Without an acknowledgement nothing is removed at all — and
that includes the sign-out runtime's own hand-off: the child may still be running
on that identity, so the unlink answers with a retryable conflict and leaves the
lease in place rather than freeing an identity a live process is using. A lease
whose worker really is gone stops its heartbeat and expires by itself, so an
identity is never blocked for good. A request authorized before the marker went up can still win
the lease after that scan; losing that race does not lead to wiping underneath it,
the winner is revoked and awaited and the sign-out retried. If
the remote sign-out cannot be confirmed, local access is still removed and the
difference is reported so the account holder can review active sessions
themselves. A credential that an account refresh finds no longer authenticating
is dropped the same way, but without a user command behind it: waiting for the
runtime lease to disappear only observes that the identity is free, it does not
keep it free, so the removal claims a cleanup reservation in the same
transaction every acquisition uses. A link request that took the identity in
that instant therefore keeps its lease and its files, and the stale record is
left for the next read to drop. Deleting an account revokes its access before anything is torn down, so no
request that starts during the teardown can still reach the credential. The
deletion is refused if any of its runtimes did not acknowledge: the deletion's
own triggers remove the credential and the lease, and a worker that never let go
is not proof that its child stopped. That lease stays claimed as well, so a
request made after the refusal — the account is put back as it was — cannot take
an identity the old child may still be using. The caller can retry. Its
runtimes are only stopped at that point; the credential and the runtime tree are
removed after the deletion has committed, because that removal is irreversible
and a deletion that fails must not cost the account its link. Deleting
a connection follows the same path before its row disappears, so a
runtime never keeps using a credential whose connection is already gone. It sets the same
marker first and keeps it, because the connection is going away. Deleting
an account does the same for every runtime it owns before removing its credential
records, attempt history and runtime directory.

### Credential storage

Codex writes its own credential file, which is not automatically covered by the
database encryption. The manager therefore keeps it inside the identity's own
`0700` runtime directory only while a runtime is live, writes it atomically, and
seals it with the existing `ENCRYPTION_KEY`/`secret.key` between runs. A refresh
performed during a turn or an account read is captured before teardown; a
credential file left behind by a discarded or superseded attempt is never turned
into a stored link. No credential appears in HTTP responses, local storage,
telemetry, logs, user backups, clones or JSON exports. The server operator can
read the application key by design; this is not encryption against the operator.

### Models, requests and quota

For a ChatGPT connection the model catalog comes from the Codex app server with
pagination and bounded page counts. Candidates are marked from their reported
input modalities; a model without text input is shown as a non-text candidate.
Nothing is adopted automatically: the catalog default is recommended only once it
has actually passed a test, and there are no hard-coded current model names and
no silent substitution if a model disappears. There is no token-limit parameter
for this type, so that control is hidden and the stored profile records none.

Requests use the same bounded synthetic test first, then the real contracts of
all eight functions, and structured answers are validated locally against the
same feature contract. As with the API transport, the plain-JSON test is sent
without schema-constrained output, so a model that answers JSON but rejects a
schema is recorded as a usable JSON fallback rather than as incompatible, and
keeps working afterwards; the schema is always stated in the instructions. A cancellation, refusal, tool request, truncated JSON or
faulty RPC event can never result in an applied list change. Available quota and
reset time are shown only where the documented interface reports them, and stay
**unknown** otherwise. No monetary price and no guaranteed number of remaining
requests are shown or derived.

Before activation the panel states that requests run on the account holder's own
ChatGPT/Codex quota, that plan or workspace rules may restrict them, that data is
processed externally by OpenAI under that account, and that no platform API key
is required. The panel is fully localized in German, English, French and Greek.

On shutdown the server stops every runtime — including one that was already
terminating, whose child is still alive — and waits, with a bounded timeout, for
the children to exit and their credential files to be removed before it
terminates. In a container the primary process receives the stop signal while the
runtimes live in the workers, so it forwards the signal, stops replacing workers,
drains them within a bounded budget and sweeps what is left before exiting. A departing child removes its credential file while it still holds the lease and
in the same transaction that releases it, so cleanup and acquisition exclude each
other and it can never touch the files of a runtime that has since taken the same
identity. Terminating immediately would leave a hydrated credential on disk
while the service is offline.

### Restart, failure and disabling

A pending device-code sign-in lives only in the worker that started it; losing
that worker ends the attempt (`ai_codex_login_interrupted`) rather than letting
another worker adopt it. After a process failure a request that was already sent
is never replayed automatically. Setting `AI_CODEX_ENABLED=false` (the default)
stops the connection type from being offered and starts nothing; existing API
connections, playback, playlists, EPG and provider sync are unaffected in every
case.

## Validation and rollout

See [development checks](DEVELOPMENT.md#ai-integration-checks) and
[API routes](API_REFERENCE.md#optional-ai-assistance).
Synthetic tests establish application behavior; validate a configured model
and real player setup separately before production enablement. Deployment,
publishing and release tags are separate steps.

The personal ChatGPT connection described above covers the account-linked case.
Native MCP integrations and third-party OAuth connectors remain out of scope and
would need their own design, authorization and validation.
