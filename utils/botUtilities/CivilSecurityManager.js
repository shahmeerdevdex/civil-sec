/**
 * Civil Security Manager
 * 
 * This module provides the core functionality for the Civil Security voice AI chatbot,
 * including speech recognition, text-to-speech, and conversation management.
 * It includes optimizations for performance based on the identified bottlenecks.
 */

const textToSpeech = require("@google-cloud/text-to-speech");
const { Pinecone } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("@langchain/pinecone");
const { OpenAIEmbeddings } = require("@langchain/openai");
const optimizedAudio = require('./optimizedAudioProcessing');
const {
  createChain,
  processParallelChat,
  parseConversationHistory,
} = require("./agent_chatbot");
const tts = require("./tts");
const dotenv = require("dotenv");
const speech = require("@google-cloud/speech");
const googleConfig = require("../../google.json");
const { Milvus } = require("@langchain/community/vectorstores/milvus");

// Load environment variables from .env file
dotenv.config();
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
});

// Vector database configuration
const ZILLIZ_CLOUD_URI = process.env.ZILLIZ_CLOUD_URI || 
  "https://in03-6078dd857cb819c.serverless.gcp-us-west1.cloud.zilliz.com";
const ZILLIZ_CLOUD_USERNAME = process.env.ZILLIZ_CLOUD_USERNAME || "db_6078dd857cb819c";
const ZILLIZ_CLOUD_PASSWORD = process.env.ZILLIZ_CLOUD_PASSWORD || "Sr7|FlM9lEK4BF4d";

// Use the PINECONE_API_KEY from environment variables
// Note: For this to work, the PINECONE_API_KEY must be set in the environment
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

// Initialize Google Speech client
const speechClient = new speech.SpeechClient({
  projectId: googleConfig.project_id,
  credentials: {
    private_key: googleConfig.private_key,
    client_email: googleConfig.client_email,
  },
});

// Language and voice mappings
const languageCodeMap = {
  English: "en-US",
  Spanish: "es-ES",
  French: "fr-FR",
  Russian: "ru-RU",
};

const voiceMap = {
  "English-Female": "en-US-Neural2-C",
  "English-Male": "en-GB-News-K",
  "Russian-Female": "ru-RU-Standard-A",
  "Russian-Male": "ru-RU-Standard-B",
  "French-Female": "fr-FR-Standard-C",
  "French-Male": "fr-FR-Standard-B",
  "Spanish-Female": "es-ES-Standard-A",
  "Spanish-Male": "es-ES-Standard-B",
};

// Connection dictionary to store session data
let dictConnection = {};

// System prompts for the chatbot
const securitySystemPrompt = `
You are an intelligent security agent for Civil Security. You will be given the company's 'security protocols,' 'emergency procedures,' and 'verification requirements'. \
Your primary task is to provide security-related assistance STRICTLY based on the 'Context' provided.\
Each section is delimeted by Sequence of '*'.

Context: {context}
Chat History: {chat_history}

**STRICT GUIDELINES:**
1. ONLY provide information that is explicitly found in the 'Context'. Do not add, assume, or infer any information not present in the context.
2. If the context shows 'No relevant information found' or if the user asks about topics not covered in the context, politely inform them that you don't have information about that topic.
3. Do NOT answer general knowledge questions about topics like 'what is an apple', 'who is the president', etc. ONLY answer questions related to the security services and information provided in the context.
4. Once the conversation has started, do not repeat an introduction or restart the conversation from the 'chat history.'
5. Always review 'chat history' to determine what information has already been asked and provided.
6. Do not request or collect sensitive personal information unless explicitly necessary for security verification.
7. If you ask the user if they have any further queries, wait for their response before making any closing remarks.
8. Maintain a natural, conversational tone, as a human security agent would, and only greet the user once at the start of the conversation.
9. For ANY question where the context is 'No relevant information found', respond with: 'I apologize, but I don't have information about that. I can only provide details about our security services and protocols.'
`;

