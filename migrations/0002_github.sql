-- GitHub connections (token or OAuth). Tokens are stored AES-GCM encrypted, never returned by the API.
CREATE TABLE github_connections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('token','oauth')),
  login      TEXT NOT NULL,
  token_enc  TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which repo each app is linked to, and through which connection.
ALTER TABLE apps ADD COLUMN github_connection_id INTEGER REFERENCES github_connections(id) ON DELETE SET NULL;
ALTER TABLE apps ADD COLUMN github_repo TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN github_webhook_id INTEGER;

-- The GitHub issue created for a desk request (only desk-originated tickets ever get one).
ALTER TABLE requests ADD COLUMN github_repo TEXT;
ALTER TABLE requests ADD COLUMN github_issue_number INTEGER;
ALTER TABLE requests ADD COLUMN github_issue_url TEXT;
ALTER TABLE requests ADD COLUMN github_error TEXT;
CREATE INDEX idx_requests_github ON requests(github_repo, github_issue_number);

-- Comments may now come from GitHub, where there is no desk user: rebuild with a nullable user_id.
CREATE TABLE comments_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id           INTEGER REFERENCES users(id),
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  source            TEXT NOT NULL DEFAULT 'desk' CHECK (source IN ('desk','github')),
  external_author   TEXT,
  github_comment_id INTEGER
);
INSERT INTO comments_new (id, request_id, user_id, body, created_at)
  SELECT id, request_id, user_id, body, created_at FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX idx_comments_request ON comments(request_id);
CREATE UNIQUE INDEX idx_comments_github ON comments(github_comment_id) WHERE github_comment_id IS NOT NULL;
