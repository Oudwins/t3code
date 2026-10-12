import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlError from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface StandbyWorktree {
  readonly path: string;
  readonly repoRoot: string;
}

/**
 * Bookkeeping for parked worktrees. A row is the ownership token for its
 * directory: whoever deletes it, a claim or an eviction, is the only one
 * allowed to touch that path. The pool never touches the filesystem.
 */
export class WorktreePool extends Context.Service<
  WorktreePool,
  {
    readonly release: (worktree: StandbyWorktree) => Effect.Effect<void, SqlError.SqlError>;
    /** Takes the most recently released worktree of the repository. */
    readonly claim: (repoRoot: string) => Effect.Effect<Option.Option<string>, SqlError.SqlError>;
    /** Takes out worktrees older than `maxAgeMs` or beyond `maxPerRepo` per repository. */
    readonly evict: (limits: {
      readonly maxAgeMs: number;
      readonly maxPerRepo: number;
    }) => Effect.Effect<ReadonlyArray<StandbyWorktree>, SqlError.SqlError>;
    readonly evictAll: Effect.Effect<ReadonlyArray<StandbyWorktree>, SqlError.SqlError>;
  }
>()("t3/git/WorktreePool") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const release: WorktreePool["Service"]["release"] = Effect.fn("WorktreePool.release")(function* ({
    path,
    repoRoot,
  }) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
        INSERT INTO worktree_standby (path, repo_root, released_at_ms)
        VALUES (${path}, ${repoRoot}, ${now})
      `;
  });

  const claim: WorktreePool["Service"]["claim"] = Effect.fn("WorktreePool.claim")(
    function* (repoRoot) {
      const rows = yield* sql<{ readonly path: string }>`
        DELETE FROM worktree_standby
        WHERE path = (
          SELECT path FROM worktree_standby
          WHERE repo_root = ${repoRoot}
          ORDER BY released_at_ms DESC
          LIMIT 1
        )
        RETURNING path
      `;
      return Option.fromNullishOr(rows[0]?.path);
    },
  );

  const evictOlderThan = (cutoffMs: number, maxPerRepo: number) =>
    sql<{ readonly path: string; readonly repo_root: string }>`
      DELETE FROM worktree_standby
      WHERE released_at_ms < ${cutoffMs}
        OR path IN (
          SELECT path FROM (
            SELECT path,
              ROW_NUMBER() OVER (PARTITION BY repo_root ORDER BY released_at_ms DESC) AS slot
            FROM worktree_standby
          )
          WHERE slot > ${maxPerRepo}
        )
      RETURNING path, repo_root
    `.pipe(
      Effect.map((rows) => rows.map(({ path, repo_root }) => ({ path, repoRoot: repo_root }))),
    );

  const evict: WorktreePool["Service"]["evict"] = Effect.fn("WorktreePool.evict")(function* ({
    maxAgeMs,
    maxPerRepo,
  }) {
    const now = yield* Clock.currentTimeMillis;
    return yield* evictOlderThan(now - maxAgeMs, maxPerRepo);
  });

  const evictAll: WorktreePool["Service"]["evictAll"] = evictOlderThan(Number.MAX_SAFE_INTEGER, 0);

  return WorktreePool.of({ release, claim, evict, evictAll });
});

export const layer = Layer.effect(WorktreePool, make);
