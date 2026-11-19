// src/core/entity-lock.ts
const tails = new Map<string, Promise<void>>();

const acquireSingle = (key: string): Promise<() => void> => {
  const previous = tails.get(key) ?? Promise.resolve();
  let releaseFn!: () => void;

  const current = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const tail = previous.then(() => current);
  tails.set(key, tail);

  return previous.then(() => () => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
    releaseFn();
  });
};

export const withOrderedEntityLocks = async <T>(
  rawKeys: readonly string[],
  task: () => Promise<T> | T
): Promise<T> => {
  const uniqueSorted = [...new Set(rawKeys)].sort();
  const releases: Array<() => void> = [];

  try {
    for (const key of uniqueSorted) {
      releases.push(await acquireSingle(key));
    }
    return await task();
  } finally {
    for (let i = releases.length - 1; i >= 0; i--) {
      releases[i]?.();
    }
  }
};
