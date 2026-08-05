-- Launchpad 1.0 webhook dispatch marker (master plan webhook contract).
-- Forward-only. Safe to apply after 0004_observability.sql.
--
-- The controller acknowledges a webhook only after the sanitized receipt row
-- is durably readable, then enqueues one sanitized provider-event envelope.
-- dispatched_at records that the envelope was sent (first writer wins), so a
-- replay heals a send that never completed and never sends twice for one
-- completed send. Raw provider bodies are never stored: payload_json holds
-- only the sanitized event projection (id/type and non-secret resource ids).
ALTER TABLE webhook_events ADD COLUMN dispatched_at TEXT;
