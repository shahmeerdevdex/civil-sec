/**
 * Civil Security Chatbot Agent
 * 
 * This module provides the core chatbot functionality for the Civil Security system,
 * including optimized conversation processing, vector retrieval, and LLM integration.
 */

const {
  ChatOpenAI,
  OpenAIEmbeddings,
  AzureChatOpenAI,
} = require("@langchain/openai");
const { ChatGroq } = require("@langchain/groq");
const {
  ChatPromptTemplate,
  MessagesPlaceholder,
} = require("@langchain/core/prompts");
const {
  createStuffDocumentsChain,
} = require("langchain/chains/combine_documents");
const {
  HumanMessage,
  AIMessage,
  SystemMessage,
} = require("@langchain/core/messages");
const dotenv = require("dotenv");

// Load environment variables from .env file
dotenv.config();

const options = {
  timeZone: "Asia/Karachi",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};
const timeFormatter = new Intl.DateTimeFormat("en-US", options);

async function timeFunction(text) {
  const currentDate = new Date();

  const timeParts = timeFormatter.formatToParts(currentDate);
  let hours = timeParts.find((part) => part.type === "hour").value;
  let minutes = timeParts.find((part) => part.type === "minute").value;
  let seconds = timeParts.find((part) => part.type === "second").value;
  let milliseconds = currentDate.getMilliseconds();
  let currentTime = `${hours}h ${minutes}m ${seconds}s ${milliseconds}ms`;
  console.log(text + currentTime);
}

// Import the simple cache for vector retrieval
const { vectorCache } = require('./simpleCache');

/**
 * Optimized chat processing function with parallel execution
 */
