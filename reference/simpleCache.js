/**
 * Simple in-memory cache for vector retrieval and other expensive operations
 */

class SimpleCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.ttl = options.ttl || 3600000; // Default: 1 hour
    this.maxSize = options.maxSize || 100;
    this.stats = {
      hits: 0,
      misses: 0
    };
  }

  /**
   * Generate a cache key from input parameters
   */
  generateKey(query, namespace = '') {
    // Simple normalization to improve cache hit rate
    const normalizedQuery = query.trim().toLowerCase();
    return `${namespace}:${normalizedQuery}`;
  }

  /**
   * Get item from cache
   */
  get(key) {
    if (!this.cache.has(key)) {
      this.stats.misses++;
      return null;
    }

    const item = this.cache.get(key);
    
    // Check if item has expired
    if (item.expiry < Date.now()) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return item.value;
  }

  /**
   * Store item in cache
   */
  set(key, value) {
    // Basic LRU - remove oldest items if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + this.ttl
    });

    return value;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
    
    return {
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: `${hitRate.toFixed(2)}%`
    };
  }

  /**
   * Clear the cache
   */
  clear() {
    this.cache.clear();
  }
}

// Create singleton instances for different cache types
const vectorCache = new SimpleCache();
const responseCache = new SimpleCache({ ttl: 1800000 }); // 30 minutes

module.exports = {
  vectorCache,
  responseCache
};
