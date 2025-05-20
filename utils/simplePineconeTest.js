/**
 * Simple Pinecone Test Utility
 * 
 * This script tests the Pinecone API directly using the Pinecone SDK
 * without LangChain to help diagnose issues with vector retrieval.
 */

// Load environment variables
require('dotenv').config();
const { Pinecone } = require("@pinecone-database/pinecone");

/**
 * Test Pinecone API directly
 */
async function testPineconeAPI() {
  try {
    console.log('Starting simple Pinecone API test...');
    console.log('PINECONE_API_KEY available:', !!process.env.PINECONE_API_KEY);
    
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
    
    // List available indexes
    console.log('\n--- Available Pinecone Indexes ---');
    const indexes = await pinecone.listIndexes();
    console.log('Indexes:', indexes);
    
    // Test Configuration 1: index='index1'
    console.log('\n--- Test Configuration 1 ---');
    console.log('Index: index1');
    
    try {
      const index1 = pinecone.Index('index1');
      
      // List namespaces in index1
      console.log('\nListing namespaces in index1:');
      const stats1 = await index1.describeIndexStats();
      console.log('Namespaces:', Object.keys(stats1.namespaces || {}));
      console.log('Total vector count:', stats1.totalVectorCount);
      
      // Query vectors in namespace 'Texas'
      console.log('\nQuerying vectors in namespace "Texas":');
      const queryResponse1 = await index1.query({
        vector: Array(1536).fill(0).map(() => Math.random() * 2 - 1), // Random vector
        topK: 2,
        includeMetadata: true,
        namespace: 'Texas'
      });
      
      console.log(`Found ${queryResponse1.matches.length} matches in namespace "Texas"`);
      queryResponse1.matches.forEach((match, i) => {
        console.log(`Match ${i+1}:`);
        console.log(`ID: ${match.id}`);
        console.log(`Score: ${match.score}`);
        console.log('Metadata:', match.metadata);
      });
    } catch (error) {
      console.error('Error in Test Configuration 1:', error.message);
    }
    
    // Test Configuration 2: index='Texas'
    console.log('\n--- Test Configuration 2 ---');
    console.log('Index: Texas');
    
    try {
      const index2 = pinecone.Index('Texas');
      
      // List namespaces in Texas
      console.log('\nListing namespaces in Texas:');
      const stats2 = await index2.describeIndexStats();
      console.log('Namespaces:', Object.keys(stats2.namespaces || {}));
      console.log('Total vector count:', stats2.totalVectorCount);
      
      // Query vectors in namespace 'index1'
      console.log('\nQuerying vectors in namespace "index1":');
      const queryResponse2 = await index2.query({
        vector: Array(1536).fill(0).map(() => Math.random() * 2 - 1), // Random vector
        topK: 2,
        includeMetadata: true,
        namespace: 'index1'
      });
      
      console.log(`Found ${queryResponse2.matches.length} matches in namespace "index1"`);
      queryResponse2.matches.forEach((match, i) => {
        console.log(`Match ${i+1}:`);
        console.log(`ID: ${match.id}`);
        console.log(`Score: ${match.score}`);
        console.log('Metadata:', match.metadata);
      });
    } catch (error) {
      console.error('Error in Test Configuration 2:', error.message);
    }
    
  } catch (error) {
    console.error('Error in Pinecone test:', error);
  }
}

// Run the test
testPineconeAPI().then(() => {
  console.log('\nPinecone test complete');
}).catch(error => {
  console.error('Error running Pinecone test:', error);
});
