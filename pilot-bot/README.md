# HYOPU pilot bot

Independent HYOPU Telegram/mini-app module. Existing portal and LINE UP business
logic is not replaced. Source-port provenance is in `PORT_MANIFEST.json`.

## Deployment boundaries

- GitHub: `HYOPU/HYOPU`, package `pilot-bot/`.
- Supabase: `nhujqbqygnhbnvmfmodi`, bot RPC namespace `hpbot_*`.
- Do **not** deploy this package to the Dongjin project.
- Existing portal `hyopu_*` RPCs are unrelated and must keep their definitions,
  grants and RLS. Additive migration provisioning verifies those boundaries.
- Vercel: `hyopu`, mini app `/pilot-bot/`, isolated collector `/api/hpbot-jstt`.
- Telegram: `@hyopu_ulsan_pilot_20260922_bot`, allowed room `-1004425641291`.

## Runtime

Supabase Cron dispatches the pilot watcher every minute. It also dispatches
pending registration verification, full copy-source archival and JSTT work.
JSTT's own database gate is 20 minutes; no local process is needed.

Login applications are authoritative for active/completed/cancelled work.
`050` and `060` both mean completed; `090` means cancelled. Elapsed time alone
never completes work. Forecast status is supplemental. Uncertain matches and
incomplete source responses cannot delete, cancel, complete or resume work.

Every current member of the allowed room can use bot features. Telegram signed
mini-app data, live room membership, request ownership/revision and explicit
final confirmation are required for writes. Links are not authorization.
Only CREATE/UPDATE are implemented. No cancellation or vessel-master writes.
Submission occurs once; uncertain post-submit results become UNKNOWN and are
rechecked read-only, never automatically resubmitted.

The approved `official-ui-advisory-v1` policy treats the observed company helper
authentication error / empty time-helper response as warnings. Login, exact
choices, required fields, future time, duplicate checks and final verification
remain mandatory. Overdue billing cannot be verified through that helper.

## Configuration

Server-only Supabase secrets (never commit values):

- `ULSAN_PILOT_USERNAME`, `ULSAN_PILOT_PASSWORD`, `ULSAN_SESSION_KEY`
- `ULSAN_TRANSPORT=http-approved` (approved official HTTP host; plaintext risk)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_CHAT_IDS` (allowed rooms, not admin users)
- `ULSAN_WATCHER_KEY`, `ULSAN_OPERATOR_KEY`, `ULSAN_GATEWAY_JWT`
- `ULSAN_HYOPU_ENABLED`, `PILOT_MINIAPP_ENABLED`, `PILOT_MINIAPP_ORIGIN`
- `ULSAN_PILOT_REGISTRATION_ENABLED`, `ULSAN_PILOT_UPDATE_ENABLED`,
  `ULSAN_PILOT_COPY_REGISTRATION_ENABLED` plus matching DB control flags
- `ULSAN_PILOT_ELIGIBILITY_POLICY=official-ui-advisory-v1`

Vercel production encrypted variables: `HPBOT_SUPABASE_SERVICE_KEY`,
`HPBOT_JSTT_USER_ID`, `HPBOT_JSTT_PASSWORD`, `HPBOT_JSTT_KEY`,
`HPBOT_JSTT_ENABLED`. Internal dispatcher URL/key live in Supabase Vault.
Provisioning scripts read credentials through stdin, not shell arguments.

## Verification and deployment

```powershell
# Existing portal regression/build (repository root)
npm test
npm run build
# Pilot module
cd pilot-bot
npm ci
npm test
pnpm dlx supabase@2.117.0 functions deploy ulsan-pilot-watcher --project-ref nhujqbqygnhbnvmfmodi
pnpm dlx supabase@2.117.0 functions deploy telegram-webhook --project-ref nhujqbqygnhbnvmfmodi
pnpm dlx supabase@2.117.0 functions deploy pilot-miniapp --project-ref nhujqbqygnhbnvmfmodi
pnpm dlx supabase@2.117.0 functions deploy ulsan-pilot-registration --project-ref nhujqbqygnhbnvmfmodi
pnpm dlx supabase@2.117.0 functions deploy ulsan-pilot-copy-source --project-ref nhujqbqygnhbnvmfmodi
```

Apply additive migrations only after checking project/organization and existing
objects. Never replay initial provisioning blindly on a populated project.
Watcher/registration gateway JWT stays enabled; only Telegram webhook/mini-app
use their dedicated signed authentication. Use authenticated Dry Run before
enabling a new write path. No fake business application may be submitted.

## Cost controls

Estimated application transfer: 384 MiB warning, 512 MiB/cycle and 24 MiB/day stop.
JSTT stops first at total 384 MiB/cycle or 20 MiB/day. No automatic budget restart.
HTML is ingress, not counted as Supabase billed egress. Supabase Pro Spend Cap
is organization-wide and does not cover Vercel CPU/memory charges.

See `reports/2026-09-22-hyopu-operations.md` for live evidence and limitations.

For bounded, read-only operational follow-up, from `pilot-bot/` run:

```powershell
pnpm dlx supabase@2.117.0 db query --linked --project-ref nhujqbqygnhbnvmfmodi --file scripts/operations-audit.sql --output json
```

The audit counts missing full-minute watcher slots, JSTT 20-minute slots,
unfinished work, outbox/receipt duplicates, terminal-state queue leakage, RLS,
bootstrap progress and estimated usage without returning secrets or snapshots.
It reports whether 24 hours have elapsed; it cannot certify provider billing or
external registration receipt. A zero duplicate count is only database evidence,
not proof that every possible concurrent external action is prevented.

GitHub runs the isolated `HYOPU pilot bot verification` workflow for module-related
PRs and main updates. It uses Node 22 and two test workers, without production
secrets or deployment rights. The existing portal verification remains separate;
a green portal-only check is not evidence that the pilot module tests ran.
