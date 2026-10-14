import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import WorktreeStandby from "./ForkMigrations/001_WorktreeStandby.ts";

const run = Migrator.make({});

// Fork schema has its own ledger so its ids cannot make the upstream migrator
// skip future migrations. Released fork builds used upstream id 57; preserve
// that record here and free 57 for ScheduledTaskWebhooks before upstream runs.
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      const legacy =
        tables.length === 0
          ? []
          : yield* sql<{ readonly created_at: string }>`
            SELECT created_at FROM effect_sql_migrations
            WHERE migration_id = 57 AND name = 'WorktreeStandby'
          `;
      yield* run({
        table: "effect_sql_fork_migrations",
        loader: Migrator.fromRecord({ "1_WorktreeStandby": WorktreeStandby }),
      });
      if (legacy.length > 0) {
        yield* sql`
          UPDATE effect_sql_fork_migrations SET created_at = ${legacy[0]!.created_at}
          WHERE migration_id = 1 AND name = 'WorktreeStandby'
        `;
        yield* sql`
          DELETE FROM effect_sql_migrations WHERE migration_id = 57 AND name = 'WorktreeStandby'
        `;
      }
    }),
  );
});
