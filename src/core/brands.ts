// src/core/brands.ts
declare const brand: unique symbol;

export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type OwnerId = Brand<number, 'OwnerId'>;
export type ItemDefId = Brand<number, 'ItemDefId'>;
export type SlotIndex = Brand<number, 'SlotIndex'>;
export type TxId = Brand<bigint, 'TxId'>;

export const asOwnerId = (v: number): OwnerId => v as OwnerId;
export const asItemDefId = (v: number): ItemDefId => v as ItemDefId;
export const asSlotIndex = (v: number): SlotIndex => v as SlotIndex;
