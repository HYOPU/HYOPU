# HYOPU operations workspace

## Routes and source data

- `/`: monthly calendar, Korea ETA list (the current 42-row reference snapshot or a selected month), PIC/port/search filters and per-port-call workspace.
- `/sof.html`: existing standalone SOF conversion, also embedded and scoped to a selected port call. Original Excel template/logo/font and NOR/BL/SHIP rules are unchanged.
- The supplied September/October 2026 ETA source is transcribed in `eta-seed.json` as a safe fallback snapshot. AM/PM/?? and source ordering/highlights are preserved. Shared workspace changes are never written into that public bundle.
- A call ID identifies one visit, not just vessel/voyage. Separate ports and repeated visits are independent.

## Required production configuration (release blocker for shared storage)

1. In the authorized Supabase project run the additive `supabase/operations.sql` migration. It creates the port-call table and inserts the 43 reference rows without overwriting existing records. Do not run it in the unrelated JH Marine project.
2. On Vercel **hestias-projects-57e91111 / hyopu**, configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for **Production**, using the intended existing HYOPU Supabase project, then redeploy. Preview settings do not automatically apply to Production. Never expose the service key in browser code.
3. `GET /api/workspace` must show configured/ready true. Then verify an actual automatic save, reload, a second browser session and a stale-write conflict on the production site. Unit mocks are not evidence of real production persistence.

Until these steps are complete the UI explicitly shows the source snapshot and unsaved drafts; automatic save is disabled. No localStorage/in-memory fallback pretends to be shared persistence. Draft JSON download is an explicit recovery tool, not cloud storage. Closing a dirty record or the page warns about losing changes.

## Power Automate ETA sync (no Entra admin consent)

The `/api/eta-import` endpoint accepts a 10MB-or-smaller `.xlsx` file or bounded `{ "rows": string[][] }` data sent by the Excel Online Office Script in `office-scripts/hyopu-eta-sync.ts`. Only the first `ETA UPDATE(SC포함)` sheet and its current contiguous table are used. The endpoint upserts changed ETA/ETD/PIC/status values while preserving per-vessel notes, cargo, VCR, tasks, and SOF data. It never receives or stores a Microsoft password, browser cookie, or Graph credential.

1. In Vercel Production, add `FLOW_SYNC_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. The Excel Online script uses the same `FLOW_SYNC_SECRET` as its dedicated `HYOPU_SYNC_KEY`; never use a Supabase service key or Microsoft password in the workbook.
2. Create a Power Automate automated cloud flow: SharePoint **When a file is created or modified (properties only)** for the library/folder, a condition that the filename is `KOREA ETA UPDATE 2020.08.31.xlsx`, then SharePoint **Get file content** using the trigger file identifier.
3. For the requested browser-Excel workflow, paste `office-scripts/hyopu-eta-sync.ts` into Excel for the web, replace its key placeholder, and run it from Excel. The endpoint allows authenticated Office Script CORS requests. A successful response includes `sourceRows`, `changed`, and `checkedAt`; a no-change run writes nothing. Power Automate may still send the original file content directly, but a script containing `fetch` cannot itself run through Power Automate.

The sync intentionally does not delete calls absent from the workbook, because those may contain historical notes or completed SOF work. Archive such calls only after operational review.

## Security and consistency

- The internal workspace does not show a login flow. Its data is served only through the Vercel server API; the Supabase service key is never exposed to the browser.
- Reads and writes are shared for people who can use this site. PIC is a viewing filter, **not** an authorization boundary. Control access to the deployed site with the Vercel project/domain settings when required.
- New tables have RLS enabled and no anon/authenticated privileges. Server service-role access is restricted to the server endpoint, and writes require same-origin JSON. Private responses are no-store.
- Save replaces only one port-call record with a conditional `id AND revision` update; stale edits return 409, not an overwrite. The UI retains the draft and offers backup/latest-record actions. A lost response reports an unknown save result, not a definite failure.
- SOF iframe messages require exact origin, source window and call ID. Vessel, voyage and port must match before linking. A new iframe is mounted for each record so one vessel's report is not silently reused by another.
- SOF snapshots store structured values; XLSX is regenerated using the original packaged template.
- Ship/crew/activity/notes are shared with people who can use this site. Keep only necessary personal data. VCR XLSX files are parsed locally in the browser; the original VCR file is not uploaded or stored, while the extracted cargo rows and filename are saved with the port call.

## Validation

`npm test` covers the original SOF flows and new ETA/calendar/validation/shared-save/CAS contracts. `npm run build` builds both pages and includes the original template and HYOPU social card. Production API/browser checks and actual shared persistence must be reported separately.
