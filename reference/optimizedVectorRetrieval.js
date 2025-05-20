/**
 * Optimized Vector Retrieval Module
 * 
 * This module provides optimized functions for vector retrieval in the chatbot,
 * including parallel processing, caching, and improved performance monitoring.
 */

const { vectorCache } = require('./simpleCache');
const { timeFunction } = require('./agent_chatbot');

/**
 * Process vector retrieval in parallel with other operations
 * @param {Object} vectorStore - The vector store to query
 * @param {string} question - The query question
 * @param {string} indexType - The index type (pinecone or milvus)
 * @returns {Promise<Array>} - The retrieved documents
 */
async function parallelVectorRetrieval(vectorStore, question, indexType) {
  const startTime = Date.now();
  console.log(`Starting vector retrieval for: ${question.substring(0, 30)}...`);
  
  // Normalize question and generate cache key
  const normalizedQuestion = question.trim().toLowerCase();
  const cacheKey = vectorCache.generateKey(normalizedQuestion, indexType);
  
  // Try to get from cache first
  let docs = vectorCache.get(cacheKey);
  
  if (docs) {
    const cacheTime = Date.now() - startTime;
    console.log(`Using cached vector results (${(cacheTime/1000).toFixed(3)}s)`);
    return docs;
  }
  
  // If not in cache, retrieve from vector database with optimized settings
  try {
    if (indexType === "milvus") {
      console.log("Using Milvus retriever with optimized settings");
      const retriever = vectorStore.asRetriever({
        searchType: "similarity", // Changed from mmr to similarity for speed
        k: 2, // Reduced from 3 to 2 for faster retrieval
      });
      
      // Add timeout to prevent hanging
      const retrievalPromise = retriever.getRelevantDocuments(question);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Vector retrieval timeout')), 5000);
      });
      
      const newdocs = await Promise.race([retrievalPromise, timeoutPromise]);
      docs = newdocs.map((doc) => ({
        ...doc,
        pageContent: doc.metadata?.text || doc.pageContent,
      }));
    } else {
      console.log("Using Pinecone retriever with optimized settings");
      const retriever = vectorStore.asRetriever({
        search_type: "similarity", // Changed from mmr to similarity for speed
        search_kwargs: { 
          k: 2, // Reduced from 3 to 2 for faster retrieval
          filter: {} // Add any relevant filters to narrow search scope
        },
      });
      
      // Add timeout to prevent hanging
      const retrievalPromise = retriever.getRelevantDocuments(question);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Vector retrieval timeout')), 5000);
      });
      
      docs = await Promise.race([retrievalPromise, timeoutPromise]);
    }
    
    // Store in cache for future use
    vectorCache.set(cacheKey, docs);
    
    const retrievalTime = Date.now() - startTime;
    console.log(`Vector retrieval completed in ${(retrievalTime/1000).toFixed(3)}s`);
    
    return docs;
  } catch (error) {
    console.error(`Vector retrieval error after ${((Date.now() - startTime)/1000).toFixed(3)}s:`, error.message);
    // Return empty array on error to prevent system crash
    return [];
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

module.exports = {
  parallelVectorRetrieval,
  optimizeConversationHistory
};
