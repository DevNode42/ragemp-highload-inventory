// src/core/inventory-engine.ts
import { ItemDefId, OwnerId, SlotIndex, asItemDefId, asSlotIndex } from './brands';
import { withOrderedEntityLocks } from './entity-lock';
import { Result, err, ok } from './result';

export const enum OwnerType {
  Player = 1,
  VehicleTrunk = 2,
  Stash = 3,
}

export type InventoryKey = `${OwnerType}:${OwnerId}`;

export const toInventoryKey = (type: OwnerType, id: OwnerId): InventoryKey =>
  `${type}:${id}`;

const STRIDE = 3;
const OFFSET_ITEM = 0;
const OFFSET_AMOUNT = 1;
const OFFSET_DURABILITY = 2;

export interface FlatInventoryContainer {
  readonly type: OwnerType;
  readonly ownerId: OwnerId;
  readonly capacity: number;
  readonly buffer: Int32Array;
  dirtyMask: bigint;
}

export type TransferError =
  | 'CONTAINER_NOT_LOADED'
  | 'INVALID_SLOT'
  | 'EMPTY_SOURCE_SLOT'
  | 'INSUFFICIENT_AMOUNT'
  | 'TARGET_SLOT_OCCUPIED'
  | 'STACK_LIMIT_EXCEEDED'
  | 'NO_OP_TRANSFER';

export interface TransferReceipt {
  readonly itemDefId: ItemDefId;
  readonly movedAmount: number;
  readonly fromSlot: SlotIndex;
  readonly toSlot: SlotIndex;
}

const containers = new Map<InventoryKey, FlatInventoryContainer>();
const maxStackByDef = new Map<ItemDefId, number>();

export const registerItemDef = (itemDefId: ItemDefId, maxStack: number): void => {
  maxStackByDef.set(itemDefId, maxStack);
};

export const mountContainer = (
  type: OwnerType,
  ownerId: OwnerId,
  capacity: number
): FlatInventoryContainer => {
  const key = toInventoryKey(type, ownerId);
  const container: FlatInventoryContainer = {
    type,
    ownerId,
    capacity,
    buffer: new Int32Array(capacity * STRIDE),
    dirtyMask: 0n,
  };
  containers.set(key, container);
  return container;
};

export const getContainer = (
  type: OwnerType,
  ownerId: OwnerId
): FlatInventoryContainer | undefined => containers.get(toInventoryKey(type, ownerId));

export const setSlotDirect = (
  container: FlatInventoryContainer,
  slot: SlotIndex,
  itemDefId: ItemDefId,
  amount: number,
  durability = 1000
): void => {
  const base = slot * STRIDE;
  container.buffer[base + OFFSET_ITEM] = itemDefId;
  container.buffer[base + OFFSET_AMOUNT] = amount;
  container.buffer[base + OFFSET_DURABILITY] = durability;
  container.dirtyMask |= 1n << BigInt(slot);
};

export const transferItemAtomic = (
  srcType: OwnerType,
  srcOwner: OwnerId,
  srcSlot: SlotIndex,
  dstType: OwnerType,
  dstOwner: OwnerId,
  dstSlot: SlotIndex,
  amount: number
): Promise<Result<TransferReceipt, TransferError>> => {
  const srcKey = toInventoryKey(srcType, srcOwner);
  const dstKey = toInventoryKey(dstType, dstOwner);

  return withOrderedEntityLocks([srcKey, dstKey], () => {
    if (srcKey === dstKey && srcSlot === dstSlot) {
      return err('NO_OP_TRANSFER');
    }

    const src = containers.get(srcKey);
    const dst = containers.get(dstKey);
    if (!src || !dst) return err('CONTAINER_NOT_LOADED');

    if (srcSlot < 0 || srcSlot >= src.capacity || dstSlot < 0 || dstSlot >= dst.capacity) {
      return err('INVALID_SLOT');
    }

    const srcBase = srcSlot * STRIDE;
    const dstBase = dstSlot * STRIDE;

    const srcItem = asItemDefId(src.buffer[srcBase + OFFSET_ITEM] ?? 0);
    const srcAmount = src.buffer[srcBase + OFFSET_AMOUNT] ?? 0;
    const srcDurability = src.buffer[srcBase + OFFSET_DURABILITY] ?? 0;

    if (srcItem === 0 || srcAmount <= 0) return err('EMPTY_SOURCE_SLOT');
    if (amount <= 0 || srcAmount < amount) return err('INSUFFICIENT_AMOUNT');

    const dstItem = asItemDefId(dst.buffer[dstBase + OFFSET_ITEM] ?? 0);
    const dstAmount = dst.buffer[dstBase + OFFSET_AMOUNT] ?? 0;
    const maxStack = maxStackByDef.get(srcItem) ?? 1;

    if (dstItem !== 0 && dstItem !== srcItem) {
      if (amount !== srcAmount) return err('TARGET_SLOT_OCCUPIED');

      const dstDurability = dst.buffer[dstBase + OFFSET_DURABILITY] ?? 0;

      src.buffer[srcBase + OFFSET_ITEM] = dstItem;
      src.buffer[srcBase + OFFSET_AMOUNT] = dstAmount;
      src.buffer[srcBase + OFFSET_DURABILITY] = dstDurability;

      dst.buffer[dstBase + OFFSET_ITEM] = srcItem;
      dst.buffer[dstBase + OFFSET_AMOUNT] = srcAmount;
      dst.buffer[dstBase + OFFSET_DURABILITY] = srcDurability;
    } else {
      if (dstAmount + amount > maxStack) return err('STACK_LIMIT_EXCEEDED');

      const remaining = srcAmount - amount;
      src.buffer[srcBase + OFFSET_ITEM] = remaining > 0 ? srcItem : 0;
      src.buffer[srcBase + OFFSET_AMOUNT] = remaining;
      src.buffer[srcBase + OFFSET_DURABILITY] = remaining > 0 ? srcDurability : 0;

      dst.buffer[dstBase + OFFSET_ITEM] = srcItem;
      dst.buffer[dstBase + OFFSET_AMOUNT] = dstAmount + amount;
      dst.buffer[dstBase + OFFSET_DURABILITY] = srcDurability;
    }

    src.dirtyMask |= 1n << BigInt(srcSlot);
    dst.dirtyMask |= 1n << BigInt(dstSlot);

    return ok({
      itemDefId: srcItem,
      movedAmount: amount,
      fromSlot: asSlotIndex(srcSlot),
      toSlot: asSlotIndex(dstSlot),
    });
  });
};

export const drainDirtySlots = (
  container: FlatInventoryContainer,
  visitor: (slot: number, itemDefId: number, amount: number, durability: number) => void
): number => {
  let mask = container.dirtyMask;
  if (mask === 0n) return 0;

  container.dirtyMask = 0n;
  let count = 0;

  for (let slot = 0; slot < container.capacity; slot++) {
    if ((mask & (1n << BigInt(slot))) === 0n) continue;
    const base = slot * STRIDE;
    visitor(
      slot,
      container.buffer[base + OFFSET_ITEM] ?? 0,
      container.buffer[base + OFFSET_AMOUNT] ?? 0,
      container.buffer[base + OFFSET_DURABILITY] ?? 0
    );
    count++;
  }

  return count;
};
