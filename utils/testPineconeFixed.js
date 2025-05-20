/**
 * Test Pinecone with Fixed Configuration
 * 
 * This script tests Pinecone retrieval using the fixed configuration
 * that we know works based on our testing.
 */

// Load environment variables
require('dotenv').config();
const { Pinecone } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("@langchain/pinecone");
const { OpenAIEmbeddings } = require("@langchain/openai");

// Use mock embeddings to avoid OpenAI API key issues
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
 * Test Pinecone retrieval with the fixed configuration
 */
async function testPineconeRetrieval() {
  try {
    console.log('Starting Pinecone retrieval test with fixed configuration...');
    
    // Get the Pinecone API key from environment variables
    const PINECONE_API_KEY = "ea30ba6c-3692-403f-88d2-821c83db860e";
    
    if (!PINECONE_API_KEY) {
      console.error('PINECONE_API_KEY is not defined in environment variables');
      console.log('Please set the PINECONE_API_KEY environment variable and try again');
      return;
    }
    
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
    
    // Test the fixed configuration: index='index1', namespace='Texas'
    console.log('\n--- Testing Fixed Configuration ---');
    console.log('Index: index1, Namespace: Texas');
    
    try {
      // Get the Pinecone index
      const index = pinecone.Index('index1');
      
      // List namespaces in index1
      console.log('\nListing namespaces in index1:');
      const stats = await index.describeIndexStats();
      console.log('Namespaces in index1:', Object.keys(stats.namespaces || {}));
      console.log('Total vector count in index1:', stats.totalVectorCount);
      
      // Create the vector store
      console.log('\nCreating vector store with index1 and namespace Texas...');
      
      try {
        // First, let's try a direct query to see what vectors are available
        console.log('\nTesting direct query to index1...');
        
        // Get metadata about the index to understand its structure
        const stats = await index.describeIndexStats();
        console.log('Index stats:', stats);
        
        // Query using the correct parameters (namespace is not supported in direct query)
        const queryResponse = await index.query({
          vector: randomVector,
          topK: 5,
          includeMetadata: true,
          namespace: 'Texas',        // ← add this
        });
        console.log(`Found ${queryResponse.matches.length} matches in direct query`);
        if (queryResponse.matches.length > 0) {
          queryResponse.matches.forEach((match, i) => {
            console.log(`Match ${i+1}:`);
            console.log(`ID: ${match.id}`);
            console.log(`Score: ${match.score}`);
            if (match.metadata) {
              console.log('Metadata:', match.metadata);
            } else {
              console.log('No metadata available');
            }
          });
        }
        
        // Now try with LangChain's PineconeStore
        console.log('\nTrying LangChain PineconeStore with Texas namespace...');
        
        // Create a vector store using the correct configuration
        const vectorStore = await PineconeStore.fromExistingIndex(
          mockEmbeddings, // Use mock embeddings to avoid OpenAI API key issues
          {
            pineconeIndex: index,
            namespace: 'Texas', // This is correctly supported in LangChain's implementation
          }
        );
        
        // Test query
        console.log('\nQuery: "What security services do you offer?"');
        const retriever = vectorStore.asRetriever({
          search_type: "similarity",
          search_kwargs: { k: 2 }
        });
        
        const results = await retriever.getRelevantDocuments("What security services do you offer?");
        console.log(`Found ${results.length} results from LangChain retriever`);
        
        if (results.length > 0) {
          results.forEach((doc, i) => {
            console.log(`Result ${i+1}:`);
            if (doc.pageContent) {
              console.log(`Content: ${doc.pageContent.substring(0, 150)}...`);
            } else {
              console.log('No page content available');
            }
            console.log('Metadata:', doc.metadata || 'None');
          });
        } else {
          console.log('No results found. This could indicate that either:');
          console.log('1. There is no relevant data in the namespace');
          console.log('2. The vector store is not properly configured');
          console.log('3. The embeddings are not compatible with the stored vectors');
        }
      } catch (error) {
        console.error('Error querying vector store:', error);
        console.log('\nTrying alternative approach with different configuration...');
        
        // Try with a different configuration
        try {
          console.log('\nTrying alternative approach with different configuration...');
          const alternativeVectorStore = await PineconeStore.fromExistingIndex(
            mockEmbeddings, // Use mock embeddings to avoid OpenAI API key issues
            {
              pineconeIndex: index,
              namespace: 'Texas',
              // Don't specify textKey to use default
            }
          );
          
          const alternativeResults = await alternativeVectorStore.similaritySearch(
            "What security services do you offer?",
            2
          );
          
          console.log(`Found ${alternativeResults.length} results with alternative approach`);
          if (alternativeResults.length > 0) {
            alternativeResults.forEach((doc, i) => {
              console.log(`Result ${i+1}:`);
              if (doc.pageContent) {
                console.log(`Content: ${doc.pageContent.substring(0, 150)}...`);
              } else {
                console.log('No page content available');
              }
              console.log('Metadata:', doc.metadata || 'None');
            });
          }
        } catch (alternativeError) {
          console.error('Error with alternative approach:', alternativeError.message);
        }
      }
    } catch (error) {
      console.error('Error in fixed configuration test:', error.message);
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