const inboundSecurityPrompt = `
You are an intelligent security agent for inbound calls at Civil Security. You will be given the company's 'security protocols,' 'emergency procedures,' and 'verification requirements'. \
Your primary task is to provide security-related assistance STRICTLY based on the 'Context' provided.\
Each section is delimeted by Sequence of '*'.

Context: {context}
Chat History: {chat_history}

**STRICT GUIDELINES:**
1. ONLY provide information that is explicitly found in the 'Context'. Do not add, assume, or infer any information not present in the context.
2. If the context shows 'No relevant information found' or if the user asks about topics not covered in the context, politely inform them that you don't have information about that topic.
3. Do NOT answer general knowledge questions about topics like 'what is an apple', 'who is the president', etc. ONLY answer questions related to the security services and information provided in the context.
4. Once the conversation has started, do not repeat an introduction or restart the conversation from the 'chat history.'
5. Always review 'chat history' to determine what information has already been asked and provided.
6. Do not request or collect sensitive personal information unless explicitly necessary for security verification.
7. Maintain a natural, conversational tone, as a human security agent would, and only greet the user once at the start of the conversation.
8. Understand the current query asked by the user and give responses according to that query, but ONLY if the information is in the context.
9. For security-related emergencies mentioned in the context, prioritize providing immediate assistance and guidance.
10. For ANY question where the context is 'No relevant information found', respond with: 'I apologize, but I don't have information about that. I can only provide details about our security services and protocols.'
`;

// Time formatting options
const options = {
  timeZone: "Asia/Karachi",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};
const timeFormatter = new Intl.DateTimeFormat("en-US", options);

// Time function for performance logging
function timeFunction(text, startTime = null) {
  const currentDate = new Date();
  const timeParts = timeFormatter.formatToParts(currentDate);
  let hours = timeParts.find((part) => part.type === "hour").value;
  let minutes = timeParts.find((part) => part.type === "minute").value;
  let seconds = timeParts.find((part) => part.type === "second").value;
  let milliseconds = currentDate.getMilliseconds();
  let currentTime = `${hours}h ${minutes}m ${seconds}s ${milliseconds}ms`;
  
  if (startTime) {
    const elapsedTime = (Date.now() - startTime) / 1000; // Convert to seconds
    console.log(`${text} ${currentTime} (Elapsed: ${elapsedTime.toFixed(3)}s)`);
  } else {
    console.log(`${text} ${currentTime}`);
  }
}

/**
 * Initialize the Civil Security namespace for socket.io
 * @param {Object} namespace - The socket.io namespace
 */
