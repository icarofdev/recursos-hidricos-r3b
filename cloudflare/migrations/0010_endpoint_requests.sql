-- Fixed five-minute counters. Paths and methods are normalized by the Worker.
CREATE TABLE endpoint_requests (
 window_start INTEGER NOT NULL,
 path TEXT NOT NULL,
 method TEXT NOT NULL,
 country TEXT NOT NULL,
 request_count INTEGER NOT NULL CHECK(request_count > 0),
 last_status INTEGER NOT NULL,
 last_request_id TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(window_start,path,method,country)
);
