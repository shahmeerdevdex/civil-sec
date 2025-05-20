/**
 * Simple in-memory cache implementation for the Civil Security chatbot
 * Provides caching for vector retrieval and TTS responses
 */

class SimpleCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  generateKey(input, type) {
    return `${type}:${input.toLowerCase().trim()}`;
  }

  get(key) {
    if (this.cache.has(key)) {
      console.log(`Cache hit for key: ${key.substring(0, 20)}...`);
      return this.cache.get(key);
    }
    return null;
  }

  set(key, value) {
    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }

  clear() {
    this.cache.clear();
  }
}

// Create instances for different cache types
const vectorCache = new SimpleCache(100);
const responseCache = new SimpleCache(50);
const ttsCache = new SimpleCache(200);

module.exports = {
  vectorCache,
  responseCache,
  ttsCache
};
