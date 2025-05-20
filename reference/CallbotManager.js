const textToSpeech = require("@google-cloud/text-to-speech");
const { Pinecone } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("@langchain/pinecone");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");
const pool = require("../database");
const tts = require("./tts");
const {
  createChain,
  parseConversationHistory,
  processChat,
  predict_sentiment_and_summary,
  get_call_cut_response,
  get_res_after_silence,
} = require("./agent_chatbot");
const speech = require("@google-cloud/speech");
const googleConfig = require("../../google.json");
dotenv.config();

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
});

const pinecone_cl = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const client = new textToSpeech.TextToSpeechClient();

const speechClient = new speech.SpeechClient({
  projectId: googleConfig.project_id,
  credentials: {
    private_key: googleConfig.private_key,
    client_email: googleConfig.client_email,
  },
});

const getAgentDetails = async (jobId) => {
  try {
    const jobAgentQuery = await pool.query(
      `SELECT a.language, a.voice_type, a.template_id, j.agent_id, j.job_type 
       FROM jobs j
       JOIN agents a ON j.agent_id = a.id
       WHERE j.id = $1`,
      [jobId]
    );

    if (jobAgentQuery.rowCount === 0) {
      throw new Error("Job or Employee not found");
    }

    const { agent_id, language, voice_type, template_id, job_type } =
      jobAgentQuery.rows[0];

    const templateQuery = await pool.query(
      `SELECT company_question, greeting_question, rules_question, agenda_question, eligibility_question FROM industry_templates WHERE id = $1`,
      [template_id]
    );

    if (templateQuery.rowCount === 0) {
      throw new Error("Template not found");
    }

    const templateDetails = templateQuery.rows[0];
    const queriesToFilter = [
      templateDetails.company_question,
      templateDetails.greeting_question,
      templateDetails.rules_question,
      templateDetails.agenda_question,
      templateDetails.eligibility_question,
    ];

    const scriptQuery = await pool.query(
      `SELECT chat FROM scripts WHERE agent_id = $1`,
      [agent_id]
    );

    if (scriptQuery.rowCount === 0) {
      throw new Error("Script not found. Please Train your AI Employee");
    }

    const chat = scriptQuery.rows[0].chat;
    const filteredData = chat?.filter((item) =>
      queriesToFilter?.includes(item.query)
    );

    const additionalData = {};

    filteredData?.forEach((item) => {
      if (item.query === templateDetails.company_question) {
        additionalData.Company_introduction = item.response;
      } else if (item.query === templateDetails.greeting_question) {
        additionalData.Greeting_message = item.response;
      } else if (item.query === templateDetails.rules_question) {
        additionalData.Restrictions = item.response;
      } else if (item.query === templateDetails.agenda_question) {
        additionalData.End_requirements = item.response;
      } else if (item.query === templateDetails.eligibility_question) {
        additionalData.Eligibility_criteria = item.response;
      }
    });

    const dataTableQuery = await pool.query(`
      SELECT key FROM data_table, jsonb_each_text(data) AS data(key, value)
      WHERE value::jsonb @> '["${agent_id}"]'::jsonb
      LIMIT 1
    `);

    let pineconeIndex = null;
    if (dataTableQuery.rowCount > 0) {
      pineconeIndex = dataTableQuery.rows[0].key;
    }

    return {
      agent_id,
      job_type,
      language,
      voice_type,
      pineconeIndex,
      additionalData,
    };
  } catch (error) {
    console.error("Error fetching employee details:", error.message);
  }
};

