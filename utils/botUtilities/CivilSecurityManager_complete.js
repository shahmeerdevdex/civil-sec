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
const googleConfig = require("../../../google.json");
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
const ZILLIZ_CLOUD_API_KEY = process.env.ZILLIZ_CLOUD_API_KEY || 
  "76f74f4c1f941f33bc78f5b7d49977cce8a524efa96068b87eb5268de1e30a4fa39181f900ade6ce89d48cb2881fab2842af325c";

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
Your primary task is to provide security-related assistance while strictly adhering to the 'Context', and ensuring no information is added beyond what is explicitly mentioned in 'Context'.\
Each section is delimeted by Sequence of '*'.

Context: {context}
Chat History: {chat_history}

**RESTRICTIONS:**
1. Strictly limit response to the exact information found in the 'Context'; do not add, assume, infer, or present any suggestions, advice, service details, timings, or other details not provided in 'Context'.
2. If there is any alternative information related to user query is in 'Context', provide that information to the user without adding additional information based on assumptions.
3. If information is not available in 'Context' or 'chat_history', politely *INFORM* that you do not have information about it.
4. Once the conversation has started, do not repeat an introduction or restart the conversation from the 'chat history.'
5. Always review 'chat history' to determine what information has already been asked and provided.
6. Do not ask for information out of order or in a way that disregards the user's current question or stage in the process.
7. Do not request or collect information that is not explicitly specified to collect in the 'security protocols,' 'emergency procedures,' 'verification requirements', or 'context' like personal information or any other information etc. under any circumstances.
8. If you ask the user if they have any further queries, wait for their response before making any closing remarks.
9. Ensure the 'verification requirements' are met as early as possible in the conversation. If not met, politely apologize and offer further assistance.
10. Maintain a natural, conversational tone, as a human security agent would, and only greet the user once at the start of the conversation.
`;

const inboundSecurityPrompt = `
You are an intelligent security agent for inbound calls at Civil Security. You will be given the company's 'security protocols,' 'emergency procedures,' and 'verification requirements'. \
Your primary task is to provide response to user query while strictly adhering to the 'Context', and ensuring no information is added beyond what is explicitly mentioned in 'Context'.\
Each section is delimeted by Sequence of '*'.

Context: {context}
Chat History: {chat_history}

