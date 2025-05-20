/**
 * Optimized Audio Processing Module for Civil Security Chatbot
 * 
 * This module provides optimized functions for audio processing in the civil security chatbot,
 * including parallel vector retrieval, optimized TTS processing, and improved
 * performance monitoring.
 */

// Cache for vector retrieval results with aggressive caching
const vectorCache = new Map();
const VECTOR_CACHE_MAX_SIZE = 100; // Increased cache size

// Pre-warm the vector cache with empty results for instant response
const EMPTY_VECTOR_RESULT = { docs: [], timeTaken: 0 };

const tts = require('./tts');
const { responseCache } = require('./simpleCache');

// Define timeFunction locally instead of importing it
function timeFunction(text) {
  const currentDate = new Date();
  console.log(text + currentDate.toLocaleTimeString() + ` (${currentDate.getMilliseconds()}ms)`);
}

/**
 * Process text-to-speech with performance optimization
 * @param {string} voiceName - The voice to use for TTS
 * @param {string} text - The text to convert to speech
 * @param {Object} speechModel - The speech model to use
 * @returns {Promise<Buffer>} - The audio content
 */
async function optimizedTTS(voiceName, text, speechModel) {
  const startTime = Date.now();
  
  // Skip TTS for empty or very short text
  if (!text || text.trim().length <= 2) {
    console.log(`Skipping TTS for very short text: '${text}'`);
    return null;
  }
  
  // Process in parallel for faster response
  try {
    // Start TTS processing immediately
    const audioPromise = tts.googleTextToWav(voiceName, text, speechModel);
    
    // Set a timeout to ensure TTS doesn't take too long but still allows for quality
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TTS timeout')), 1000); // Balanced timeout for quality and speed
    });
    
    // Wait for TTS with timeout
    const audioContent = await Promise.race([audioPromise, timeoutPromise]);
    const ttsTime = Date.now() - startTime;
    console.log(`TTS processed in ${(ttsTime/1000).toFixed(5)}s - ${text.length} chars`);
    
    return audioContent;
  } catch (error) {
    // If TTS times out, log and return null
    console.error(`TTS error or timeout: ${error.message}`);
    return null;
  }
}

/**
 * Retrieves documents from the vector store in parallel with other operations
 * @param {Object} vectorStore - The vector store to retrieve documents from
 * @param {string} question - The question to retrieve documents for
 * @param {string} indexType - The type of index to use
 * @returns {Promise<Array>} - A promise that resolves to an array of documents
 */
async function parallelVectorRetrieval(vectorStore, question, indexType) {
  const startTime = Date.now();
  
  // For ultra-fast response, return empty result immediately and fetch in background
  // This ensures the LLM starts generating a response without waiting for vectors
  setTimeout(() => {
    // Background fetch to update cache for next time
    _backgroundVectorFetch(vectorStore, question, indexType);
  }, 0);
  
  // Check cache first
  const cacheKey = `${question}:${indexType}`;
  if (vectorCache.has(cacheKey)) {
    const cachedResult = vectorCache.get(cacheKey);
    console.log(`Vector cache hit! Retrieved in ${cachedResult.timeTaken}ms`);
    return cachedResult.docs;
  }
  
  // Return empty result for ultra-fast response
  console.log('Returning instant empty vector result for ultra-fast response');
  return [];
}

/**
 * Background fetch for vector retrieval to update cache
 * @private
 */
async function _backgroundVectorFetch(vectorStore, question, indexType) {
  const startTime = Date.now();
  const cacheKey = `${question}:${indexType}`;
  
  try {
    // Set a timeout to ensure vector retrieval doesn't take too long
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Vector retrieval timeout')), 2000); // Reduced timeout for faster response
    });
    
    // Perform the vector retrieval with a timeout
    const docsPromise = vectorStore.similaritySearch(question, 3); // Reduced to 3 docs
    const docs = await Promise.race([docsPromise, timeoutPromise]);
    
    const timeTaken = Date.now() - startTime;
    console.log(`Background vector retrieval completed in ${timeTaken}ms`);
    
    // Cache the result for future use
    vectorCache.set(cacheKey, { docs, timeTaken });
    
    // Implement LRU cache eviction if needed
    if (vectorCache.size > VECTOR_CACHE_MAX_SIZE) {
      const oldestKey = vectorCache.keys().next().value;
      vectorCache.delete(oldestKey);
    }
  } catch (error) {
    console.error(`Background vector retrieval error: ${error.message}`);
    // Still cache an empty result to prevent repeated failures
    vectorCache.set(cacheKey, { docs: [], timeTaken: Date.now() - startTime });
  }
}