async function* processParallelChat(
  chain,
  question,
  chatHistory,
  vectorStore,
  indexType,
  language,
  formData
) {
  timeFunction("Before Retriever: ");
  
  // Start vector retrieval as a separate promise with timeout
  const vectorPromise = (async () => {
    // Normalize question and generate cache key
    const normalizedQuestion = question.trim().toLowerCase();
    const cacheKey = vectorCache.generateKey(normalizedQuestion, indexType);
    
    // Try to get from cache first
    let docs = vectorCache.get(cacheKey);
    
    if (docs) {
      console.log("Using cached vector results");
      return docs;
    }
    
    // If not in cache, start a timeout for vector retrieval
    const retrievalPromise = (async () => {
      try {
        if (indexType === "milvus") {
          console.log("milvus retriever working with ultra-fast settings");
          const retriever = vectorStore.asRetriever({
            searchType: "similarity", // Faster than mmr
            k: 1, // Reduced to 1 for maximum speed
          });
          let newdocs = await retriever.getRelevantDocuments(question);
          return newdocs.map((doc) => ({
            ...doc,
            pageContent: doc.metadata?.text || doc.pageContent,
          }));
        } else {
          console.log("pinecone retriever working with ultra-fast settings");
          
          // Check if vectorStore is properly initialized
          if (!vectorStore || typeof vectorStore.asRetriever !== 'function') {
            console.error("Vector store not properly initialized");
            return [];
          }
          
          try {
            const retriever = vectorStore.asRetriever({
              search_type: "similarity", // Faster than mmr
              search_kwargs: { 
                k: 1, // Reduced to 1 for maximum speed
                filter: {} // Add any relevant filters to narrow search scope
              },
            });
            
            return await retriever.getRelevantDocuments(question);
          } catch (innerError) {
            console.error("Error in Pinecone retrieval:", innerError);
            // Return empty results instead of crashing
            return [];
          }
        }
      } catch (error) {
        console.error("Error in vector retrieval:", error);
        return [];
      }
    })();
    
    // Increase timeout for vector retrieval to ensure we get results
    const timeoutPromise = new Promise(resolve => {
      setTimeout(() => {
        console.log("Vector retrieval timeout - using empty results");
        resolve([]);
      }, 5000); // Increased to 5 seconds to allow more time for retrieval
    });
    
    // Race the retrieval against the timeout
    docs = await Promise.race([retrievalPromise, timeoutPromise]);
    
    // Store in cache for future use (even if empty)
    vectorCache.set(cacheKey, docs);
    return docs;
  })();

  // Optimize conversation history to reduce token usage
  const optimizedHistory = optimizeConversationHistory(chatHistory);
  timeFunction("After optimizing history: ");

  // Start LLM processing in parallel with vector retrieval
  const docsPromise = vectorPromise;
  
  // Prepare for streaming response
  let context = "";
  
  try {
    // Wait for vector retrieval (with timeout protection)
    let docs = await docsPromise;
    timeFunction("After Retriever: ");
    
    // Ensure docs is always an array to prevent 'documents.map is not a function' error
    if (!docs || !Array.isArray(docs)) {
      console.warn("Retrieved documents is not an array, using empty array instead");
      docs = [];
    }
    
    // Extract context from retrieved documents with validation
    if (docs && Array.isArray(docs) && docs.length > 0) {
      // Ensure each document has the required pageContent property
      context = docs.map((doc) => {
        // Validate document structure
        if (!doc) return "";
        if (typeof doc === "string") return doc;
        
        // Handle various document formats
        const content = doc.pageContent || doc.text || doc.content || "";
        return content;
      }).filter(content => content.trim() !== "").join("\n");
    }
    
    // Prepare chat history in the format expected by the LLM
    const formattedHistory = [];
    if (optimizedHistory && optimizedHistory.length > 0) {
      for (const h of optimizedHistory) {
        if (h.query) {
          formattedHistory.push(new HumanMessage(h.query));
        }
        if (h.response) {
          formattedHistory.push(new AIMessage(h.response));
        }
      }
    }
    
    // Prepare input for the LLM
    const input = {
      input: question,
      context: context || "No relevant information found.",
      chat_history: formattedHistory,
      language: language || "English",
    };
    
    // Add form data if available
    if (formData) {
      if (formData.Greeting_message) {
        input.Greeting_message = formData.Greeting_message;
      }
      if (formData.Eligibility_criteria) {
        input.Eligibility_criteria = formData.Eligibility_criteria;
      }
      if (formData.Restrictions) {
        input.Restrictions = formData.Restrictions;
      }
    }
    
    // Stream the response from the LLM
    timeFunction("Before LLM: ");
    const stream = await chain.stream(input);
    timeFunction("After LLM call, streaming started: ");
    
    // Yield each chunk as it arrives
    for await (const chunk of stream) {
      if (chunk) {
        // Handle AIMessageChunk objects properly
        try {
          // For objects with a direct content property
          if (typeof chunk === 'object') {
            // Direct content property access
            if (chunk.content !== undefined && typeof chunk.content === 'string') {
              yield chunk.content;
              continue;
            }
            
            // For LangChain AIMessageChunk objects
            if (chunk.kwargs && chunk.kwargs.content !== undefined) {
              yield chunk.kwargs.content;
              continue;
            }
            
            // For nested content structures
            if (chunk.text !== undefined) {
              yield chunk.text;
              continue;
            }
            
            // Skip empty chunks or metadata-only chunks
            const stringified = JSON.stringify(chunk);
            if (stringified === '{}' || 
                (stringified.includes('"content":""') && stringified.includes('tool_call_chunks')) || 
                stringified.includes('"finish_reason"')) {
              continue;
            }
            
            // Last resort - extract any text content from the JSON
            const contentMatch = stringified.match(/"content":"([^"]*)"/);
            if (contentMatch && contentMatch[1]) {
              yield contentMatch[1];
              continue;
            }
            
            // If we get here, we couldn't extract meaningful content
            console.log('Skipping chunk with no extractable content');
          } else {
            // If it's already a string or other primitive, yield it directly
            yield chunk;
          }
        } catch (error) {
          console.error('Error processing chunk:', error);
          // Don't yield anything for error cases to avoid displaying errors
        }
      }
    }
    
    timeFunction("After streaming complete: ");
  } catch (error) {
    console.error("Error in processParallelChat:", error);
    yield "I apologize, but I encountered an error processing your request. Please try again.";
  }
}

