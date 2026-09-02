# HYOPU operations workspace

## Routes and source data

- `/`: monthly calendar, Korea ETA list (all 43 reference calls or a selected month), PIC/port/search filters and per-port-call workspace.
- `/sof.html`: existing standalone SOF conversion, also embedded and scoped to a selected port call. Original Excel template/logo/font and NOR/BL/SHIP rules are unchanged.
- The supplied September/October 2026 ETA image is transcribed in `eta-seed.json`. It is a clearly labelled public reference snapshot, not a live shipping feed. AM/PM/?? and source ordering/highlights are preserved. Authenticated team changes are never written into that public bundle.
- A call ID identifies one visit, not just vessel/voyage. Separate ports and repeated visits are independent.

## Required production configuration (release blocker for shared storage)

1. In the authorized Supabase project run the additive `supabase/operations.sql` migration. It creates private membership and port-call tables and inserts the 43 reference rows without overwriting existing records. Do not run it in the unrelated JH Marine project.
2. Invite staff through Supabase Authentication and set their own passwords through the normal invitation/reset flow. An administrator must insert each approved Auth user UUID, PIC and `editor` or `viewer` role into `hyopu_members`. There is no self-signup access to the workspace.
3. On Vercel **hyopu1 / sof-studio**, configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for **Production**, using the intended existing HYOPU Supabase project, then redeploy. Preview settings do not automatically apply to Production. Never expose the service key in browser code.
4. `GET /api/workspace` must show configured/ready true; login must succeed for an approved member and fail for a nonmember. Then verify an actual record save, reload, a second session, stale-write conflict, and logout on the production site. Unit mocks are not evidence of real production persistence.

Until these steps are complete the UI explicitly shows the source snapshot and unsaved drafts; save is disabled. No localStorage/in-memory fallback pretends to be shared persistence. Draft JSON download is an explicit recovery tool, not cloud storage. Closing a dirty record or the page warns about losing changes.

## Security and consistency

- Existing Supabase Auth is used via server-side password login; no credential is logged or stored in browser JS. One-hour access-token session in HttpOnly/Secure/SameSite=Strict cookie. Re-login when expired; no long-lived refresh token retained.
- Every private read/write verifies the Auth user and current `hyopu_members` membership. Editors share the same HYOPU team workspace. PIC is a viewing filter, **not** an authorization boundary. Viewers cannot write.
- New tables have RLS enabled and no anon/authenticated privileges. Server service-role use is gated by membership checks. Writes require same-origin JSON. Private responses are no-store.
- Save replaces only one port-call record with a conditional `id AND revision` update; stale edits return 409, not an overwrite. The UI retains the draft and offers backup/latest-record actions. A lost response reports an unknown save result, not a definite failure.
- SOF iframe messages require exact origin, source window and call ID. Vessel, voyage and port must match before linking. A new iframe is mounted for each record so one vessel's report is not silently reused by another.
- SOF snapshots store structured values; XLSX is regenerated using the original packaged template. Standalone optional cloud XLSX upload now also requires an approved editor.
- Ship/crew/activity/notes are returned only to team members. Keep only necessary personal data. Attachment uploads beyond existing SOF/XLSX and local TXT report input are not implemented.

## Validation

`npm test` covers the original SOF flows and new ETA/calendar/validation/auth/CAS contracts. `npm run build` builds both pages and includes the original template and HYOPU social card. Production API/browser checks and actual authorized persistence must be reported separately.