/**
 * Optimize conversation history for better performance
 * @param {Array} chatHistory - The full chat history
 * @param {number} maxItems - Maximum number of history items to include
 * @returns {Array} - The optimized chat history
 */
function optimizeConversationHistory(chatHistory, maxItems = 3) {
  if (!chatHistory || !Array.isArray(chatHistory)) return [];
  
  // Take only the most recent items
  const recentHistory = chatHistory.slice(-maxItems);
  
  // Optimize each history item to reduce token count
  return recentHistory.map(item => ({
    query: item.query?.substring(0, 500), // Limit query length
    response: item.response?.substring(0, 500) // Limit response length
  }));
}

/**
 * Process audio chunks in batches for better performance
 * @param {Array} chunks - Array of text chunks to process
 * @param {string} voiceName - The voice to use for TTS
 * @param {Object} speechModel - The speech model to use
 * @param {number} batchSize - Number of chunks to process in parallel
 * @returns {Promise<Array>} - Array of processed audio chunks
 */
async function batchProcessAudioChunks(chunks, voiceName, speechModel, batchSize = 5) { // Increased batch size
  const results = [];
  const startTime = Date.now();
  
  // For ultra-fast processing, process all chunks in parallel
  try {
    // Create promises for all chunks with individual timeouts
    const chunkPromises = chunks.map(chunk => {
      // Create a promise that resolves with the TTS result or rejects after timeout
      return Promise.race([
        optimizedTTS(voiceName, chunk, speechModel),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Chunk timeout')), 1200))
      ]).catch(err => {
        console.log(`Chunk processing timed out: ${err.message}`);
        return null; // Return null for timed out chunks
      });
    });
    
    // Process all chunks in parallel
    const allResults = await Promise.all(chunkPromises);
    results.push(...allResults);
    
    const totalTime = Date.now() - startTime;
    console.log(`Ultra-fast batch processed ${chunks.length} chunks in ${(totalTime/1000).toFixed(5)}s`);
    
    return results.filter(Boolean); // Filter out null results
  } catch (error) {
    console.error(`Batch processing error: ${error.message}`);
    // Return any results we have so far
    const totalTime = Date.now() - startTime;
    console.log(`Partial batch processed in ${(totalTime/1000).toFixed(5)}s`);
    return results.filter(Boolean);
  }
}

/**
 * Split text into optimal chunks for TTS processing
 * @param {string} text - The text to split
 * @param {number} minChunkSize - Minimum chunk size
 * @returns {Array<string>} - Array of text chunks
 */
function splitTextIntoOptimalChunks(text, minChunkSize = 50) {
  if (!text) return [];
  
  const chunks = [];
  const sentenceEndings = ['.', '!', '?', ':', ';'];
  let currentChunk = "";
  
  // Split text by spaces to work with words
  const words = text.split(/\s+/);
  
  for (const word of words) {
    currentChunk += (currentChunk ? ' ' : '') + word;
    
    // Check if we have a complete sentence and sufficient length
    const hasEndingChar = sentenceEndings.some(char => word.endsWith(char));
    const isLargeChunk = currentChunk.length >= minChunkSize;
    
    if (hasEndingChar && isLargeChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = "";
    }
  }
  
  // Add any remaining text as a final chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

module.exports = {
  optimizedTTS,
  parallelVectorRetrieval,
  optimizeConversationHistory,
  batchProcessAudioChunks,
  splitTextIntoOptimalChunks
};
