-- Punch photo storage policies. Bucket 'punch-photos' is private; any
-- authenticated org member can upload their own punch photo, and any
-- authenticated user can read (web admin views via short-lived signed URLs).

create policy punch_photo_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'punch-photos');

create policy punch_photo_read on storage.objects
  for select to authenticated
  using (bucket_id = 'punch-photos');
