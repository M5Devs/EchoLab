/**
 * Safe localStorage utilities with QuotaExceededError protection and fallback handling.
 */

export function safeSetItem(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.code === 22)
    ) {
      console.warn(`[Storage] Quota exceeded for key "${key}". Skipping write.`);
    } else {
      console.error(`[Storage] Failed to write key "${key}":`, error);
    }
    return false;
  }
}

export function safeGetItem<T>(key: string, fallback: T): T {
  try {
    const item = localStorage.getItem(key);
    if (item === null) return fallback;
    return JSON.parse(item) as T;
  } catch (error) {
    console.warn(`[Storage] Failed to read or parse key "${key}". Returning fallback.`, error);
    return fallback;
  }
}

export function safeRemoveItem(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.warn(`[Storage] Failed to remove key "${key}":`, error);
    return false;
  }
}
