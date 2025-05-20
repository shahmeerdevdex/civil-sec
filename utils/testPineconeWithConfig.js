/**
 * Test Pinecone with Civil Security Configuration
 * 
 * This script tests Pinecone retrieval using the same configuration
 * as the Civil Security app, but in a standalone environment.
 */

// Load environment variables
require('dotenv').config();
const { Pinecone } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("@langchain/pinecone");
const { OpenAIEmbeddings } = require("@langchain/openai");
const fs = require('fs');
const path = require('path');

// Read the Google configuration file
const googleConfigPath = path.join(__dirname, '..', 'google.json');
let googleConfig;

try {
  const configData = fs.readFileSync(googleConfigPath, 'utf8');
  googleConfig = JSON.parse(configData);
  console.log('Successfully loaded Google config');
} catch (error) {
  console.error('Error loading Google config:', error.message);
  googleConfig = {};
}

// Set up a mock embeddings function for testing
const mockEmbeddings = {
  embedDocuments: async (texts) => {
    // Return mock embeddings (1536 dimensions)
    return texts.map(() => Array(1536).fill(0).map(() => Math.random() * 2 - 1));
  },
  embedQuery: async (text) => {
    // Return a mock embedding (1536 dimensions)
    return Array(1536).fill(0).map(() => Math.random() * 2 - 1);
  }
};

/**
 * Test Pinecone retrieval with Civil Security configuration
 */
async function testPineconeRetrieval() {
  try {
    console.log('Starting Pinecone retrieval test with Civil Security configuration...');
    
    // Use a hardcoded API key for testing
    // This is the same approach used in the Civil Security app
    const PINECONE_API_KEY = process.env.PINECONE_API_KEY || 
      "ea30ba6c-3692-403f-88d2-821c83db860e";
    
    console.log('Using Pinecone API key:', PINECONE_API_KEY ? 'Available' : 'Not available');
    
    // Initialize Pinecone client
    const pinecone = new Pinecone({
      apiKey: PINECONE_API_KEY,
    });
    
    // List available indexes
    console.log('\n--- Available Pinecone Indexes ---');
    try {
      const indexes = await pinecone.listIndexes();
      console.log('Indexes:', indexes);
    } catch (error) {
      console.error('Error listing indexes:', error.message);
    }
    
    // Test Configuration 1: index='index1', namespace='Texas'
    console.log('\n--- Test Configuration 1 ---');
    console.log('Index: index1, Namespace: Texas');
    
    try {
      // Use the mock embeddings to avoid OpenAI API key issues
      const vectorStore1 = await PineconeStore.fromExistingIndex(mockEmbeddings, {
        pineconeIndex: pinecone.Index('index1'),
        namespace: 'Texas'
      });
      
      // Test query
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
    } catch (error) {
      console.error('Error in Test Configuration 1:', error.message);
    }
    
    // Test Configuration 2: index='Texas', namespace='index1'
    console.log('\n--- Test Configuration 2 ---');
    console.log('Index: Texas, Namespace: index1');
    
    try {
      // Use the mock embeddings to avoid OpenAI API key issues
      const vectorStore2 = await PineconeStore.fromExistingIndex(mockEmbeddings, {
        pineconeIndex: pinecone.Index('Texas'),
        namespace: 'index1'
      });
      
      // Test query
      console.log('\nQuery: "What security services do you offer?"');
      const retriever2 = vectorStore2.asRetriever({
        search_type: "similarity",
        search_kwargs: { k: 2 }
      });
      
      const results2 = await retriever2.getRelevantDocuments("What security services do you offer?");
      console.log(`Found ${results2.length} results`);
      results2.forEach((doc, i) => {
        console.log(`Result ${i+1}:`);
        console.log(`Content: ${doc.pageContent.substring(0, 150)}...`);
        console.log('Metadata:', doc.metadata);
      });
    } catch (error) {
      console.error('Error in Test Configuration 2:', error.message);
    }
    
    // Test direct Pinecone API
    console.log('\n--- Testing Direct Pinecone API ---');
    
    try {
      // Test index1
      console.log('\nTesting index1:');
      const index1 = pinecone.Index('index1');
      
      // List namespaces in index1
      const stats1 = await index1.describeIndexStats();
      console.log('Namespaces in index1:', Object.keys(stats1.namespaces || {}));
      console.log('Total vector count in index1:', stats1.totalVectorCount);
      
      // Test Texas index
      console.log('\nTesting Texas index:');
      const indexTexas = pinecone.Index('Texas');
      
      // List namespaces in Texas
      const statsTexas = await indexTexas.describeIndexStats();
      console.log('Namespaces in Texas:', Object.keys(statsTexas.namespaces || {}));
      console.log('Total vector count in Texas:', statsTexas.totalVectorCount);
    } catch (error) {
      console.error('Error testing direct Pinecone API:', error.message);
    }
    
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
