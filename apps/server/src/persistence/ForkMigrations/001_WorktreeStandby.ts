import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_standby (
      path TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      released_at_ms INTEGER NOT NULL,
      evicting INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS worktree_standby_repo_released_idx
    ON worktree_standby(repo_root, released_at_ms)
  `;
});
