-- Used only by migrate-host-secrets.mjs, which captures output in memory.
-- Never run this query with output sent to a transcript or persist its results.
select decrypted_secret as key from vault.decrypted_secrets where name='jstt_berth_key';
