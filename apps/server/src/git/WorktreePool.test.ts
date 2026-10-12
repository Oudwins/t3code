import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorktreePool from "./WorktreePool.ts";

const layer = WorktreePool.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

// Each release lands one second after the previous so recency order is deterministic.
const release = (path: string, repoRoot = "/repos/app") =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    yield* TestClock.adjust("1 second");
    yield* pool.release({ path, repoRoot });
  });

it.effect("claims the most recently released worktree of the repository", () =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    yield* release("/p/older");
    yield* release("/p/newer");
    yield* release("/p/elsewhere", "/repos/other");

    assert.deepEqual(yield* pool.claim("/repos/app"), Option.some("/p/newer"));
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.some("/p/older"));
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.none());
    assert.deepEqual(yield* pool.claim("/repos/other"), Option.some("/p/elsewhere"));
  }).pipe(Effect.provide(layer)),
);

it.effect("hands each worktree to exactly one concurrent claim", () =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    yield* release("/p/a");
    yield* release("/p/b");

    const claims = yield* Effect.forEach([1, 2, 3, 4], () => pool.claim("/repos/app"), {
      concurrency: "unbounded",
    });
    const claimed = claims.flatMap((claim) => Option.toArray(claim));
    assert.deepEqual(claimed.toSorted(), ["/p/a", "/p/b"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("evicts worktrees past the age limit", () =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    yield* release("/p/stale");
    yield* TestClock.adjust("90 minutes");
    yield* release("/p/fresh");

    const limits = { maxAgeMs: 2 * 3_600_000, maxPerRepo: 10 };
    assert.deepEqual(yield* pool.evict(limits), []);

    yield* TestClock.adjust("45 minutes");
    assert.deepEqual(yield* pool.evict(limits), [{ path: "/p/stale", repoRoot: "/repos/app" }]);
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.some("/p/fresh"));
  }).pipe(Effect.provide(layer)),
);

it.effect("evicts the least recently released worktrees beyond the per-repository cap", () =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    yield* release("/p/first");
    yield* release("/p/other", "/repos/other");
    yield* release("/p/second");
    yield* release("/p/third");

    const evicted = yield* pool.evict({ maxAgeMs: 3_600_000, maxPerRepo: 2 });
    assert.deepEqual(evicted, [{ path: "/p/first", repoRoot: "/repos/app" }]);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps an evicted worktree queued, and unclaimable, until it is forgotten", () =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    yield* release("/p/old");
    yield* release("/p/new");

    const limits = { maxAgeMs: 3_600_000, maxPerRepo: 1 };
    const stale = { path: "/p/old", repoRoot: "/repos/app" };
    assert.deepEqual(yield* pool.evict(limits), [stale]);
    // A removal that failed is offered again by the next eviction.
    assert.deepEqual(yield* pool.evict(limits), [stale]);
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.some("/p/new"));
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.none());

    yield* pool.forget("/p/old");
    assert.deepEqual(yield* pool.evict(limits), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("queues a worktree that is no longer in the pool for removal", () =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    const claimed = { path: "/p/claimed", repoRoot: "/repos/app" };
    yield* release(claimed.path);
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.some(claimed.path));

    yield* pool.condemn(claimed);
    yield* pool.condemn(claimed);
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.none());
    assert.deepEqual(yield* pool.evict({ maxAgeMs: 3_600_000, maxPerRepo: 10 }), [claimed]);

    yield* pool.forget(claimed.path);
    assert.deepEqual(yield* pool.evict({ maxAgeMs: 3_600_000, maxPerRepo: 10 }), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("evicts everything on request", () =>
  Effect.gen(function* () {
    const pool = yield* WorktreePool.WorktreePool;
    yield* release("/p/a");
    yield* release("/p/b", "/repos/other");

    const evicted = yield* pool.evictAll;
    assert.deepEqual(evicted.map((worktree) => worktree.path).toSorted(), ["/p/a", "/p/b"]);
    assert.deepEqual(yield* pool.claim("/repos/app"), Option.none());
  }).pipe(Effect.provide(layer)),
);
