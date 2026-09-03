# HYOPU operations workspace

## Routes and source data

- `/`: monthly calendar, Korea ETA list (the current 42-row reference snapshot or a selected month), PIC/port/search filters and per-port-call workspace.
- `/sof.html`: existing standalone SOF conversion, also embedded and scoped to a selected port call. Original Excel template/logo/font and NOR/BL/SHIP rules are unchanged.
- The supplied September/October 2026 ETA source is transcribed in `eta-seed.json` as a safe fallback snapshot. AM/PM/?? and source ordering/highlights are preserved. Shared workspace changes are never written into that public bundle.
- A call ID identifies one visit, not just vessel/voyage. Separate ports and repeated visits are independent.

## Required production configuration (release blocker for shared storage)

1. In the authorized Supabase project run the additive `supabase/operations.sql` migration. It creates the port-call table and inserts the 43 reference rows without overwriting existing records. Do not run it in the unrelated JH Marine project.
2. On Vercel **hyopu1 / sof-studio**, configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for **Production**, using the intended existing HYOPU Supabase project, then redeploy. Preview settings do not automatically apply to Production. Never expose the service key in browser code.
3. `GET /api/workspace` must show configured/ready true. Then verify an actual automatic save, reload, a second browser session and a stale-write conflict on the production site. Unit mocks are not evidence of real production persistence.

Until these steps are complete the UI explicitly shows the source snapshot and unsaved drafts; automatic save is disabled. No localStorage/in-memory fallback pretends to be shared persistence. Draft JSON download is an explicit recovery tool, not cloud storage. Closing a dirty record or the page warns about losing changes.

## Optional Microsoft Graph ETA sync

The `/api/eta-sync` Vercel Cron reads only the SharePoint workbook `KOREA ETA UPDATE 2020.08.31.xlsx`, parses the `ETA UPDATE` sheet, and upserts only changed ETA/ETD/PIC/status values while preserving per-vessel notes, cargo, VCR, tasks, and SOF data. It runs daily at about 08:10 KST (23:10 UTC; Vercel Hobby schedules are not minute-precise). It never exposes Graph credentials to the browser.

1. In Microsoft Entra, register a confidential application and grant **Microsoft Graph application permission** `Files.Read.All` with administrator consent. Limit the app to the intended SharePoint site with your organization's application-access policy where available.
2. In Vercel Production, add `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `CRON_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. The site/drive/item values are discovered from the supplied HYOPU SharePoint URL by default; `GRAPH_ETA_SITE_ID`, `GRAPH_ETA_DRIVE_ID`, `GRAPH_ETA_ITEM_ID`, and `GRAPH_ETA_FILE_NAME` may be set to pin a specific file.
3. Redeploy, then use Vercel Cron Jobs to invoke `/api/eta-sync`. A successful response includes `sourceRows`, `changed`, and `checkedAt`; a no-change run writes nothing.

The first live Graph run intentionally does not delete calls absent from the workbook, because those may contain historical notes or completed SOF work. Archive such calls only after operational review.

## Security and consistency

- The internal workspace does not show a login flow. Its data is served only through the Vercel server API; the Supabase service key is never exposed to the browser.
- Reads and writes are shared for people who can use this site. PIC is a viewing filter, **not** an authorization boundary. Control access to the deployed site with the Vercel project/domain settings when required.
- New tables have RLS enabled and no anon/authenticated privileges. Server service-role access is restricted to the server endpoint, and writes require same-origin JSON. Private responses are no-store.
- Save replaces only one port-call record with a conditional `id AND revision` update; stale edits return 409, not an overwrite. The UI retains the draft and offers backup/latest-record actions. A lost response reports an unknown save result, not a definite failure.
- SOF iframe messages require exact origin, source window and call ID. Vessel, voyage and port must match before linking. A new iframe is mounted for each record so one vessel's report is not silently reused by another.
- SOF snapshots store structured values; XLSX is regenerated using the original packaged template.
- Ship/crew/activity/notes are shared with people who can use this site. Keep only necessary personal data. Attachment uploads beyond existing SOF/XLSX and local TXT report input are not implemented.

## Validation

`npm test` covers the original SOF flows and new ETA/calendar/validation/shared-save/CAS contracts. `npm run build` builds both pages and includes the original template and HYOPU social card. Production API/browser checks and actual shared persistence must be reported separately.