const checkAndDeduct = async (jobId, activityId) => {
  try {
    const result = await pool.query(
      `SELECT us.id, us.amount, us.top_up_balance, sp.cost_per_min, 
       sp.overage_cost_per_min, sp.discount, ja.call_cost, j.phoneno_id
       FROM jobs j 
       JOIN user_subscriptions us ON j.uid = us.uid 
       JOIN subscription_plans sp ON us.plan_id = sp.id
       LEFT JOIN job_activity ja ON ja.job_id = j.id AND ja.id = $2
       WHERE j.id = $1 AND us.status = true`,
      [jobId, activityId]
    );

    if (result.rowCount === 0) {
      await pool.query("UPDATE jobs SET job_message = $1 WHERE id = $2", [
        "Call is terminating due to no active subscription found",
        jobId,
      ]);
      return false;
    }

    let {
      id,
      amount,
      top_up_balance,
      cost_per_min,
      overage_cost_per_min,
      discount,
      call_cost,
      phoneno_id,
    } = result.rows[0];

    if (!phoneno_id) {
      await pool.query("UPDATE jobs SET job_message = $1 WHERE id = $2", [
        "Call is terminating as phone number associated with this job not found",
        jobId,
      ]);
      return false;
    }

    amount = parseFloat(amount);
    top_up_balance = parseFloat(top_up_balance);
    cost_per_min = parseFloat(cost_per_min);
    overage_cost_per_min = parseFloat(overage_cost_per_min);
    discount = discount ? parseFloat(discount) : null;
    call_cost = call_cost ? parseFloat(call_cost) : 0;

    if (amount <= 0 && top_up_balance <= 0) {
      await pool.query("UPDATE jobs SET job_message = $1 WHERE id = $2", [
        "Call is terminating due to insufficient balance",
        jobId,
      ]);
      return false;
    }

    if (amount > 0) {
      const costPerMin = discount
        ? cost_per_min - (cost_per_min * discount) / 100
        : cost_per_min;

      amount -= costPerMin;
      if (amount < 0) amount = 0;

      await pool.query(
        "UPDATE user_subscriptions SET amount = $1 WHERE id = $2",
        [amount, id]
      );

      await pool.query("UPDATE job_activity SET call_cost = $1 WHERE id = $2", [
        call_cost + costPerMin,
        activityId,
      ]);

      return amount > 0;
    } else {
      top_up_balance -= overage_cost_per_min;
      if (top_up_balance < 0) top_up_balance = 0;

      await pool.query(
        "UPDATE user_subscriptions SET top_up_balance = $1 WHERE id = $2",
        [top_up_balance, id]
      );

      await pool.query("UPDATE job_activity SET call_cost = $1 WHERE id = $2", [
        call_cost + overage_cost_per_min,
        activityId,
      ]);

      return top_up_balance > 0;
    }
  } catch (error) {
    try {
      await pool.query("UPDATE jobs SET job_message = $1 WHERE id = $2", [
        "Call is terminating due to an error while deducting balance",
        jobId,
      ]);
    } catch (e) {}
    console.log(error.message);
    return false;
  }
};

const startPeriodicDeduction = async (ws, jobId, activityId) => {
  try {
    let initialDeduction = await checkAndDeduct(jobId, activityId);
    if (!initialDeduction) {
      ws.close();
      return;
    }

    const interval = setInterval(async () => {
      let deductionSuccessful = await checkAndDeduct(jobId, activityId);

      if (!deductionSuccessful) {
        ws.close();
        clearInterval(interval);
      }
    }, 60000);

    ws.on("close", () => {
      clearInterval(interval);
    });
  } catch (error) {
    ws.close();
    console.error(error);
  }
};

let dictConnection = {};

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

const outBoundStartMssg =
  "Start the conversationn by 'greeting_message' and tell the purpose of calling and ask his interest . Don't ask any other question";

const inBoundStartMssg =
  "Start the conversation by 'greeting_message' and show intent of assistance.";

const outboundSystemPrompt = `
  You are an intelligent call agent for outbound calls. The company will provide you with 'eligibility criteria,' 'restrictions', and 'end requirements'. \
 Your task is to navigate the conversation based on what the user says, collecting any needed details. \
 Make sure to use different sentence structures each time, and review the 'chat_history' to avoid repeating the same sentences at the end. \
 Stick strictly to the given 'context', and do not introduce information beyond what is stated.
 Context: {context}
 Chat History: {chat_history}
 **RESTRICTIONS:**
 1. Strictly limit response to the exact information found in the 'Context'; do not add, assume, infer, or present any suggestions, advice, service details, timings, or other details not provided in 'Context'. If information is not available in 'Context', politely *INFORM* that you do not have information about it.
 2. If there is any alternative information related to user query is in 'Context', provide that information to the user without adding additional information based on assumptions.
 3. Once the conversation has started, do not repeat an introduction or restart the conversation from the 'chat history.'
 4. Always review 'chat history' to determine what information has already been asked and provided. Do not offer further assistance or asking for "end requirements" repeatedly at the end of response if already offer/ask in 'chat history'.
 5. Do not ask for information out of order or in a way that disregards the user's current question or stage in the process.
 6. Do not request or collect information that is not explicitly specified to collect in the 'eligibility criteria', 'restrictions', 'end requirements', or 'context' like personal information or any other information etc under any circumstances.
 7. If you ask the user that if user has any further queries, wait for their response before making any closing remarks like 'Have a great day' or 'Bye' or somewhat similar to it.
 8. When all 'end requirements' have been gathered, do not restart from the beginning; instead, proceed to address any remaining user queries or bring the conversation to a close.
 9. Ensure the 'eligibility criteria' are met as early as possible in the conversation. If not met, politely apologize and offer further assistance.
 10. Maintain a natural, conversational tone, as a human agent would, and only greet the user once at the start of the conversation.
 11. Handle restrictions by asking questions from 'end requirements' one by one, making sure to avoid asking previously answered questions.
 12. If the user expresses disinterest, ask if they have any further queries before concluding the conversation.
 13. Your response must be exclusively in {language} Language.
 14. Your response must use the SSML <say-as> tag exclusively for formatting phone numbers(interpret as telephone), dates(interpret as date), currency values(interpret as cardinal), and characters(interpret as characters) etc.
   `;

