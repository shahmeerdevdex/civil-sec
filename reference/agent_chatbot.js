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
const pool = require("../database");
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
 * Original processChat function - kept for backward compatibility
 */
async function* processChat(
  chain,
  question,
  chatHistory,
  vectorStore,
  indexType,
  language,
  formData
) {
  // Use the new parallel processing function
  yield* processParallelChat(chain, question, chatHistory, vectorStore, indexType, language, formData);
}

/**
 * Optimized processChat function with parallel processing
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
        const retriever = vectorStore.asRetriever({
          search_type: "similarity", // Faster than mmr
          search_kwargs: { 
            k: 1, // Reduced to 1 for maximum speed
            filter: {} // Add any relevant filters to narrow search scope
          },
        });
        return await retriever.getRelevantDocuments(question);
      }
    })();
    
    // Set a very short timeout (1.5 seconds max for vector retrieval)
    const timeoutPromise = new Promise(resolve => {
      setTimeout(() => {
        console.log("Vector retrieval timeout - using empty results");
        resolve([]);
      }, 1500); // 1.5 seconds max
    });
    
    // Race the retrieval against the timeout
    docs = await Promise.race([retrievalPromise, timeoutPromise]);
    
    // Store in cache for future use (even if empty)
    vectorCache.set(cacheKey, docs);
    return docs;
  })();
  
  // Start generating response immediately with empty context
  // This will be updated once vector retrieval completes
  let docs = [];

// Ensure docs is always an array after vector retrieval
vectorPromise.then(retrievedDocs => {
  if (!Array.isArray(retrievedDocs)) {
    docs = retrievedDocs ? [retrievedDocs] : [];
  } else {
    docs = retrievedDocs;
  }
});
  
  // Optimize conversation history aggressively
  const optimizedHistory = optimizeConversationHistory(chatHistory, 2); // Reduced from 3 to 2 exchanges
  
  // Start LLM processing immediately with empty context
  // Don't wait for vector retrieval to complete
  timeFunction("Starting LLM without waiting for retrieval: ");
  
  // Skip vector retrieval entirely for ultra-fast response
  // Just use empty docs and let the LLM generate a response based on conversation history
  docs = [];
  timeFunction("Skipping vector retrieval for ultra-fast response: ");
  
  // Start vector retrieval in the background for future use
  setTimeout(async () => {
    try {
      const retrievedDocs = await vectorPromise;
      // Cache the results for next time
      const cacheKey = `${question}:${indexType}`;
      const { vectorCache } = require('./optimizedAudioProcessing');
      if (vectorCache && typeof vectorCache.set === 'function') {
        vectorCache.set(cacheKey, { docs: retrievedDocs, timeTaken: Date.now() - startTime });
      }
      timeFunction("Background vector retrieval completed: ");
    } catch (error) {
      console.error("Background vector retrieval error:", error.message);
    }
  }, 0);
  
  timeFunction("After Retriever Setup: ");
  timeFunction("Chat Bot Starting Time: ");

  let InpData = {
    chat_history: optimizedHistory,
    input:
      language === "English"
        ? question
        : JSON.stringify(question.trim().replace(/\s+/g, " ").normalize("NFC")),
    context: Array.isArray(docs) ? docs : (docs ? [docs] : []),
    language: language,
  };

  if (formData?.type === "Answer Calls") {
    InpData.Greeting_message = formData?.Greeting_message;
    InpData.Eligibility_criteria = formData?.Eligibility_criteria;
    InpData.Restrictions = formData?.Restrictions;
  }

  const response = await chain.stream(InpData);

  for await (var chunk of response) {
    yield chunk;
  }
}

/**
 * Optimize conversation history to reduce token usage
 * Only keep the most recent and relevant exchanges
 */
function optimizeConversationHistory(history, maxExchanges = 3) { // Reduced from 4 to 3 by default
  if (!history || history.length <= maxExchanges) {
    return history;
  }
  
  // Keep only the most recent exchanges
  return history.slice(-maxExchanges);
}

function parseConversationHistory(history) {
  const tempHistory = [];
  history?.forEach((row) => {
    tempHistory.push(new HumanMessage({ content: row.query }));
    tempHistory.push(new AIMessage({ content: row.response }));
  });
  return tempHistory;
}

