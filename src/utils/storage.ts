/**
 * Defensive localStorage helpers.
 *
 * EchoLab keeps every AudioBuffer in memory only, so persistence must stay
 * lightweight. These wrappers guarantee that a hostile or full storage backend
 * (private mode, disabled cookies, `QuotaExceededError`) can never take the
 * studio down: writes fail soft and reads fall back to a supplied default.
 */

const APP_STORAGE_PREFIX = 'echolab_';

export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014)
  );
}

function reportWriteFailure(key: string, error: unknown) {
  if (isQuotaError(error)) {
    console.warn(`[Storage] Quota exceeded for key "${key}". Skipping write.`);
  } else {
    console.error(`[Storage] Failed to write key "${key}":`, error);
  }
}

export function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Persist a value as JSON. Returns `true` on success and never throws, even
 * when the browser rejects the write with `QuotaExceededError`.
 */
export function safeLocalStorageSet(key: string, value: unknown): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    reportWriteFailure(key, error);
    return false;
  }
}

export function safeLocalStorageGet<T>(key: string, fallback: T): T {
  const storage = getStorage();
  if (!storage) return fallback;
  try {
    const item = storage.getItem(key);
    if (item === null) return fallback;
    return JSON.parse(item) as T;
  } catch (error) {
    console.warn(`[Storage] Failed to read or parse key "${key}". Returning fallback.`, error);
    return fallback;
  }
}

export function safeLocalStorageRemove(key: string): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch (error) {
    console.warn(`[Storage] Failed to remove key "${key}":`, error);
    return false;
  }
}

/**
 * Last-resort recovery used by the Error Boundary. Drops every EchoLab key
 * first; only if that still fails does it clear the whole origin.
 */
export function resetLocalCache(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(APP_STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach(key => storage.removeItem(key));
    return;
  } catch (error) {
    console.warn('[Storage] Selective cache reset failed, clearing all local storage:', error);
  }
  try {
    storage.clear();
  } catch (error) {
    console.error('[Storage] Full local storage clear failed:', error);
  }
}

/** Backwards-compatible aliases used across the app. */
export const safeSetItem = safeLocalStorageSet;
export const safeGetItem = safeLocalStorageGet;
export const safeRemoveItem = safeLocalStorageRemove;
