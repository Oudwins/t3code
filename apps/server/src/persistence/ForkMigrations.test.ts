import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import WorktreeStandby from "./ForkMigrations/001_WorktreeStandby.ts";

it.effect.each(["fresh", "upstream", "fork"] as const)(
  "upgrades a %s database without skipping upstream schema or losing standby worktrees",
  (source) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (source !== "fresh") yield* runMigrations({ toMigrationInclusive: 56 });
      if (source === "fork") {
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({ "57_WorktreeStandby": WorktreeStandby }),
        });
        yield* sql`INSERT INTO worktree_standby (path, repo_root, released_at_ms) VALUES ('/parked', '/repo', 123)`;
        yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-05 00:00:00' WHERE migration_id = 57`;
      }
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
      const history = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
      assert.ok(columns.some((column) => column.name === "webhook_token"));
      assert.ok(columns.some((column) => column.name === "webhook_secret"));
      assert.strictEqual((yield* sql`SELECT * FROM effect_sql_fork_migrations`).length, 1);
      if (source === "fork") {
        assert.deepStrictEqual(yield* sql`SELECT * FROM worktree_standby`, [
          { path: "/parked", repo_root: "/repo", released_at_ms: 123, evicting: 0 },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT created_at FROM effect_sql_fork_migrations`, [
          { created_at: "2026-10-05 00:00:00" },
        ]);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps an unknown migration collision guarded", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (57, 'OtherFork')`;
    assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 57`,
      [{ name: "OtherFork" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
