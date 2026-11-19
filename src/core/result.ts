// src/core/result.ts
export type Result<T, E extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E extends string>(reason: E): Result<never, E> => ({
  ok: false,
  reason,
});