function initializeCivilSecurityNamespace(namespace) {
  if (!namespace) {
    console.error("Error: namespace is undefined");
    return;
  }

  namespace.on("connection", (socket) => {
    console.log(`Civil Security client connected: ${socket.id}`);
    
    // Initialize connection data
    dictConnection[socket.id] = {
      recognizeStream: null,
      lastTranscript: "",
      lastMessage: "",
      chatHistory: [],
      conversationStartTime: Date.now(),
      lastActivityTime: Date.now(),
    };

    // Handle disconnection
    socket.on("disconnect", () => {
      console.log(`Civil Security client disconnected: ${socket.id}`);
      if (dictConnection[socket.id]?.recognizeStream) {
        dictConnection[socket.id].recognizeStream.end();
        dictConnection[socket.id].recognizeStream = null;
      }
      delete dictConnection[socket.id];
    });

    // Handle audio data from client
    let audioChunks = [];
    let audioChunkSize = 0;
    const MAX_AUDIO_CHUNK_SIZE = 64000; // Batch size for efficient processing
    let audioFlushTimeout = null;
    
    socket.on("audio-data", (data) => {
      try {
        // Check if the stream exists and is writable before writing to it
        if (dictConnection[socket.id]?.recognizeStream && !dictConnection[socket.id].recognizeStream.destroyed) {
          // Buffer audio chunks for more efficient processing
          audioChunks.push(Buffer.from(data));
          audioChunkSize += data.byteLength || 0;
          
          // Process audio in larger batches for efficiency
          if (audioChunkSize >= MAX_AUDIO_CHUNK_SIZE) {
            const combinedBuffer = Buffer.concat(audioChunks);
            dictConnection[socket.id].recognizeStream.write(combinedBuffer);
            audioChunks = [];
            audioChunkSize = 0;
          }
          
          dictConnection[socket.id].lastActivityTime = Date.now();
        }
      } catch (error) {
        console.error(`Error processing audio data: ${error.message}`);
        // If we encounter an error, clean up the stream to prevent further errors
        if (dictConnection[socket.id]?.recognizeStream) {
          dictConnection[socket.id].recognizeStream = null;
        }
      }
    });

    // Handle start recognition request
    socket.on("start-recognition", async (data) => {
      console.log("Starting Civil Security speech recognition");
      
      // Reset connection data
      dictConnection[socket.id].lastTranscript = "";
      dictConnection[socket.id].lastMessage = "";
      
      // Clear existing audio chunks
      audioChunks = [];
      audioChunkSize = 0;
      
      // Start periodic flush timer when stream is created
      if (!audioFlushTimeout) {
        audioFlushTimeout = setInterval(() => {
          if (dictConnection[socket.id]?.recognizeStream && audioChunks.length > 0) {
            const combinedBuffer = Buffer.concat(audioChunks);
            dictConnection[socket.id].recognizeStream.write(combinedBuffer);
            audioChunks = [];
            audioChunkSize = 0;
          }
        }, 200); // Flush every 200ms
      }
      
      // Configure speech recognition
      const request = {
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: dictConnection[socket.id]?.languageCode || "en-US",
          model: "latest_short",
          useEnhanced: true,
          enableAutomaticPunctuation: true,
          // Add speech adaptation for better recognition of security-specific terms
          speechContexts: [{
            phrases: ["security", "alarm", "emergency", "surveillance", "Civil Security"],
            boost: 10
          }]
        },
        interimResults: false, // Changed to false for faster processing
      };

      // Create recognition stream
      try {
        // Stop any existing stream first
        if (dictConnection[socket.id]?.recognizeStream) {
          stopRecognitionStream(socket.id);
        }

        // Variables for handling transcript processing
        let finalText = "";
        let silenceTimeout = null;
        let botProcessing = false;

        // Create a new stream with optimized settings
        dictConnection[socket.id].recognizeStream = speechClient.streamingRecognize(request)
          .on('error', (error) => {
            console.error(`Speech recognition error: ${error.message}`);
            stopRecognitionStream(socket.id);
          })
          .on('data', (data) => {
            // Check if data and results exist
            if (!data || !data.results || !data.results[0]) {
              console.log('Invalid speech recognition data received');
              return;
            }
            
            const result = data.results[0];
            // Check if result has the expected properties
            if (!result) {
              console.log('Invalid speech recognition result');
              return;
            }
            
            const isFinal = result.isFinal || false;
            const transcript = result.alternatives && result.alternatives[0] ? result.alternatives[0].transcript : '';
            
            // Clear any existing silence timeout
            if (silenceTimeout) {
              clearTimeout(silenceTimeout);
            }

            if (isFinal) {
              finalText += transcript + " ";
              
              // Send transcript to client for UI update
              socket.emit('transcript', {
                transcript: finalText.trim(),
                isFinal: true
              });
              
              // Store the transcript
              dictConnection[socket.id].lastTranscript = finalText.trim();
              
              // Schedule processing with a short delay to allow for further speech
              // Reduce the delay for faster response
              silenceTimeout = setTimeout(async () => {
                socket.emit("audio_converted", "Audio Converted");
                console.log(`Final transcript: ${finalText.trim()}`);
                
                if (!botProcessing && finalText.trim() !== "") {
                  botProcessing = true;
                  
                  // Process message using handleCommunication
                  await handleCommunication(socket, finalText.trim());
                  
                  botProcessing = false;
                  finalText = "";
                }
              }, 200); // Short delay for optimal responsiveness
            } else {
              // For interim results, just update the UI
              socket.emit('transcript', {
                transcript,
                isFinal: false
              });
            }
          });
      } catch (error) {
        console.error(`Error initializing speech recognition: ${error.message}`);
      }

      // No need to register stop-recognition here as it's done outside this function
    });

    // Handle initialization data
    socket.on("initialize", async (data) => {
      console.log("Initializing Civil Security chatbot with data:", data);
      
      // Extract initialization data
      const {
        SystemPrompt,
        User_prompt,
        Greeting_message,
        Eligibility_criteria,
        Restrictions,
        voice_type,
        language,
        pinecone_index,
        milvus_index,
      } = data.additionalData || {};
      
      let vectorStore;

      // Initialize vector store based on index type
      if (data.additionalData) {
        if (data.additionalData.pinecone_index) {
          console.log("Initializing Pinecone with data from frontend");
          
          try {
            // Check if PINECONE_API_KEY is available
            if (!PINECONE_API_KEY) {
              console.error("PINECONE_API_KEY is not defined in environment variables");
              console.log("Using dummy vector store for testing");
              // Create a dummy vector store for testing
              vectorStore = {
                asRetriever: () => ({
                  getRelevantDocuments: async () => []
                })
              };
            } else {
              try {
                // Initialize Pinecone client
                const pinecone = new Pinecone({
                  apiKey: PINECONE_API_KEY,
                });
                
                // IMPORTANT: Based on testing, we know:
                // - 'index1' exists and is the correct index name
                // - 'Texas' exists as a namespace within index1
                
                // Always use index1 as the index name
                const pineconeIndexName = 'index1';
                
                // Use Texas as the namespace, or fallback to what the frontend sends
                const pineconeNamespace = data.additionalData.pinecone_index || 'Texas';
                
                console.log(`Creating custom vector store with index: ${pineconeIndexName}, namespace: ${pineconeNamespace}`);
                
                // Get the Pinecone index and specify the namespace
                // This is the key fix - using the namespace() method instead of passing it as a parameter
                const indexWithNamespace = pinecone
                  .Index(pineconeIndexName)
                  .namespace(pineconeNamespace);
                
                console.log(`Successfully connected to Pinecone index: ${pineconeIndexName}, namespace: ${pineconeNamespace}`);
                
                // Create a custom retriever function that handles the specific data format
                // This avoids the 'toString' error by providing a custom implementation
                const customRetriever = {
                  getRelevantDocuments: async (query) => {
                    try {
                      console.log(`Searching for: ${query}`);
                      
                      // Create embeddings for the query
                      const embedder = new OpenAIEmbeddings({
                        apiKey: process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_API_KEY_NAME,
                        modelName: "text-embedding-3-small",
                      });
                      
                      // Generate query embedding
                      const queryEmbedding = await embedder.embedQuery(query);
                      
                      // Query Pinecone directly using the namespace-specific index
                      // No need to use filter since we're already using the namespace() method
                      const results = await indexWithNamespace.query({
                        vector: queryEmbedding,
                        topK: 3,
                        includeMetadata: true
                      });
                      
                      console.log(`Found ${results.matches.length} matches in Pinecone`);
                      
                      // Convert Pinecone results to LangChain document format
                      const documents = results.matches.map(match => {
                        // Extract content from metadata or use a default value
                        const content = match.metadata?.text || 
                                       match.metadata?.content || 
                                       match.metadata?.codes_content || 
                                       match.metadata?.pageContent || 
                                       'No content available';
                        
                        return {
                          pageContent: content,
                          metadata: match.metadata || {}
                        };
                      });
                      
                      console.log(`Converted ${documents.length} matches to documents`);
                      return documents;
                    } catch (error) {
                      console.error('Error in custom retriever:', error.message);
                      return []; // Return empty array on error
                    }
                  }
                };
                
                // Use the custom retriever instead of PineconeStore
                vectorStore = {
                  asRetriever: () => customRetriever
                };
              } catch (error) {
                console.error("Error initializing Pinecone index:", error.message);
                // Create a fallback vector store that won't crash the application
                vectorStore = {
                  asRetriever: () => ({
                    getRelevantDocuments: async () => []
                  })
                };
              }
            }
          } catch (error) {
            console.error("Error in Pinecone initialization:", error.message);
            // Create a fallback vector store that won't crash the application
            vectorStore = {
              asRetriever: () => ({
                getRelevantDocuments: async () => []
              })
            };
          }

          // Store data in connection dictionary
          dictConnection[socket.id].vectorStore = vectorStore;
          dictConnection[socket.id].voice_type = voice_type;
          dictConnection[socket.id].index_type = "pinecone";
          dictConnection[socket.id].language = language;
          dictConnection[socket.id].languageCode =
            languageCodeMap[language] || "en-US";
          
          // Initialize form data
          let formData = {
            Greeting_message,
            Eligibility_criteria,
            Restrictions,
            type: data?.additionalData?.agent_type,
          };
          dictConnection[socket.id].formData = formData;
          
          // Create chain
          const chain = await createChain(securitySystemPrompt, User_prompt, formData);
          dictConnection[socket.id].chain = chain;
        } else if (data.additionalData.milvus_index) {
          console.log("Initializing Milvus index");
          
          // Create Milvus vector store
          vectorStore = await Milvus.fromExistingCollection(embeddings, {
            collectionName: `_${data.additionalData.milvus_index}`,
            url: ZILLIZ_CLOUD_URI,
            username: ZILLIZ_CLOUD_USERNAME,
            password: ZILLIZ_CLOUD_PASSWORD,
          });

          // Store data in connection dictionary
          dictConnection[socket.id].vectorStore = vectorStore;
          dictConnection[socket.id].voice_type = voice_type;
          dictConnection[socket.id].index_type = "milvus";
          dictConnection[socket.id].language = language;
          dictConnection[socket.id].languageCode =
            languageCodeMap[language] || "en-US";
          
          // Create chain
          const chain = await createChain(securitySystemPrompt, User_prompt);
          dictConnection[socket.id].chain = chain;
        }
      }

      // Initialize TTS client with explicit credentials
      const client = new textToSpeech.TextToSpeechClient({
        projectId: googleConfig.project_id,
        credentials: {
          private_key: googleConfig.private_key,
          client_email: googleConfig.client_email,
        },
      });
      dictConnection[socket.id].speech_model = client;
      
      // Pre-warm TTS cache with common security phrases
      const voiceType = voice_type || "Female";
      const voiceKey = `${language}-${voiceType}`;
      const googleVoice = voiceMap[voiceKey] || "en-US-Neural2-C";
      
      setTimeout(() => {
        try {
          const securityPhrases = [
            "Thank you for contacting Civil Security.",
            "I understand your security concern.",
            "Let me check our security protocols for that information.",
            "For security purposes, I need to verify your identity.",
            "Is there anything else I can help you with regarding security?"
          ];
          
          securityPhrases.forEach(phrase => {
            tts.googleTextToWav(googleVoice, phrase, client);
          });
        } catch (error) {
          console.log("Error preloading security phrases:", error.message);
        }
      }, 0);
      
      // Send initialization confirmation
      socket.emit("initialized", { success: true });
    });

    // Handle communication messages
    socket.on("communication", async (message) => {
      handleCommunication(socket, message);
    });
  });

  /**
   * Handle communication messages from the client
   * @param {Object} socket - The socket.io socket
   * @param {Object} message - The message from the client
   */
  async function handleCommunication(socket, message) {
    try {
      const sid = socket.id;
      if (!dictConnection[sid]) {
        socket.emit("error", { message: "Session not initialized" });
        return;
      }

      const startTime = Date.now();
      timeFunction("Communication received: ", startTime);

      // Extract message data
      const { query, chatHistory } = message;
      
      // Update chat history
      dictConnection[sid].chatHistory = parseConversationHistory(chatHistory);
      
      // Get response from LLM
      const responseGenerator = getResponse(
        sid,
        dictConnection[sid].chain,
        query,
        dictConnection[sid].chatHistory,
        dictConnection[sid].vectorStore,
        dictConnection[sid].index_type,
        dictConnection[sid].language,
        dictConnection[sid].formData
      );

      // Track processing metrics
      let chunkCount = 0;
      let processingStartTime = Date.now();
      let totalProcessingTime = 0;
      
      // Track the start time of the entire conversation
      console.log(`Starting conversation processing at ${new Date().toLocaleTimeString()}`);
      const totalStartTime = Date.now();
      
      try {
        for await (const audioContent of responseGenerator) {
          if (audioContent) {
            // Measure chunk processing time
            const chunkProcessTime = Date.now() - processingStartTime;
            totalProcessingTime += chunkProcessTime;
            
            // Log performance metrics
            console.log(`Chunk ${++chunkCount} processed in ${(chunkProcessTime/1000).toFixed(3)}s`);
            
            // Reset processing start time for next chunk
            processingStartTime = Date.now();
            
            // Convert to base64 and send to client
            const base64Audio = Buffer.from(audioContent).toString("base64");
            socket.emit("audio-out", { audio: base64Audio });
          }
        }
        
        // Log final performance metrics
        const totalTime = Date.now() - totalStartTime;
        const avgChunkTime = totalProcessingTime / (chunkCount || 1);
        console.log(`Conversation complete - Total time: ${(totalTime/1000).toFixed(3)}s`);
        console.log(`Average chunk processing time: ${(avgChunkTime/1000).toFixed(3)}s`);
        console.log(`Total chunks: ${chunkCount}`);
      } catch (error) {
        console.error(`Error processing audio chunks: ${error.message}`);
      }

      // Send end of response signal
      socket.emit("response-end", {
        message: dictConnection[sid].lastMessage.trim(),
        timeTaken: (Date.now() - startTime) / 1000,
      });

      timeFunction("Communication completed: ", startTime);
    } catch (error) {
      console.error(`Error in communication: ${error.message}`);
      socket.emit("error", { message: error.message });
    }
  }

  /**
   * Process speech recognition transcript
   * @param {Object} socket - The socket.io socket
   * @param {Object} data - The recognition data
   */
  function processTranscript(socket, data) {
    try {
      // Check if we have valid results
      if (!data || !data.results || data.results.length === 0) {
        return;
      }

      const sid = socket.id;
      const result = data.results[0];
      
      // Check if we have valid alternatives
      if (!result || !result.alternatives || result.alternatives.length === 0) {
        return;
      }

      // Get transcript
      const transcript = result.alternatives[0].transcript;
      
      // Check if this is a final result
      if (result.isFinal) {
        console.log(`Final transcript: ${transcript}`);
        
        // Update last transcript
        dictConnection[sid].lastTranscript = transcript;
        
        // Send transcript to client
        socket.emit("transcript", {
          transcript,
          isFinal: true,
        });
        
        // Stop recognition after final result
        stopRecognitionStream(sid);
      } else {
        // Send interim results
        socket.emit("transcript", {
          transcript,
          isFinal: false,
        });
      }
    } catch (error) {
      console.error(`Error processing transcript: ${error.message}`);
    }
  }

  /**
   * Stop the recognition stream
   * @param {string} sid - The socket ID
   */
  function stopRecognitionStream(sid) {
    if (dictConnection[sid]?.recognizeStream) {
      dictConnection[sid].recognizeStream.end();
      dictConnection[sid].recognizeStream = null;
      console.log(`Recognition stream stopped for ${sid}`);
    }
  }
}

