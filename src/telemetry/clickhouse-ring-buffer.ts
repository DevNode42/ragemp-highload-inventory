// src/telemetry/clickhouse-ring-buffer.ts
import { ItemDefId, OwnerId } from '../core/brands';
import { OwnerType } from '../core/inventory-engine';

export type EconomyAction = 'TRANSFER' | 'CRAFT_CONSUME' | 'CRAFT_PRODUCE' | 'DROP' | 'PICKUP';

export interface EconomyTelemetryEvent {
  ts: number;
  txId: bigint;
  action: EconomyAction;
  srcOwnerType: OwnerType;
  srcOwnerId: OwnerId;
  dstOwnerType: OwnerType;
  dstOwnerId: OwnerId;
  itemDefId: ItemDefId;
  deltaAmount: number;
}

export interface ClickHouseSink {
  insertJsonEachRow(table: string, ndjsonPayload: string): Promise<void>;
}

export class ClickHouseTelemetryRingBuffer {
  private readonly ring: EconomyTelemetryEvent[];
  private readonly capacity: number;
  private head = 0;
  private tail = 0;
  private count = 0;
  private droppedOverflow = 0;
  private sequence = 0n;

  constructor(
    private readonly sink: ClickHouseSink,
    private readonly serverShard: string,
    capacity = 16_384
  ) {
    this.capacity = capacity;
    this.ring = Array.from({ length: capacity }, () => ({
      ts: 0,
      txId: 0n,
      action: 'TRANSFER',
      srcOwnerType: OwnerType.Player,
      srcOwnerId: 0 as OwnerId,
      dstOwnerType: OwnerType.Player,
      dstOwnerId: 0 as OwnerId,
      itemDefId: 0 as ItemDefId,
      deltaAmount: 0,
    }));
  }

  push(
    action: EconomyAction,
    srcOwnerType: OwnerType,
    srcOwnerId: OwnerId,
    dstOwnerType: OwnerType,
    dstOwnerId: OwnerId,
    itemDefId: ItemDefId,
    deltaAmount: number
  ): boolean {
    if (this.count === this.capacity) {
      this.droppedOverflow++;
      return false;
    }

    const slot = this.ring[this.tail]!;
    this.sequence += 1n;

    slot.ts = Date.now();
    slot.txId = this.sequence;
    slot.action = action;
    slot.srcOwnerType = srcOwnerType;
    slot.srcOwnerId = srcOwnerId;
    slot.dstOwnerType = dstOwnerType;
    slot.dstOwnerId = dstOwnerId;
    slot.itemDefId = itemDefId;
    slot.deltaAmount = deltaAmount;

    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    return true;
  }

  get pendingCount(): number {
    return this.count;
  }

  get overflowCount(): number {
    return this.droppedOverflow;
  }

  async flushBatch(maxBatch = 2048): Promise<number> {
    if (this.count === 0) return 0;

    const batchSize = Math.min(this.count, maxBatch);
    const lines: string[] = new Array(batchSize);

    for (let i = 0; i < batchSize; i++) {
      const ev = this.ring[this.head]!;
      lines[i] =
        `{"ts":${ev.ts},"tx_id":"${ev.txId}","action":"${ev.action}",` +
        `"src_owner_type":${ev.srcOwnerType},"src_owner_id":${ev.srcOwnerId},` +
        `"dst_owner_type":${ev.dstOwnerType},"dst_owner_id":${ev.dstOwnerId},` +
        `"item_def_id":${ev.itemDefId},"delta_amount":${ev.deltaAmount},` +
        `"server_shard":"${this.serverShard}"}`;

      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }

    await this.sink.insertJsonEachRow('economy_item_events', lines.join('\n'));
    return batchSize;
  }
}
