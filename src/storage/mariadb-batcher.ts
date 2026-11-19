// src/storage/mariadb-batcher.ts
import {
  FlatInventoryContainer,
  InventoryKey,
  OwnerType,
  drainDirtySlots,
} from '../core/inventory-engine';
import { OwnerId } from '../core/brands';

export interface SlotUpsertRow {
  readonly ownerType: OwnerType;
  readonly ownerId: OwnerId;
  readonly slotIdx: number;
  readonly itemDefId: number;
  readonly amount: number;
  readonly durability: number;
}

export interface SlotDeleteRow {
  readonly ownerType: OwnerType;
  readonly ownerId: OwnerId;
  readonly slotIdx: number;
}

export interface MariaDbExecutor {
  executeBatch(
    upserts: readonly SlotUpsertRow[],
    deletes: readonly SlotDeleteRow[]
  ): Promise<void>;
}

export interface BatchFlushStats {
  readonly upsertedRows: number;
  readonly deletedRows: number;
  readonly sqlStatementsSaved: number;
}

export class MariaDbWriteBehindBatcher {
  private readonly tracked = new Map<InventoryKey, FlatInventoryContainer>();
  private readonly maxChunkSize: number;
  private flushing = false;

  constructor(
    private readonly executor: MariaDbExecutor,
    maxChunkSize = 500
  ) {
    this.maxChunkSize = maxChunkSize;
  }

  track(key: InventoryKey, container: FlatInventoryContainer): void {
    this.tracked.set(key, container);
  }

  untrack(key: InventoryKey): void {
    this.tracked.delete(key);
  }

  async flush(): Promise<BatchFlushStats> {
    if (this.flushing) {
      return { upsertedRows: 0, deletedRows: 0, sqlStatementsSaved: 0 };
    }

    this.flushing = true;
    const upserts: SlotUpsertRow[] = [];
    const deletes: SlotDeleteRow[] = [];

    try {
      for (const container of this.tracked.values()) {
        if (container.dirtyMask === 0n) continue;

        drainDirtySlots(container, (slotIdx, itemDefId, amount, durability) => {
          if (itemDefId === 0 || amount <= 0) {
            deletes.push({
              ownerType: container.type,
              ownerId: container.ownerId,
              slotIdx,
            });
          } else {
            upserts.push({
              ownerType: container.type,
              ownerId: container.ownerId,
              slotIdx,
              itemDefId,
              amount,
              durability,
            });
          }
        });
      }

      const totalChanges = upserts.length + deletes.length;
      if (totalChanges === 0) {
        return { upsertedRows: 0, deletedRows: 0, sqlStatementsSaved: 0 };
      }

      let chunksExecuted = 0;

      for (let i = 0; i < Math.max(upserts.length, deletes.length); i += this.maxChunkSize) {
        const upsertChunk = upserts.slice(i, i + this.maxChunkSize);
        const deleteChunk = deletes.slice(i, i + this.maxChunkSize);
        await this.executor.executeBatch(upsertChunk, deleteChunk);
        chunksExecuted++;
      }

      return {
        upsertedRows: upserts.length,
        deletedRows: deletes.length,
        sqlStatementsSaved: Math.max(0, totalChanges - chunksExecuted),
      };
    } finally {
      this.flushing = false;
    }
  }
}

export const buildUpsertSql = (rows: readonly SlotUpsertRow[]): string => {
  const values = rows
    .map(
      (r) =>
        `(${r.ownerType},${r.ownerId},${r.slotIdx},${r.itemDefId},${r.amount},${r.durability})`
    )
    .join(',');

  return `INSERT INTO inventory_slots (owner_type,owner_id,slot_idx,item_def_id,amount,durability) VALUES ${values} ON DUPLICATE KEY UPDATE item_def_id=VALUES(item_def_id),amount=VALUES(amount),durability=VALUES(durability)`;
};
