-- How a run's end was judged, persisted so run rows can show it (Tines/26).
-- NULL for runs that never started and for every row predating this column.
ALTER TABLE agent_run ADD COLUMN outcome TEXT;
