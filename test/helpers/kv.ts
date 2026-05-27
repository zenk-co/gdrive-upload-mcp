import type { KVNamespace } from "@cloudflare/workers-types";

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryKV {
  private store = new Map<string, Entry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    const expiresAt =
      options?.expirationTtl != null ? Date.now() + options.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  list(): string[] {
    return [...this.store.keys()];
  }

  clear(): void {
    this.store.clear();
  }

  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