**RESTRICTIONS:**
1. Strictly limit response to the exact information found in the 'Context'; do not add, assume, infer, or present any suggestions, advice, service details, timings, or other details not provided in 'Context'.
2. If information is not available in 'Context' or 'chat_history', politely *INFORM* that you do not have information about it.
3. Once the conversation has started, do not repeat an introduction or restart the conversation from the 'chat history.'
4. Always review 'chat history' to determine what information has already been asked and provided.
5. Do not ask for information out of order or in a way that disregards the user's current question or stage in the process.
6. Do not request or collect information that is not explicitly specified to collect in the 'security protocols,' 'emergency procedures,' 'verification requirements', or 'context' like personal information or any other information etc. under any circumstances.
7. Maintain a natural, conversational tone, as a human security agent would, and only greet the user once at the start of the conversation.
8. Understand the current query asked by the user and give responses according to that query.
9. For security-related emergencies, prioritize providing immediate assistance and guidance based on the 'emergency procedures'.
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
    socket.on("audio-data", (data) => {
      try {
        if (dictConnection[socket.id]?.recognizeStream) {
          dictConnection[socket.id].recognizeStream.write(data);
          dictConnection[socket.id].lastActivityTime = Date.now();
        }
      } catch (error) {
        console.error(`Error processing audio data: ${error.message}`);
      }
    });

    // Handle start recognition request
    socket.on("start-recognition", async (data) => {
      console.log("Starting Civil Security speech recognition");
      
      // Reset connection data
      dictConnection[socket.id].lastTranscript = "";
      dictConnection[socket.id].lastMessage = "";
      
      // Configure speech recognition
      const request = {
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: dictConnection[socket.id]?.languageCode || "en-US",
          model: "latest_short",
          useEnhanced: true,
          enableAutomaticPunctuation: true,
          enableSpokenPunctuation: true,
          maxAlternatives: 1,
        },
        interimResults: true,
      };

      // Create recognition stream
      try {
        // Stop existing stream if any
        if (dictConnection[socket.id]?.recognizeStream) {
          dictConnection[socket.id].recognizeStream.end();
        }

        // Create new stream
        const recognizeStream = speechClient
          .streamingRecognize(request)
          .on("error", (error) => {
            console.error(`Error in speech recognition: ${error.message}`);
            socket.emit("recognition-error", { error: error.message });
          })
          .on("data", (data) => {
            // Process recognition results
            processTranscript(socket, data);
          });

        dictConnection[socket.id].recognizeStream = recognizeStream;
      } catch (error) {
        console.error(`Error starting recognition: ${error.message}`);
        socket.emit("recognition-error", { error: error.message });
      }
    });

    // Handle stop recognition request
    socket.on("stop-recognition", () => {
      console.log("Stopping Civil Security speech recognition");
      stopRecognitionStream(socket.id);
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
          console.log("Initializing Pinecone index");
          
          // Initialize Pinecone client
          const pinecone = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY,
          });
          
          // Get Pinecone index
          const pineconeIndex = "Texas"
          
          // Create vector store
          vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
            pineconeIndex,
          });

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

      // Initialize TTS client
      const client = new textToSpeech.TextToSpeechClient();
      dictConnection[socket.id].speech_model = client;
      
      // Pre-warm TTS cache with common security phrases
      const voiceKey = `${language}-${voice_type}` || "English-Female";
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

      // Process and send response chunks
      for await (const audioContent of responseGenerator) {
        if (audioContent) {
          const base64Audio = Buffer.from(audioContent).toString("base64");
          socket.emit("audio-out", { audio: base64Audio });
        }
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
  let collectedStr = "";

  // Get voice settings
  const voiceKey = `${language}-${dictConnection[sid].voice_type}` || "English-Female";
  const googleVoice = voiceMap[voiceKey] || "en-US-Neural2-C";
  const speech_model = dictConnection[sid].speech_model;
  
  // Start preloading common phrases in the background immediately
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
        tts.googleTextToWav(googleVoice, phrase, speech_model);
      });
    } catch (error) {
      console.log("Error preloading security phrases:", error.message);
    }
  }, 0);
  
  // Use the parallel processing function for better performance
  const responseGenerator = processParallelChat(
    chain,
    query,
    chatHistory,
    vectorStore,
    indexType,
    language,
    formData
  );
  
  // Define sentence ending characters and minimum chunk size
  const sentenceEndings = ['.', '!', '?', ':', ';'];
  const minChunkSize = 50; // Optimized chunk size for smooth speech
  
  // Get the conversation start time from dictConnection
  const conversationStartTime = dictConnection[sid].conversationStartTime;
  
  let sentenceBuffer = "";
  let pendingTTS = null; // Track the current TTS conversion
  
  // Prepare for fast response with proper audio
  pendingTTS = null;
  
  // Pre-warm the TTS cache with security phrases immediately
  setTimeout(() => {
    try {
      const phrasesToPreload = [
        "Thank you for contacting Civil Security.",
        "I understand your security concern.",
        "Let me check our security protocols for that information.",
        "For security purposes, I need to verify your identity."
      ];
      
      phrasesToPreload.forEach(phrase => {
        tts.googleTextToWav(googleVoice, phrase, speech_model);
      });
    } catch (error) {
      console.log("Error preloading security phrases:", error.message);
    }
  }, 0);
  
  // Use the optimized TTS function from our module
  const processTTS = async (text) => {
    return await optimizedAudio.optimizedTTS(googleVoice, text, speech_model);
  };
  
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
  
  // Process any remaining text
  if (sentenceBuffer.trim().length > 0) {
    console.log(`Processing final chunk: ${sentenceBuffer.substring(0, 30)}...`);
    
    // Clean up the text before sending to TTS
    const cleanText = sentenceBuffer.trim().replace(/\*\*/g, "");
    
    // If we have a pending TTS, wait for it to complete and yield the result
    if (pendingTTS) {
      const audioContent = await pendingTTS;
      if (audioContent) {
        yield audioContent;
      }
    }
    
    // Process the final chunk
    const audioContent = await processTTS(cleanText);
    if (audioContent) {
      yield audioContent;
    }
    
    dictConnection[sid].lastMessage += sentenceBuffer + " ";
  } else if (pendingTTS) {
    // If no remaining text but we have a pending TTS
    const audioContent = await pendingTTS;
    if (audioContent) {
      yield audioContent;
    }
  }
  
  const totalTime = Date.now() - startTime;
  console.log(`Total response generation time: ${(totalTime/1000).toFixed(3)}s`);
}

module.exports = { initializeCivilSecurityNamespace };