/**
 * Generate a response from the LLM and convert to speech
 * @param {string} sid - The socket ID
 * @param {Object} chain - The LLM chain
 * @param {string} query - The user query
 * @param {Array} chatHistory - The chat history
 * @param {Object} vectorStore - The vector store
 * @param {string} indexType - The index type
 * @param {string} language - The language
 * @param {Object} formData - Additional form data
 * @returns {AsyncGenerator} - Generator yielding audio chunks
 */
async function* getResponse(
  sid,
  chain,
  query,
  chatHistory,
  vectorStore,
  indexType,
  language,
  formData
) {
  const startTime = Date.now();
  timeFunction("Starting getResponse: ");
  let collectedStr = "";

  try {
    // Determine voice based on settings
    const voiceType = dictConnection[sid]?.voice_type || "Female";
    const voiceKey = `${language}-${voiceType}`;
    const googleVoice = voiceMap[voiceKey] || "en-US-Neural2-C";

    // Get speech model
    const speech_model = dictConnection[sid]?.speech_model;
    if (!speech_model) {
      console.error("Speech model not found");
      return;
    }

    // Define sentence endings for chunking text
    const sentenceEndings = ['.', '!', '?', ':', ';'];
    const minChunkSize = 50; // Optimized chunk size for smooth speech

    // Get the conversation start time from dictConnection
    const conversationStartTime = dictConnection[sid].conversationStartTime;

    let sentenceBuffer = "";
    let pendingTTS = null; // Track the current TTS conversion

    // Pre-warm the TTS cache with security phrases immediately
    setTimeout(() => {
      try {
        const phrasesToPreload = [
          "Thank you for contacting Civil Security.",
          "I understand your security concern.",
          "Let me check our security protocols for that information.",
          "For security purposes, I need to verify your identity.",
          "Is there anything else I can help you with regarding security?"
        ];
        
        phrasesToPreload.forEach(phrase => {
          tts.googleTextToWav(googleVoice, phrase, speech_model);
        });
      } catch (error) {
        console.log("Error preloading security phrases:", error.message);
      }
    }, 0);
    
    // Use the optimized TTS function
    const processTTS = async (text) => {
      try {
        return await optimizedAudio.optimizedTTS(googleVoice, text, speech_model);
      } catch (error) {
        console.error("Error in processTTS:", error);
        return null;
      }
    };

    // Process streaming response
    for await (const value of responseGenerator) {
      if (value) {
        collectedStr += value;
        sentenceBuffer += value;
        
        // Check if we have a complete sentence or a substantial chunk
        const hasEndingChar = sentenceEndings.some(char => sentenceBuffer.includes(char));
        const isLargeChunk = sentenceBuffer.length >= minChunkSize;
        
        if (hasEndingChar && isLargeChunk) {
          console.log(`Chunk identified: ${sentenceBuffer.substring(0, 30)}... (${sentenceBuffer.length} chars)`);
          
          // Clean up the text before sending to TTS
          const cleanText = sentenceBuffer.trim().replace(/\*\*/g, "");
          
          // If we have a pending TTS, wait for it to complete and yield the result
          if (pendingTTS) {
            const audioContent = await pendingTTS;
            if (audioContent) {
              yield audioContent;
            }
          }
          
          // Start processing the next chunk in parallel
          pendingTTS = processTTS(cleanText);
          
          // Add to the full message history
          dictConnection[sid].lastMessage += sentenceBuffer + " ";
          sentenceBuffer = "";
        }
      }
    }
    
    // Process any remaining text in the buffer
    if (sentenceBuffer && sentenceBuffer.trim && sentenceBuffer.trim().length > 0) {
      // Ensure sentenceBuffer is a string
      let finalChunk = sentenceBuffer;
      if (typeof finalChunk !== 'string') {
        try {
          // Convert object to string if needed
          finalChunk = String(finalChunk);
          console.log(`Converted non-string chunk to string: ${finalChunk.substring(0, 30)}...`);
        } catch (error) {
          console.error(`Error converting final chunk to string: ${error.message}`);
          finalChunk = '';
        }
      }
      
      console.log(`Processing final chunk: ${finalChunk.substring(0, 30)}...`);
      
      // Clean up the text before sending to TTS
      const cleanText = finalChunk.trim().replace(/\*\*/g, "");
      
      // If we have a pending TTS, wait for it to complete and yield the result
      if (pendingTTS) {
        const audioContent = await pendingTTS;
        if (audioContent) {
          yield audioContent;
        }
      }
      
      // Process the final chunk only if it's a valid string
      if (cleanText && cleanText.length > 0) {
        const audioContent = await processTTS(cleanText);
        if (audioContent) {
          yield audioContent;
        }
        dictConnection[sid].lastMessage += finalChunk + " ";
      }
    } else if (pendingTTS) {
      // If no remaining text but we have a pending TTS
      const audioContent = await pendingTTS;
      if (audioContent) {
        yield audioContent;
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`Total response generation time: ${(totalTime/1000).toFixed(3)}s`);
  } catch (error) {
    // Handle errors in getResponse
    console.error(`Error in getResponse: ${error.message}`);
    console.error(error.stack);
  }
}

module.exports = { initializeCivilSecurityNamespace };