/**
 * Optimize conversation history to reduce token usage
 * Only keep the most recent and relevant exchanges
 */
function optimizeConversationHistory(history, maxExchanges = 3) {
  if (!history || !Array.isArray(history)) return [];
  
  // Take only the most recent exchanges
  const recentHistory = history.slice(-maxExchanges);
  
  // Truncate long messages to reduce token usage
  return recentHistory.map(item => ({
    query: item.query?.substring(0, 500),
    response: item.response?.substring(0, 500)
  }));
}

/**
 * Parse conversation history into a format usable by the LLM
 */
function parseConversationHistory(history) {
  if (!history) return [];
  
  return history.map(h => ({
    query: h.query || "",
    response: h.response || ""
  }));
}

/**
 * Get a response when the call is cut or interrupted
 */
async function get_call_cut_response(conversation_history, ai_message = null) {
  try {
    const model = new ChatOpenAI({
      modelName: "gpt-3.5-turbo",
      temperature: 0.7,
      openAIApiKey: process.env.OPENAI_API_KEY,
      maxTokens: 150,
    });

    let convos = "";
    if (conversation_history && conversation_history.length > 0) {
      convos = conversation_history
        .map(
          (h) =>
            `Human: ${h.query || ""}\nAI: ${h.response || ""}`
        )
        .join("\n");
    }

    const prompt = `
    You are an AI assistant for a security company. The call has been cut or interrupted.
    Based on the conversation history, generate a brief message that would be appropriate to send to the user.
    This message should acknowledge the interruption and offer to continue the conversation when they're available again.
    Keep your response concise and professional, focusing on security and assistance.
    
    Conversation history:\n${convos}\n
    AI's last message: ${ai_message || ""}\n
    Your response (keep it brief, under 100 words):
    `;

    const response = await model.invoke(prompt);
    return response.content;
  } catch (error) {
    console.error("Error generating call cut response:", error);
    return "I notice our conversation was interrupted. Please feel free to reach out again when you're available, and I'll be happy to assist with your security needs.";
  }
}

/**
 * Predict sentiment and create a summary of the conversation
 */
async function predict_sentiment_and_summary(conversation_history, activityId) {
  if (!conversation_history || conversation_history.length === 0) {
    return;
  }

  let convos = "";
  if (conversation_history && conversation_history.length > 0) {
    convos = conversation_history
      .map(
        (h) =>
          `Human: ${h.query || ""}\nAI: ${h.response || ""}`
      )
      .join("\n");
  }

  const prompt = `
  You are an AI assistant for a security company. Analyze the following conversation and provide:
  1. A sentiment analysis (Positive, Neutral, or Negative)
  2. A brief summary of the conversation (100 words max)
  3. Whether this appears to be a potential customer (Yes or No)
  
  Format your response as a JSON object with the following fields:
  - Sentiment: The overall sentiment of the conversation
  - Summary: A brief summary of the key points discussed
  - PotentialCustomer: Whether this appears to be a potential customer
  
  Conversation:\n${convos}
  `;

  const model = new ChatOpenAI({
    modelName: "gpt-3.5-turbo",
    temperature: 0,
    openAIApiKey: process.env.OPENAI_API_KEY,
    responseFormat: { type: "json_object" },
    maxTokens: 1024,
  });

  try {
    const res = await model.invoke(prompt);
    const cleanedResponse = res.content.replace(/```json|```/g, "").trim();
    const { Sentiment, Summary, PotentialCustomer } = JSON.parse(cleanedResponse);
    
    console.log("Sentiment analysis:", Sentiment);
    console.log("Summary:", Summary);
    console.log("Potential customer:", PotentialCustomer);
    
    return {
      sentiment: Sentiment,
      summary: Summary,
      potentialCustomer: PotentialCustomer
    };
  } catch (error) {
    console.error("Error predicting sentiment and summary:", error);
    return null;
  }
}

/**
 * Create a chain for the chatbot
 */
