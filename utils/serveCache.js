/**
 * Serve cache — abstraction over a key-value cache used by /api/v1/serve.
 *
 * Phase 0 backend: in-memory Map with TTL.
 * Future swap: Redis (single backend swap, no caller changes) — that's why
 * this is a separate module with a stable get/set/delete interface.
 */

class InMemoryBackend {
  constructor() { this.store = new Map(); }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.store.size > 2000) this._prune();
  }

  delete(key) { this.store.delete(key); }

  _prune() {
    const now = Date.now();
    for (const [k, e] of this.store) if (e.expiresAt < now) this.store.delete(k);
  }

  size() { return this.store.size; }
  clear() { this.store.clear(); }
}

const backend = new InMemoryBackend();

module.exports = {
  get(key) { return backend.get(key); },
  set(key, value, ttlMs = 60_000) { backend.set(key, value, ttlMs); },
  delete(key) { backend.delete(key); },
  size() { return backend.size(); },
  clear() { backend.clear(); },

  // Invalidate every cached serve response touching a given inventory.
  // Cache keys look like `serve:<placement_id>:<country>:<device>:<os>`. We
  // can't infer placement_id → inventory_id from the key alone, so we expose
  // a coarser "by placement_id" invalidation. Callers that mutate approvals
  // or creatives should compute the affected placement_ids and call this for
  // each. Cheap because the backend is a Map.
  invalidatePlacement(placementId) {
    const prefix = `serve:${placementId}:`;
    let n = 0;
    for (const k of backend.store.keys()) {
      if (k.startsWith(prefix)) { backend.store.delete(k); n++; }
    }
    return n;
  },

  // Invalidate everything (used after bulk operations or campaign-level changes
  // where computing affected placements is expensive).
  invalidateAll() {
    const n = backend.store.size;
    backend.store.clear();
    return n;
  },

  // For tests / monitoring only — do NOT rely on this being a Map in callers.
  _backend: backend,
};
