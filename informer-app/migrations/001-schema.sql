-- Feed Sponge: people, their scroll sessions (counts only — no frames, titles or takeaways), per-app and per-topic splits,
-- quiz answers (topic + right/wrong only), badges.
CREATE TABLE fs_users (
    id SERIAL PRIMARY KEY,
    handle TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    is_virtual BOOLEAN NOT NULL DEFAULT false,
    client_key TEXT UNIQUE,            -- random id kept on the person's phone, so streaks and totals follow them
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fs_sessions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES fs_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    seconds INT NOT NULL DEFAULT 0,
    posts INT NOT NULL DEFAULT 0,
    info INT NOT NULL DEFAULT 0,
    fun INT NOT NULL DEFAULT 0,
    bait INT NOT NULL DEFAULT 0,
    rage INT NOT NULL DEFAULT 0,
    health INT NOT NULL DEFAULT 0,
    quiz_right INT NOT NULL DEFAULT 0,
    quiz_total INT NOT NULL DEFAULT 0,
    persona TEXT,
    source TEXT NOT NULL DEFAULT 'phone'
);
CREATE INDEX fs_sessions_created_idx ON fs_sessions (created_at);
CREATE INDEX fs_sessions_user_idx ON fs_sessions (user_id, created_at);

CREATE TABLE fs_session_apps (
    session_id INT NOT NULL REFERENCES fs_sessions(id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    posts INT NOT NULL DEFAULT 0,
    junk INT NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, app)
);

CREATE TABLE fs_session_topics (
    session_id INT NOT NULL REFERENCES fs_sessions(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    posts INT NOT NULL DEFAULT 0,
    info INT NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, topic)
);

-- One row per quiz question answered. source_type: 'recall' (about a post they saw) or 'interest' (fun fact about a topic they watched).
CREATE TABLE fs_quiz_answers (
    id SERIAL PRIMARY KEY,
    session_id INT NOT NULL REFERENCES fs_sessions(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES fs_users(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    topic TEXT NOT NULL,
    correct BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fs_quiz_answers_user_idx ON fs_quiz_answers (user_id, created_at);
CREATE INDEX fs_quiz_answers_created_idx ON fs_quiz_answers (created_at);

CREATE TABLE fs_badges (
    user_id INT NOT NULL REFERENCES fs_users(id) ON DELETE CASCADE,
    badge TEXT NOT NULL,
    earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, badge)
);

CREATE TABLE fs_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
