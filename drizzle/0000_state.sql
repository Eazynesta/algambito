CREATE TABLE game_state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
--> statement-breakpoint
INSERT INTO game_state VALUES (1, 0, '{"users":{},"matches":{},"friends":{},"queue":{}}');

