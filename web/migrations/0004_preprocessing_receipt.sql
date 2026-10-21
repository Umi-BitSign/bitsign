-- Existing completed results have no preprocessing receipt; preserve them.
-- New results atomically retain the validated runtime receipt alongside text.
ALTER TABLE jobs ADD COLUMN preprocessing_json TEXT;