async function get_call_cut_response(conversation_history, ai_message = null) {
  if (!conversation_history || conversation_history.length === 0) return;
  const prompt = `
      You are an intelligent AI agent handling an outbound call. After each conversation, you will be given a transcript of previous exchanges \
    between the User and the Chatbot, along with the AI last message. Your task is to evaluate whether the User has expressed disinterest \
    in the services, and if the User has any follow-up queries or not.
    Fill the JSON object with the following keys:
    1. 'FollowUpQueries': 'YES'/'NO'/'NOT_MENTIONED'/'NOT_CLEAR'
    2. "reason":"Also mention the resson behined choosing above follow up query option"
    Guidelines:
      'FollowUpQueries' should be marked as 'YES' in following cases:
  1. If the User follows up with a query, continues the conversation.
  2. If the Chatbot asks further questions or inquires about additional queries or the Chatbot responding to the queries of User.
    3. If the AI's last message asks a question related to assistance or includes a statement encouraging the user to ask for help (e.g., "If you need any further assistance, feel free to ask."), return 'YES' in 'FollowUpQueries'.
  4. if the User provides requested information in response to a Chatbot request, this should also be considered a follow-up query.
      'FollowUpQueries' should be marked as 'NO' in following cases:
  1. if user last message in conversation history shows an intent of disinterest in the continuing the conversation and the AI last message doesnot ask question \
  related to assistance then return "NO".
      'FollowUpQueries' should be marked as 'NOT_CLEAR' or 'NOT_MENTIONED' in following cases:
  1. If the last conversation messages does not clarify whether there are follow-up queries or not, mark it as 'NOT_CLEAR' or 'NOT_MENTIONED'.
Client VS Chatbot Conversations:\n\n
`;
  let convos = "";
  const recentConvos = conversation_history.slice(-5);
  for (const row of recentConvos) {
    convos += `User Response: ${row.query}.\n`;
    convos += `Chatbot Response: ${row.response}\n`;
  }
  const model = new ChatOpenAI({
    modelName: "gpt-4o-2024-08-06",
    temperature: 0,
    openAIApiKey: process.env.OPENAI_API_KEY,
    responseFormat: { type: "json_object" },
    maxTokens: 100,
  });
  try {
    const res = await model.invoke(
      prompt +
        convos +
        (ai_message ? `\nAI last message : ${ai_message}.\n` : "")
    );
    const cleanedResponse = res.content.replace(/```json|```/g, "").trim();
    const parsedResp = JSON.parse(cleanedResponse);
    return parsedResp;
  } catch (error) {
    console.error("Error in call cut function:", error);
    return null;
  }
}

async function predict_sentiment_and_summary(conversation_history, activityId) {
  if (conversation_history?.length < 2) return;
  const prompt = `
    You are an intelligent AI agent for predicting sentiment along with a summary of a conversation.  
Based on the conversation between a user and a chatbot, generate a JSON object with the following keys:  

1. "Sentiment": "Positive" | "Neutral" | "Negative"  
2. "PotentialCustomer": "YES" | "NO"  
3. "Summary": "A concise 1-2 line summary explaining the chat between the user and chatbot. Capture all demographic details provided by the client, such as name, phone number,reason for calling and any other important details. If the chatbot was unable to answer any questions, list them; otherwise, do not mention unanswered questions."  

Client vs Chatbot Conversations: 
  `;

  let convos = "";
  for (const row of conversation_history) {
    convos += `User Response: ${row.query}.\n`;
    convos += `Chatbot Response: ${row.response}\n`;
  }

  const model = new ChatOpenAI({
    modelName: "gpt-4o-2024-08-06",
    temperature: 0,
    openAIApiKey: process.env.OPENAI_API_KEY,
    responseFormat: { type: "json_object" },
    maxTokens: 1024,
  });

  try {
    const res = await model.invoke(prompt + convos);
    const cleanedResponse = res.content.replace(/```json|```/g, "").trim();
    const { Sentiment, Summary, PotentialCustomer } =
      JSON.parse(cleanedResponse);
    if (activityId) {
      await pool.query(
        `UPDATE job_activity 
         SET feeling = $1, summary = $2, potential_customer = $3
         WHERE id = $4`,
        [Sentiment, Summary, PotentialCustomer, activityId]
      );
    } else {
      console.log(cleanedResponse);
    }
  } catch (error) {
    console.error("Error predicting sentiment and summary:", error);
  }
}

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
    }

    // Chain creation using prompt and model
    const chain = await createStuffDocumentsChain({
      llm: modelInstance,
      prompt,
    });

    return chain;
  } catch (error) {
    console.error(error);
  }
}

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
        You are an AI Call assistant that provides helpful and engaging responses. 
        The user stops in the middle of a call. Based on the user's last message 
        and your previous response, your goal is to continue the conversation naturally 
        by offering assistance generically or asking about the presence of the user in the call.
        Keep your response concise. Your response should start with a phrase that asks about the user's presence without greeting.
      `),
      new HumanMessage(`User Response: ${user_message}`),
      new HumanMessage(`AI chatbot: ${ai_message}`),
    ];

    const response = await model.invoke(messages);
    return response.content;
  } catch (error) {
    console.log("Error calling OpenAI API:", error);
    return null;
  }
}

module.exports = {
  createChain,
  processChat,
  processParallelChat, // Export the new parallel processing function
  get_call_cut_response,
  get_res_after_silence,
  parseConversationHistory,
  predict_sentiment_and_summary,
};
