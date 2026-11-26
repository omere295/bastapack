-- A message with several orders gets one answer (26/11/2026).
-- Its orders (rows "<id>#1", "<id>#2", … from wa_split) are worked on side by side and each stores its outcome here:
--   result 'done' + result_text = one line for the summary ("B-1050 · client · items"),
--   result 'question' + result_text = the one critical question that stopped it.
-- When all are done the original row gets result 'summarized' (so the summary is sent once): "בוצע ✅" + the lines +
-- the first question. The other questions are asked one at a time (asked_at), each after the previous one is
-- answered or skipped (resolved_at).
alter table public.wa_messages
  add column result text,
  add column result_text text,
  add column asked_at timestamptz,
  add column resolved_at timestamptz;
create index wa_messages_questions on public.wa_messages (phone, created_at) where result = 'question' and resolved_at is null;