async function createChain(
  systemPrompt,
  userPrompt,
  formData,
  model = "azure"
) {
  try {
    let modelInstance;
    if (model === "gpt") {
      modelInstance = new ChatOpenAI({
        model: "gpt-4o",
        temperature: 0.1,
        maxRetries: 1, // Reduced for faster fallback
        timeout: 10000, // Add timeout to prevent long waits
      });
    } else if (model == "azure") {
      console.log("Using Azure Model: .......");
      modelInstance = new AzureChatOpenAI({
        temperature: 0,
        maxRetries: 1, // Reduced from 2 to 1
        azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY_NAME,
        timeout: 10000, // Add timeout to prevent long waits
      });
    } else {
      modelInstance = new ChatGroq({
        temperature: 0.1,
        groqApiKey: process.env.GROQ_API_KEY,
        modelName: "llama3-70b-8192",
        timeout: 10000, // Add timeout to prevent long waits
      });
    }

    let prompt;

    if (formData?.type === "Make Calls") {
      prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        ["system", userPrompt],
        new MessagesPlaceholder("chat_history"),
        ["user", "{input}"],
        ["user", "{language}"],
      ]);
    } else if (formData?.type === "Answer Calls") {
      prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        new MessagesPlaceholder("chat_history"),
        new MessagesPlaceholder("Greeting_message"),
        new MessagesPlaceholder("Eligibility_criteria"),
        new MessagesPlaceholder("Restrictions"),
        ["user", "{input}"],
        ["user", "{language}"],
      ]);
    } else {
      // Default prompt for security-related conversations
      prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        new MessagesPlaceholder("chat_history"),
        ["user", "{input}"],
        ["user", "{language}"],
      ]);
    }

    // Create a custom chain that safely handles documents
    const chain = {
      stream: async ({ input, context, chat_history, language, ...rest }) => {
        try {
          // Create a safe context string that doesn't rely on document.map
          let safeContext = context || "No relevant information found.";
          
          // No fallback information - strictly rely on context from Pinecone
          if (safeContext === "No relevant information found.") {
            console.log("No relevant information found in Pinecone - will inform user we don't have this information");
            // Keep the 'No relevant information found' context to trigger the appropriate response in the system prompt
          }
          
          console.log("Using context:", safeContext.substring(0, 100) + "...");
          
          // Format the input for the LLM
          const formattedInput = {
            input,
            context: safeContext,
            chat_history,
            language,
            ...rest
          };
          
          // Use the LLM directly with the formatted input
          return await prompt.pipe(modelInstance).stream(formattedInput);
        } catch (error) {
          console.error("Error in custom chain:", error);
          // Return a generator that yields an error message
          async function* errorGenerator() {
            yield "I apologize, but I encountered an error processing your request. Please try again.";
          }
          return errorGenerator();
        }
      }
    };

    return chain;
  } catch (error) {
    console.error("Error creating chain:", error);
    throw error;
  }
}

/**
 * Get a response after a period of silence
 */
async function get_res_after_silence(user_message, ai_message) {
  try {
    const model = new ChatOpenAI({
      modelName: "gpt-3.5-turbo",
      temperature: 0.7,
      openAIApiKey: process.env.OPENAI_API_KEY,
      maxTokens: 150,
    });

    const messages = [
      new SystemMessage(`
        You are an AI Security Assistant that provides helpful and professional responses.
        The user has been silent for a while during a security-related conversation.
        Based on the user's last message and your previous response, your goal is to continue
        the conversation naturally by offering assistance or asking about the user's presence
        in a security-focused context.
        Keep your response concise and security-oriented. Your response should start with a
        phrase that asks about the user's presence without greeting.
      `),
      new HumanMessage(`User Response: ${user_message}`),
      new HumanMessage(`AI chatbot: ${ai_message}`),
    ];

    const response = await model.invoke(messages);
    return response.content;
  } catch (error) {
    console.log("Error calling OpenAI API:", error);
    return "Are you still there? I'm here to assist with your security questions when you're ready.";
  }
}

module.exports = {
  createChain,
  processParallelChat,
  get_call_cut_response,
  get_res_after_silence,
  parseConversationHistory,
  predict_sentiment_and_summary,
  optimizeConversationHistory
};