const inboundSystemPrompt = `
You are an intelligent call agent for inbound calls. You will be given the company's 'eligibility criteria,' and 'restrictions'. \
   Your primary task is to provide response to user query while strictly adhering to the 'Context', and ensuring no information is added beyond what is explicitly mentioned in 'Context'.\
   Each section is delimeted by Sequence of '*'.
   Greeting Message:
   {Greeting_message}
   ********************************************************************************************************
   Guidelines:
   {Restrictions}
   ********************************************************************************************************
   Eligibility Criteria:
   {Eligibility_criteria}
   ********************************************************************************************************
   Context from which Chatbot should answer: {context}
   ********************************************************************************************************
   Chat History: {chat_history}
   ********************************************************************************************************
   **RESTRICTIONS:**
   1. Maintain a natural, conversational tone, as a human agent would, and only greet the user once at the start of the conversation.
   2. Strictly limit response to the exact information found in the 'Context'; do not add, assume, infer, or present any suggestions, advice, service details, timings, or other details not provided in 'Context'.\
   If information is not available in 'Context' or 'chat_history' , politely *INFORM* that you do not have information about it.
   3. If the user expresses interest in the services, wants to make a reservation, booking an appointment or has other related queries, politely ask for their name, phone number, and any other required details based on the domain-specific 'end requirements' before proceeding further.
   4. Do not restart the conversation from the 'chat history' and always review 'chat history' to determine what information has already been asked and provided.
   5. When asking if the user needs further assistance, ensure that the statement varies each time to avoid repetition. Use different phrasings such as *"Would you like help with anything else?"*, *"Is there anything else I can assist you with today?"*, *"Do you have any other questions I can help with?"*, *"Let me know if there's anything else you need help with."*, or *"Would you like any additional information or assistance?"*. These variations should be used naturally throughout the conversation to maintain a more engaging and dynamic interaction.
   6. Do not ask for information out of order or in a way that disregards the user's current question or stage in the process.
   7. Do not request or collect information that is not explicitly specified to collect in the 'eligibility criteria', 'restrictions', or 'context' like personal information or any other information etc. under any circumstances.
   8. Do not acknowledge or refer to general system information like 'eligibility criteria,' 'restrictions,' or 'greeting messages' unless directly relevant to the user's query. Focus on addressing the user's question without mentioning the system setup.
   9. If the user does not meet the 'eligibility criteria', politely inform them and then ask if the user needs any further assistance rather than ending the conversation immediately.
   10. Restrict chatbot to same language which is  {language}  Language.
   11. You must not independently suggest actions i.e. scheduling appointments, placing orders, or any other activities unless explicitly stated in the 'Context'.
   12. Ask for reason of calling once if its not explicitly stated or mentioned  inside the 'chat_history'.
   13. Avoid premature conclusions. After responding to a query, ask if the user needs any further assistance. Wait for the user to indicate they are satisfied before making closing remarks like 'Have a great day' or 'Goodbye.'
   14. Understand the current query asked by the user and give responses according to that query.
   `;

