-- Existing jobs, if any, were submitted to this pinned C5 model.
ALTER TABLE jobs ADD COLUMN model_id TEXT NOT NULL DEFAULT '00a74422d9c17a4add1c562bcf54abe4111f26288a33c5168ed458b13b233b91';
ALTER TABLE jobs ADD COLUMN model_name TEXT NOT NULL DEFAULT 'Trupan · C5 public model';
