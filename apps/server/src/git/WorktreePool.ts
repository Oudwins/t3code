import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

interface StandbyWorktree {
  readonly path: string;
  readonly repoRoot: string;
}

/**
 * Bookkeeping for parked worktrees. A claim deletes its row, which makes the
 * claimer the only one allowed to touch that path. An eviction only marks the
 * row: it stays, out of reach of claims, until `forget` confirms the directory
 * is gone, so a removal that fails is retried by the next eviction. The pool
 * never touches the filesystem.
 */
export class WorktreePool extends Context.Service<
  WorktreePool,
  {
    readonly release: (worktree: StandbyWorktree) => Effect.Effect<void, SqlError.SqlError>;
    /** Takes the most recently released worktree of the repository. */
    readonly claim: (repoRoot: string) => Effect.Effect<Option.Option<string>, SqlError.SqlError>;
    /**
     * Marks worktrees older than `maxAgeMs` or beyond `maxPerRepo` per
     * repository for removal. Returns everything awaiting removal, including
     * worktrees an earlier eviction failed to remove.
     */
    readonly evict: (limits: {
      readonly maxAgeMs: number;
      readonly maxPerRepo: number;
    }) => Effect.Effect<ReadonlyArray<StandbyWorktree>, SqlError.SqlError>;
    readonly evictAll: Effect.Effect<ReadonlyArray<StandbyWorktree>, SqlError.SqlError>;
    /** Queues a worktree that is no longer in the pool, such as a claimed one that failed to remove. */
    readonly condemn: (worktree: StandbyWorktree) => Effect.Effect<void, SqlError.SqlError>;
    /** Drops the row of a worktree whose directory is gone. */
    readonly forget: (path: string) => Effect.Effect<void, SqlError.SqlError>;
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
          WHERE repo_root = ${repoRoot} AND evicting = 0
          ORDER BY released_at_ms DESC
          LIMIT 1
        )
        RETURNING path
      `;
      return Option.fromNullishOr(rows[0]?.path);
    },
  );

  const evictOlderThan = Effect.fn("WorktreePool.evictOlderThan")(function* (
    cutoffMs: number,
    maxPerRepo: number,
  ) {
    yield* sql`
      UPDATE worktree_standby
      SET evicting = 1
      WHERE evicting = 0
        AND (
          released_at_ms < ${cutoffMs}
          OR path IN (
            SELECT path FROM (
              SELECT path,
                ROW_NUMBER() OVER (PARTITION BY repo_root ORDER BY released_at_ms DESC) AS slot
              FROM worktree_standby
              WHERE evicting = 0
            )
            WHERE slot > ${maxPerRepo}
          )
        )
    `;
    const rows = yield* sql<{ readonly path: string; readonly repo_root: string }>`
      SELECT path, repo_root FROM worktree_standby
      WHERE evicting = 1
      ORDER BY released_at_ms
    `;
    return rows.map(({ path, repo_root }) => ({ path, repoRoot: repo_root }));
  });

  const evict: WorktreePool["Service"]["evict"] = Effect.fn("WorktreePool.evict")(function* ({
    maxAgeMs,
    maxPerRepo,
  }) {
    const now = yield* Clock.currentTimeMillis;
    return yield* evictOlderThan(now - maxAgeMs, maxPerRepo);
  });

  const evictAll: WorktreePool["Service"]["evictAll"] = evictOlderThan(Number.MAX_SAFE_INTEGER, 0);

  const condemn: WorktreePool["Service"]["condemn"] = Effect.fn("WorktreePool.condemn")(function* ({
    path,
    repoRoot,
  }) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
        INSERT INTO worktree_standby (path, repo_root, released_at_ms, evicting)
        VALUES (${path}, ${repoRoot}, ${now}, 1)
        ON CONFLICT (path) DO UPDATE SET evicting = 1
      `;
  });

  const forget: WorktreePool["Service"]["forget"] = Effect.fn("WorktreePool.forget")(
    function* (path) {
      yield* sql`DELETE FROM worktree_standby WHERE path = ${path}`;
    },
  );

  return WorktreePool.of({ release, claim, evict, evictAll, condemn, forget });
});

export const layer = Layer.effect(WorktreePool, make);
