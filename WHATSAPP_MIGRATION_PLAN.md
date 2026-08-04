# WhatsApp: Baileys → Cloud API migration (NanoClaw-based)

## Context

This repo is a NanoClaw fork (`pocketclaw-telegram`, framework name `nanoclaw`) being customized into "Pocket Claw," a learning assistant. The quiz/leaderboard/knowledge-domain/skill-level product features described in the original task **don't exist in code yet** — confirmed by repo-wide search. What exists today is NanoClaw's onboarding, repositioned toward a learning-assistant persona, on top of the native Baileys WhatsApp channel adapter (`src/channels/whatsapp.ts`).

The original task assumed a bespoke app and asked to hand-build an Express webhook, a Graph API client, a dedup layer, and button/list primitives from scratch. That work already exists in the framework as a pluggable channel adapter (`@chat-adapter/whatsapp`, wrapped by `src/channels/chat-sdk-bridge.ts`), installable via the repo's own `/add-whatsapp-cloud` skill — confirmed present at `.claude/skills/add-whatsapp-cloud/`. Reinventing it would create a second, conflicting implementation. This plan uses the framework's existing mechanism instead, scoped per your answers: full Baileys removal after live verification, infrastructure-only (no new quiz/domain conversation flows), skip docs cleanup.

One correction to the original task's env var names: the adapter that will actually run reads `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (see `src/channels/whatsapp-cloud.ts` from the channels branch, read during exploration). The task's proposed names (`WHATSAPP_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WEBHOOK_VERIFY_TOKEN`) don't match what's read at runtime — using them would silently no-op the adapter. Going with the framework's names.

## Fork-specific wrinkle

Both `/add-whatsapp-cloud` and `/add-whatsapp` skills say `git fetch origin channels`, but in this fork `origin` = `tokenlab42/pocketclaw-telegram` (no `channels` branch) and `upstream` = `nanocoai/nanoclaw` (has it — already fetched, tip `ef248c5d`). Every `git show origin/channels:...` in the steps below must read `upstream/channels:...` instead.

## Phase 1 — Install the WhatsApp Cloud API adapter

Follow `.claude/skills/add-whatsapp-cloud/SKILL.md`, substituting `upstream` for `origin`:

