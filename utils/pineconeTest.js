/**
 * Pinecone Test Utility
 * 
 * This script tests the Pinecone integration directly to help diagnose issues
 * with vector retrieval in the Civil Security app.
 */

// Load environment variables from the correct path
require('dotenv').config();

// Import required packages
const { Pinecone } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("@langchain/pinecone");
const { OpenAIEmbeddings } = require("@langchain/openai");

// Log environment variables (without showing the actual values)
console.log('Environment variables:');
console.log('OPENAI_API_KEY available:', !!process.env.OPENAI_API_KEY);
console.log('PINECONE_API_KEY available:', !!process.env.PINECONE_API_KEY);

// Initialize OpenAI embeddings
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
  model: "text-embedding-3-small",
});

/**
 * Test Pinecone retrieval with different configurations
 */
async function testPineconeRetrieval() {
  try {
    console.log('Starting Pinecone retrieval test...');
    console.log('PINECONE_API_KEY available:', !!process.env.OPENAI_API_KEY);
    
    // Check if Pinecone API key is available
    if (!process.env.PINECONE_API_KEY) {
      console.error('PINECONE_API_KEY is not defined in environment variables');
      console.log('Please set the PINECONE_API_KEY environment variable and try again');
      return;
    }
    
    // Initialize Pinecone client
    const pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
    
    // Test configuration 1: index='index1', namespace='Texas'
    console.log('\n--- Test Configuration 1 ---');
    console.log('Index: index1, Namespace: Texas');
    
    try {
      const pineconeIndex1 = pinecone.Index('index1');
      const vectorStore1 = await PineconeStore.fromExistingIndex(embeddings, {
        pineconeIndex: pineconeIndex1,
        namespace: 'Texas'
      });
      
      // Test query 1
      console.log('\nQuery: "What security services do you offer?"');
      const retriever1 = vectorStore1.asRetriever({
        search_type: "similarity",
        search_kwargs: { k: 2 }
      });
      
      const results1 = await retriever1.getRelevantDocuments("What security services do you offer?");
      console.log(`Found ${results1.length} results`);
      results1.forEach((doc, i) => {
        console.log(`Result ${i+1}:`);
        console.log(`Content: ${doc.pageContent.substring(0, 150)}...`);
        console.log('Metadata:', doc.metadata);
      });
      
      // Test query 2
      console.log('\nQuery: "What is an apple?"');
      const results2 = await retriever1.getRelevantDocuments("What is an apple?");
      console.log(`Found ${results2.length} results`);
      results2.forEach((doc, i) => {
        console.log(`Result ${i+1}:`);
        console.log(`Content: ${doc.pageContent.substring(0, 150)}...`);
        console.log('Metadata:', doc.metadata);
      });
    } catch (error) {
      console.error('Error in Test Configuration 1:', error.message);
    }
    
    // Test configuration 2: index='Texas', namespace='index1'
    console.log('\n--- Test Configuration 2 ---');
    console.log('Index: Texas, Namespace: index1');
    
    try {
      const pineconeIndex2 = pinecone.Index('Texas');
      const vectorStore2 = await PineconeStore.fromExistingIndex(embeddings, {
        pineconeIndex: pineconeIndex2,
        namespace: 'index1'
      });
      
      // Test query 1
      console.log('\nQuery: "What security services do you offer?"');
      const retriever2 = vectorStore2.asRetriever({
        search_type: "similarity",
        search_kwargs: { k: 2 }
      });
      
      const results3 = await retriever2.getRelevantDocuments("What security services do you offer?");
      console.log(`Found ${results3.length} results`);
      results3.forEach((doc, i) => {
        console.log(`Result ${i+1}:`);
        console.log(`Content: ${doc.pageContent.substring(0, 150)}...`);
        console.log('Metadata:', doc.metadata);
      });
      
      // Test query 2
      console.log('\nQuery: "What is an apple?"');
      const results4 = await retriever2.getRelevantDocuments("What is an apple?");
      console.log(`Found ${results4.length} results`);
      results4.forEach((doc, i) => {
        console.log(`Result ${i+1}:`);
        console.log(`Content: ${doc.pageContent.substring(0, 150)}...`);
        console.log('Metadata:', doc.metadata);
      });
    } catch (error) {
      console.error('Error in Test Configuration 2:', error.message);
    }
    
    // List available indexes
    console.log('\n--- Available Pinecone Indexes ---');
    const indexes = await pinecone.listIndexes();
    console.log('Indexes:', indexes);
    
  } catch (error) {
    console.error('Error in Pinecone test:', error);
  }
}

// Run the test
testPineconeRetrieval().then(() => {
  console.log('\nPinecone test complete');
}).catch(error => {
  console.error('Error running Pinecone test:', error);
});