function initializeCallbotNamespace(wss) {
  wss.on("connection", async (ws, req) => {
    console.log("New Call Initiated");
    ws.id = uuidv4();
    let recognizeStream = null;
    const pathname = req.url;
    const pathParts = pathname.split("/");
    const jobId = pathParts[2];
    const activityId = pathParts[3];
    if (!Number(jobId) || !Number(activityId)) return ws.close();

    dictConnection[ws.id] = {
      connection: false,
      firstMessageCheck: true,
      delimeterCheck: false,
      conversationHistory: [],
      lastMessage: "",
    };

    let botProcessing = true;
    async function handleCommunication(socket, message, mSid) {
      const convHistory = parseConversationHistory(
        dictConnection[socket.id]?.conversationHistory
      );

      const chain = dictConnection[socket.id]?.chain;
      try {
        let lastAudioDuration = 0;
        let lastChunkDuration;
        for await (const { audio, duration } of getResponse(
          socket.id,
          chain,
          message,
          convHistory,
          dictConnection[socket.id]?.vectorStore,
          dictConnection[socket.id]?.language,
          dictConnection[socket.id]?.formData
        )) {
          socket.send(
            JSON.stringify({
              event: "media",
              streamSid: mSid,
              media: {
                payload: audio,
              },
            })
          );
          lastAudioDuration += duration;
          lastChunkDuration = duration;
        }

        setTimeout(() => {
          botProcessing = false;
        }, lastChunkDuration);

        dictConnection[socket.id].conversationHistory.push({
          query: message,
          response: dictConnection[socket.id].lastMessage.trim(),
        });

        var call_cut_resp = await get_call_cut_response(
          dictConnection[socket.id].conversationHistory
        );
        if (call_cut_resp?.FollowUpQueries === "NO") {
          setTimeout(() => {
            socket.close();
          }, lastAudioDuration - 1200);
        }
        dictConnection[socket.id].lastMessage = "";
        dictConnection[socket.id].delimeterCheck = false;
        const silenceCheckDuration = lastAudioDuration + 7000;
        lastAudioDuration = 0;

        if (dictConnection[socket.id]) {
          console.log("Adding new silence time out");
          dictConnection[socket.id].silenceTimeoutId = setTimeout(async () => {
            console.log("Working after silence function");
            if (dictConnection[socket.id]) {
              console.log("Sending silence message");
              let userData = dictConnection[socket.id];
              const lastObject = userData?.conversationHistory?.at(-1);

              botProcessing = true;
              var after_silence_resp = await get_res_after_silence(
                lastObject?.query,
                lastObject?.response
              );

              const userLanguage = userData?.language;
              const userVoiceType = userData?.voice_type;
              const voiceKey = `${userLanguage}-${userVoiceType}`;
              const googleVoice = voiceMap[voiceKey];

              const { base64Audio, audioDuration } =
                await tts.googleTextToBase64(
                  googleVoice,
                  after_silence_resp,
                  userData?.speech_model
                );

              socket.send(
                JSON.stringify({
                  event: "media",
                  streamSid: mSid,
                  media: {
                    payload: base64Audio,
                  },
                })
              );

              setTimeout(() => {
                botProcessing = false;
              }, audioDuration);

              if (dictConnection[socket.id]) {
                console.log("Starting running call cut func");
                dictConnection[socket.id].finalTimeoutId = setTimeout(() => {
                  console.log("Cutting call");
                  if (dictConnection[socket.id]) {
                    console.log("Successfully cut the call");
                    socket.close();
                  }
                }, audioDuration + 7000);
              }
            }
          }, silenceCheckDuration);
        }
      } catch (error) {
        console.error("Exception:", error);
        ws.close();
      }
    }

    try {
      const agentData = await getAgentDetails(jobId);
      if (agentData?.additionalData) {
        startPeriodicDeduction(ws, jobId, activityId);
        const {
          Company_introduction,
          Greeting_message,
          Eligibility_criteria,
          End_requirements,
          Restrictions,
        } = agentData.additionalData;

        let User_prompt;
        let SystemPrompt;
        let startMessage;

        if (agentData?.job_type === "Make Calls") {
          User_prompt = `
          Company Introduction:
          ${Company_introduction}

          Greeting Message:
          ${Greeting_message}

          Eligibility Criteria:
          ${Eligibility_criteria}

          End Requirements:
          ${End_requirements}

          Restrictions:
          ${Restrictions}
          `;

          SystemPrompt = outboundSystemPrompt;
          startMessage = outBoundStartMssg;
        } else if (agentData?.job_type === "Answer Calls") {
          SystemPrompt = inboundSystemPrompt;
          startMessage = inBoundStartMssg;
        }

        let vectorStore;
        vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
          pineconeIndex: pinecone_cl.Index(agentData?.pineconeIndex),
          namespace: agentData?.agent_id?.toString(),
        });
        dictConnection[ws.id].vectorStore = vectorStore;
        dictConnection[ws.id].voice_type = agentData?.voice_type;
        dictConnection[ws.id].language = agentData?.language;
        dictConnection[ws.id].languageCode =
          languageCodeMap[agentData?.language] || "en-US";
        let formData = {
          Greeting_message,
          Eligibility_criteria,
          Restrictions,
          type: agentData?.job_type,
        };
        dictConnection[ws.id].formData = formData;
        const chain = await createChain(SystemPrompt, User_prompt, formData);
        dictConnection[ws.id].chain = chain;
        dictConnection[ws.id].speech_model = client;
        let finalText = "";
        let silenceTimeout = null;
        let firstChunk = true;
        ws.on("message", async (message) => {
          const msg = JSON.parse(message);
          if (msg.event === "media") {
            if (firstChunk) {
              firstChunk = false;
              await handleCommunication(ws, startMessage, msg?.streamSid);
            } else {
              if (botProcessing) return;
              if (!recognizeStream) {
                recognizeStream = speechClient
                  .streamingRecognize({
                    config: {
                      encoding: "MULAW",
                      sampleRateHertz: 8000,
                      languageCode: dictConnection[ws.id].languageCode,
                      enableWordTimeOffsets: true,
                      enableAutomaticPunctuation: true,
                      enableWordConfidence: true,
                      enableSpeakerDiarization: true,
                      model: "phone_call", //old model command_and_search
                      useEnhanced: true,
                      enableNoiseReduction: true, // New Added
                    },
                    interimResults: true,
                  })
                  .on("error", (err) => {
                    stopRecognitionStream();
                  })
                  .on("data", (data) => {
                    const result = data.results[0];
                    const isFinal = result.isFinal;
                    const transcription = data.results
                      .map((result) => result.alternatives[0])
                      .filter((alt) => alt.confidence > 0.4)
                      .map((alt) => alt.transcript)
                      .join("\n");

                    if (
                      result?.alternatives[0]?.transcript &&
                      result?.alternatives[0]?.transcript?.length > 0
                    ) {
                      if (dictConnection[ws.id]?.silenceTimeoutId) {
                        console.log("Removing old silence time out");
                        clearTimeout(dictConnection[ws.id].silenceTimeoutId);
                        dictConnection[ws.id].silenceTimeoutId = null;
                      }

                      if (dictConnection[ws.id]?.finalTimeoutId) {
                        console.log("Removing old final silence time out");
                        clearTimeout(dictConnection[ws.id].finalTimeoutId);
                        dictConnection[ws.id].finalTimeoutId = null;
                      }
                    }

                    if (silenceTimeout) {
                      clearTimeout(silenceTimeout);
                    }

                    if (isFinal) {
                      finalText += transcription + " ";
                      stopRecognitionStream();
                    }
                    if (finalText.trim() === "") return;
                    silenceTimeout = setTimeout(async () => {
                      const textToSend = finalText;
                      finalText = "";
                      console.log(textToSend, "User Text");
                      if (!botProcessing) {
                        botProcessing = true;
                        await handleCommunication(
                          ws,
                          textToSend,
                          msg?.streamSid
                        );
                      }
                    }, 500);
                  });
              }
              recognizeStream.write(msg.media.payload);
            }
          }
        });
      } else {
        console.log("Employee data not found");
        ws.close();
      }
    } catch (error) {
      console.log("Error occured and socket closed");
      ws.close();
    }

    function stopRecognitionStream() {
      if (recognizeStream) {
        recognizeStream.end();
      }
      recognizeStream = null;
    }

    ws.on("close", () => {
      console.log("WebSocket connection closed");
      stopRecognitionStream();
      predict_sentiment_and_summary(
        dictConnection[ws.id].conversationHistory,
        activityId
      );
      delete dictConnection[ws.id];
    });
  });
}

async function* getResponse(
  sid,
  chain,
  query,
  chatHistory,
  vectorStore,
  language,
  formData
) {
  const responseGenerator = processChat(
    chain,
    query,
    chatHistory,
    vectorStore,
    "pinecone",
    language,
    formData
  );
  let collectedStr = "";
  const userLanguage = dictConnection[sid].language;
  const userVoiceType = dictConnection[sid].voice_type;
  const voiceKey = `${userLanguage}-${userVoiceType}`;
  const googleVoice = voiceMap[voiceKey];
  speech_model = dictConnection[sid].speech_model;

  for await (const value of responseGenerator) {
    if (value) {
      collectedStr += value;
    }

    if (
      value == "." ||
      value == "!" ||
      value == "?" ||
      value == "," ||
      value.includes("!") ||
      value.includes("?")
    ) {
      const { base64Audio, audioDuration } = await tts.googleTextToBase64(
        googleVoice,
        collectedStr.trim().replace(/\*\*/g, ""),
        speech_model
      );
      yield {
        audio: base64Audio,
        duration: audioDuration,
      };
      dictConnection[sid].lastMessage += collectedStr + " ";
      collectedStr = "";
    }
  }
}

module.exports = { initializeCallbotNamespace };
