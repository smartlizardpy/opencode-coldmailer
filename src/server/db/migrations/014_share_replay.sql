-- Session replay for the shared tab.
--
-- Presence answers "are they here right now?". Replay answers the question that comes later:
-- "what did they do just before this draft was approved?" It is still scoped to the coldcall
-- tab: events are reported by the shared page itself, not by the browser or the OS.

CREATE TABLE share_replay_session (
  id                TEXT PRIMARY KEY,
  share_session_id  TEXT REFERENCES share_session(id) ON DELETE SET NULL,
  -- One browser tab/window. The cookie identifies a device; this keeps two tabs from fighting.
  tab_id            TEXT NOT NULL DEFAULT '',
  label             TEXT NOT NULL DEFAULT '',
  user_agent        TEXT NOT NULL DEFAULT '',
  started_at        INTEGER NOT NULL,
  last_at           INTEGER NOT NULL,
  ended_at          INTEGER,
  event_count       INTEGER NOT NULL DEFAULT 0,
  last_route        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX share_replay_session_time_idx  ON share_replay_session(last_at DESC);
CREATE INDEX share_replay_session_share_idx ON share_replay_session(share_session_id);

CREATE TABLE share_replay_event (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_session_id TEXT NOT NULL REFERENCES share_replay_session(id) ON DELETE CASCADE,
  at                INTEGER NOT NULL,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  route             TEXT,
  payload_json      TEXT NOT NULL
);
CREATE UNIQUE INDEX share_replay_event_seq_idx  ON share_replay_event(replay_session_id, seq);
CREATE INDEX share_replay_event_time_idx        ON share_replay_event(replay_session_id, at);

ALTER TABLE share_audit ADD COLUMN replay_session_id TEXT REFERENCES share_replay_session(id) ON DELETE SET NULL;
ALTER TABLE share_audit ADD COLUMN replay_seq INTEGER;
CREATE INDEX share_audit_replay_idx ON share_audit(replay_session_id, replay_seq);
