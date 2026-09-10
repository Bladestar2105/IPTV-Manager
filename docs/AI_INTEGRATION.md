# Optional AI assistance

AI is disabled on new and upgraded installations. Existing playback, playlists,
EPG and provider sync work without an AI connection. Enable a small group of
test users and individual functions before a broader rollout.

## Setup

1. Open **AI** in the Web UI as an administrator. Enable the server policy,
   select allowed user IDs/functions, and decide whether users may configure
   their own connections.
2. Either create an administrator connection and share it with selected users,
   or let an allowed user create a private connection. Users explicitly enable
   AI in their own preferences. A shared connection needs no user-supplied URL,
   key or model ID.
3. Enter the API base address and, where required, its key. Check the displayed
   destination before requesting discovery or a test. Entering or saving an
   address makes no network request. Custom proxy prefixes are preserved;
   known `/models` and `/chat/completions` suffixes are normalized.
4. Discover models, then test up to three candidates. Tests send only synthetic
   text and can incur provider charges. Select the tested recommendation or
   another tested model and finish setup. If model discovery is unavailable,
   use a manual model ID and explicitly test it.
5. Choose a function, describe the task, and inspect the result. List changes
   require selection and confirmation of the stored before/after proposal.
   Applying or undoing a proposal does not call a model.

The UI supports German, English, French and Greek. Language and IANA timezone
are personal preferences. The advanced token option selects `max_tokens` or
`max_completion_tokens`; changing the API address, key or request profile
invalidates model compatibility and selection. Retest and select explicitly.
Model recommendations reflect observed compatibility, not a price/quality
ranking. There is no automatic fallback to a different provider or credential.

For an EPG description, choose the channel, load its available programs, and
select the actual program as the text source. Loading this local source list
does not call the model. Movies and series can use their original description.

## Functions

| Function | Behavior |
| --- | --- |
| List assistant | Proposes categories, personal names, assignments and order changes using the user's authorized editor catalog. |
| Cleanup | Proposes name/category cleanup; confirmed literal name transformations can become reusable rules. |
| Duplicates | Groups local identities and name variants, shows uncertainty, and proposes hiding entries. Reachability and picture quality require separate measured evidence. |
| EPG | Runs local matching first, presents existing source candidates and program evidence, and protects manual mappings unless explicitly selected. |
| Sync report | Explains a recorded successful before/after difference. Counts come from actual changes; missing or incomplete history is not reconstructed. |
| Search | Converts requests and follow-ups into visible filters, then searches the current authorized catalog and EPG locally. New Search clears the conversation. |
| Diagnosis | Explains deterministic findings and unknowns without automatic repairs. Administrators may request aggregate findings without selecting a user. |
| Text | Translates, summarizes or tags an existing description. The original remains intact and the marked AI version is invalidated when its source changes. |

Normal users keep their existing list-editing rights with `provider_access=0`.
AI cannot grant access, change provider URLs or security settings, delete global
providers, or execute SQL, scripts or arbitrary tools. Applied list changes use
the normal shared database and assignment origins; they are visible through
the existing M3U, Xtream and Stalker outputs.

Manual names, hidden rows and pinned positions are protected unless explicitly
selected for editing. Proposals carry exact source state and dependencies.
Stale proposals and undo conflicts require a fresh review; Undo does not
restore a whole backup or overwrite intervening user edits.

Rules support literal prefix removal or replacement with exceptions. Save a
rule from an applied rename, inspect its preview, then separately enable future
use. Automatic summaries after sync have a separate personal switch. Both are
off initially; summaries run as separate jobs, and enabled rules need no model
call. Rules can be disabled or deleted.

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
  30 minutes. Three recent failures/timeouts pause a connection temporarily.
- Responses are limited to 512 KiB; inference requests set a 2,048-token
  output ceiling. Truncated, oversized or malformed outputs are rejected.
- Default catalog analysis examines up to 240 entries; explicit large-list
  processing uses pages of up to 2,000. Follow the displayed continuation to
  process later pages. A partial page never claims the whole list was checked.
  Cross-page duplicate grouping uses the authorized local catalog.
- EPG matching examines at most 5,000 source records; search returns at most
  100 results and examines at most 5,000 program rows. Coverage/truncation flags
  identify these bounds. Unknown language, region or runtime stays unknown.
- Sync history skips providers affecting more than 50,000 visible assignments
  rather than recording a misleading partial removal report.
- Job inputs/results are retained for 7 days; conversations, proposals,
  change/undo records, enrichments and sync snapshots for 30 days. Cleanup
  removes bounded batches during AI operations. Expired results are hidden
  even if physical cleanup has a backlog. Connections, preferences and enabled
  rules persist until removed. Deleting an account removes its private records
  and records targeting that user.

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
