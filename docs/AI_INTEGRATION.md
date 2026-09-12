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
selections leave those settings unchanged.

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

## Validation and rollout

See [development checks](DEVELOPMENT.md#ai-integration-checks) and
[API routes](API_REFERENCE.md#optional-ai-assistance).
Synthetic tests establish application behavior; validate a configured model
and real player setup separately before production enablement. Deployment,
publishing and release tags are separate steps.

Native ChatGPT, MCP and OAuth account integrations are not included. They are
possible separate follow-up work requiring their own design, authorization and
validation; an OpenAI-compatible API key connection does not implement them.
