// src/benchmarks/dupe-and-throughput.ts
import { performance } from 'node:perf_hooks';
import { asItemDefId, asOwnerId, asSlotIndex } from '../core/brands';
import {
  OwnerType,
  mountContainer,
  registerItemDef,
  setSlotDirect,
  toInventoryKey,
  transferItemAtomic,
} from '../core/inventory-engine';
import { MariaDbWriteBehindBatcher } from '../storage/mariadb-batcher';
import { ClickHouseTelemetryRingBuffer } from '../telemetry/clickhouse-ring-buffer';

const runAuditAndBench = async (): Promise<void> => {
  const RARE_WEAPON_ID = asItemDefId(7701);
  const AMMO_ID = asItemDefId(1004);
  registerItemDef(RARE_WEAPON_ID, 1);
  registerItemDef(AMMO_ID, 500);

  const attackerId = asOwnerId(101);
  const accompliceId = asOwnerId(202);

  const attackerInv = mountContainer(OwnerType.Player, attackerId, 40);
  const accompliceInv = mountContainer(OwnerType.Player, accompliceId, 40);

  setSlotDirect(attackerInv, asSlotIndex(0), RARE_WEAPON_ID, 1, 980);

  const CONCURRENT_DUPE_ATTEMPTS = 1_000;
  const racePromises = Array.from({ length: CONCURRENT_DUPE_ATTEMPTS }, (_, i) =>
    transferItemAtomic(
      OwnerType.Player,
      attackerId,
      asSlotIndex(0),
      OwnerType.Player,
      accompliceId,
      asSlotIndex(i % 40),
      1
    )
  );

  const raceResults = await Promise.all(racePromises);
  const succeededTransfers = raceResults.filter((r) => r.ok).length;
  const rejectedTransfers = raceResults.length - succeededTransfers;

  let totalWeaponsInWorld = 0;
  for (let s = 0; s < 40; s++) {
    if (attackerInv.buffer[s * 3] === RARE_WEAPON_ID) {
      totalWeaponsInWorld += attackerInv.buffer[s * 3 + 1] ?? 0;
    }
    if (accompliceInv.buffer[s * 3] === RARE_WEAPON_ID) {
      totalWeaponsInWorld += accompliceInv.buffer[s * 3 + 1] ?? 0;
    }
  }

  let sqlCallsExecuted = 0;
  const batcher = new MariaDbWriteBehindBatcher({
    async executeBatch() {
      sqlCallsExecuted++;
    },
  });

  const telemetry = new ClickHouseTelemetryRingBuffer(
    {
      async insertJsonEachRow() {},
    },
    'ru-msk-01',
    32_768
  );

  const throughputInv = mountContainer(OwnerType.Player, asOwnerId(999), 64);
  batcher.track(toInventoryKey(OwnerType.Player, asOwnerId(999)), throughputInv);
  setSlotDirect(throughputInv, asSlotIndex(0), AMMO_ID, 500);

  const OPS = 25_000;
  global.gc?.();
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  for (let i = 0; i < OPS; i++) {
    const from = asSlotIndex(i % 63);
    const to = asSlotIndex((i + 1) % 63);
    const res = await transferItemAtomic(
      OwnerType.Player,
      asOwnerId(999),
      from,
      OwnerType.Player,
      asOwnerId(999),
      to,
      10
    );

    if (res.ok) {
      telemetry.push(
        'TRANSFER',
        OwnerType.Player,
        asOwnerId(999),
        OwnerType.Player,
        asOwnerId(999),
        res.value.itemDefId,
        res.value.movedAmount
      );
    }
  }

  const flushStats = await batcher.flush();
  const chFlushed = await telemetry.flushBatch(32_768);
  const elapsedMs = performance.now() - t0;

  global.gc?.();
  const memAfter = process.memoryUsage().heapUsed;

  console.log(
    JSON.stringify(
      {
        antiDupeAudit: {
          concurrentAttempts: CONCURRENT_DUPE_ATTEMPTS,
          succeededTransfers,
          rejectedTransfers,
          totalItemsAfterRace: totalWeaponsInWorld,
          dupeDetected: totalWeaponsInWorld !== 1,
        },
        throughputBenchmark: {
          atomicOperations: OPS,
          elapsedMs: Number(elapsedMs.toFixed(2)),
          opsPerSec: Math.round((OPS / elapsedMs) * 1000),
          heapDeltaKb: Number(((memAfter - memBefore) / 1024).toFixed(2)),
        },
        storageAndTelemetry: {
          mariaDbBatchesExecuted: sqlCallsExecuted,
          mariaDbRowsPersisted: flushStats.upsertedRows + flushStats.deletedRows,
          sqlQueriesSaved: flushStats.sqlStatementsSaved,
          clickHouseEventsFlushed: chFlushed,
        },
      },
      null,
      2
    )
  );
};

runAuditAndBench();