1. `git show upstream/channels:src/channels/whatsapp-cloud.ts > src/channels/whatsapp-cloud.ts`
2. `git show upstream/channels:src/channels/whatsapp-cloud-registration.test.ts > src/channels/whatsapp-cloud-registration.test.ts`
3. Append `import './whatsapp-cloud.js';` to `src/channels/index.ts` (currently has `import './cli.js';` and `import './whatsapp.js';` — both stay for now).
4. `pnpm install @chat-adapter/whatsapp@4.27.0` (the version in SKILL.md; `setup/install-whatsapp-cloud.sh` pins 4.26.0 — use SKILL.md's since it's the more recently authored source of truth, and `pnpm-workspace.yaml`'s `minimumReleaseAge` gate will apply automatically). `chat` core is already a dependency at `^4.24.0` — no bump needed.
5. `pnpm run build && pnpm exec vitest run src/channels/whatsapp-cloud-registration.test.ts` — both must pass.

Registers under `channelType: 'whatsapp-cloud'`, distinct from Baileys' `'whatsapp'` — they coexist safely during the transition (confirmed via `setup/migrate-v2/select-channels.ts`, which already models them as separate choices).

## Phase 2 — Environment

Add to `.env.example`:
```
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
```
You'll fill in `.env` with the real System User token, Phone Number ID, App Secret (Settings → Basic), and a verify token you choose. After you do, sync to the container: `mkdir -p data/env && cp .env data/env/env`.

Webhook URL to configure in Meta: `https://<your-ngrok-or-domain>/webhook/whatsapp-cloud` — path is auto-registered by `registerWebhookAdapter` in `src/webhook-server.ts` when the adapter's `setup()` runs; no route code to write. Subscribe to the `messages` field only.

## Phase 3 — Fix channel-agnostic code that assumes Baileys' JID shape

Cloud API's `platform_id` is the Meta Phone Number ID / sender's raw phone number — no `@s.whatsapp.net` / `@g.us` suffix, and no group chats. Two places break or go stale:

- **`container/skills/whatsapp-formatting/instructions.md`** (loaded into every agent group via the `.claude-fragments` symlink) — teaches the agent to detect WhatsApp via `chatJid` ending in `@s.whatsapp.net`/`@g.us` and tag mentions by phone digits. Under Cloud API this condition never matches (harmless no-op), but mention-tagging isn't a Cloud API concept anyway (no groups, no mention rendering in 1:1 DMs). Add a line clarifying this fragment applies to the native Baileys adapter only, so the agent doesn't try the trick and confuse itself when messages arrive with a different `chatJid` shape.
- **`src/modules/permissions/channel-approval.ts`** (`parseAdminNumbers` / the `WHATSAPP_ADMIN_NUMBERS` matching path) — derives bare digits via `.split('@')[0]`. Verify only (no code change expected): Cloud API's platform_id has no `@`, so `.split('@')[0]` returns it unchanged — should just work. Confirm with a real inbound message once Phase 6 testing starts.

`setup/groups.ts` (Baileys group enumeration) and `ASSISTANT_HAS_OWN_NUMBER` (shared-vs-dedicated-number concept) are Baileys-only concerns with no Cloud API equivalent — nothing to port, they simply won't apply to the new channel.

## Phase 4 — Cost tracking table

New migration `src/db/migrations/023-whatsapp-message-log.ts`, following the pattern in `src/db/migrations/022-onboarding-codes.ts`:

```sql
CREATE TABLE IF NOT EXISTS whatsapp_message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  message_type TEXT NOT NULL,
  category TEXT NOT NULL,
  template_name TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
Register it in `src/db/migrations/index.ts` (import + push into the `migrations` array, version 23).

Hook point: `deliverMessage()` in `src/delivery.ts`, right after the successful `await deliveryAdapter.deliver(...)` call (~line 356-363). This function is channel-agnostic (all adapters funnel through it), so gate the log write on `msg.channel_type === 'whatsapp-cloud'`. Derive fields from the already-parsed `content` (`content.type`): `'ask_question'` or `'card'` → `message_type: 'interactive'`, otherwise `'text'`; no template-send path exists yet in the framework's generic message types, so `category` defaults to `'service'` and `template_name` stays null until template sending is actually wired (see Phase 6 note). `recipient` = `msg.platform_id`.

## Phase 5 — Rewire the live channel

Current wiring: messaging group `mg-1783044714585-rgks3l` (channel_type `whatsapp`, platform_id `6590672025@s.whatsapp.net`) → agent group `ag-1784170110477-9gcmgx` via `mga-1784170110483-7p0pd2`.

Cloud API is a distinct channel_type, so this isn't an in-place edit — after Phase 1-2 install and credentials are live, use `/manage-channels` (or `ncl messaging-groups create` + `ncl wirings create`) to wire the new `whatsapp-cloud` messaging group (auto-discovered on first inbound message, or create explicitly with the Phone Number ID as platform_id) to the same agent group `ag-1784170110477-9gcmgx`. Leave the old Baileys wiring intact until Phase 7.

## Phase 6 — Verify live (you'll drive the real Meta side; I'll drive local checks)

- `pnpm run build` clean, `pnpm test` clean.
- Local: confirm `GET /webhook/whatsapp-cloud` responds correctly to a manual curl simulating Meta's handshake (`hub.mode=subscribe&hub.verify_token=<your token>&hub.challenge=123` → expect `123` back, wrong token → `403`).
- You test end-to-end against the real number (per your notes) — send a text, confirm delivery; have the agent call `ask_user_question` with 4 options and confirm it renders as a WhatsApp list (not truncated/broken) — this is the one thing I can't verify without a live number, and it's also where `@chat-adapter/whatsapp`'s internal 3-button/10-row handling gets proven for real, since that logic lives inside the pinned package, not code we're writing.
- Confirm `whatsapp_message_log` rows appear after each send.

## Phase 7 — Remove Baileys (only after Phase 6 passes)

Follow `.claude/skills/add-whatsapp/REMOVE.md` in full: drop `import './whatsapp.js';` from `src/channels/index.ts`, delete `src/channels/whatsapp.ts` + its two test files, remove the `groups`/`whatsapp-auth` entries from `setup/index.ts`'s `STEPS` map, delete `setup/whatsapp-auth.ts`, `setup/channels/whatsapp.ts`, `setup/install-whatsapp.sh`, `setup/add-whatsapp.sh`, `.claude/skills/add-whatsapp/` (skill dir), remove `ASSISTANT_HAS_OWN_NUMBER` from `.env`/`data/env/env`, `pnpm uninstall @whiskeysockets/baileys qrcode @types/qrcode pino`, rebuild, restart the service. Then remove the old Baileys messaging-group wiring from Phase 5 (`ncl wirings delete` / `ncl messaging-groups delete` for `mg-1783044714585-rgks3l`) and optionally `rm -rf store/auth/` (unlinks the device — confirm with you first since it's irreversible without re-pairing).

## Phase 8 — Final sanity checks

- `grep -ri baileys` across the repo (excluding node_modules/dist) returns nothing in code or `package.json`/`pnpm-lock.yaml`.
- `pnpm run build` and `pnpm test` clean.
- `src/channels/whatsapp-cloud-registration.test.ts` and the new migration are covered by the existing test run.

## Explicitly out of scope (per your answers)

- No new domain-selection / skill-level / quiz-answer conversation logic — `ask_user_question` (`container/agent-runner/src/mcp-tools/interactive.ts`) is confirmed capable of rendering as buttons/lists on WhatsApp Cloud once installed; building the actual prompts is future work for whoever designs those flows.
- No docs rewrite (`docs/SPEC.md`, `docs/docker-sandboxes.md`, `docs/architecture.md`, `docs/api-details.md`, README variants, etc. all contain Baileys-era content that will go stale — flagged, not touched).
