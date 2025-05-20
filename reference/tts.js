// const textToSpeech = require("@google-cloud/text-to-speech");
const stream = require("stream");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);
const { pipeline } = require("stream");
const { promisify } = require("util");
const pipelineAsync = promisify(pipeline);

// Import the simple cache for TTS responses
const { responseCache } = require('./simpleCache');

process.env.GOOGLE_APPLICATION_CREDENTIALS = "google.json";

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

// const client = new textToSpeech.TextToSpeechClient();

// In-memory cache for ultra-fast responses
const ultraFastCache = new Map();

// Cache for common phrases that will be pre-loaded
const commonPhraseCache = new Map();

// Pre-generate silent audio buffer for immediate response
const silentAudio = Buffer.from('UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==', 'base64'); // 1KB of silence

// Pre-generated audio for common responses
const preGeneratedAudio = {
  greeting: Buffer.from('UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==', 'base64'),
  thinking: Buffer.from('UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==', 'base64'),
  error: Buffer.from('UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==', 'base64')
};

// Common phrases to pre-cache
const commonPhrases = [
  "Thank you for your question.",
  "I understand.",
  "Let me check that for you.",
  "Is there anything else you'd like to know?",
  "Hello",
  "Yes",
  "No",
  "We provide",
  "Our services",
  "Please",
  "Thank you"
];

async function googleTextToWav(voiceName, text, speech_client) {
  const startTime = Date.now();
  
  // Skip TTS for empty or very short text
  if (!text || text.trim().length <= 1) {
    console.log('Skipping TTS for empty or very short text');
    return silentAudio; // Return silent audio instead of null for smoother playback
  }
  
  // Check for common phrases in cache first
  if (text.length < 60) {
    const ultraCacheKey = `${voiceName}:${text}`;
    if (ultraFastCache.has(ultraCacheKey)) {
      const cacheTime = Date.now() - startTime;
      console.log(`Using ultra-fast cached TTS audio (${(cacheTime/1000).toFixed(5)}s)`);
      return ultraFastCache.get(ultraCacheKey);
    }
  }
  
  // For ultra-fast response, use a simplified approach for short text
  // This significantly reduces processing time for common phrases
  if (text.length < 50) {
    // Use ultra-fast settings for short text
    const request = {
      input: { text },
      voice: { name: voiceName, languageCode: voiceName.substring(0, 5) },
      audioConfig: { 
        audioEncoding: "LINEAR16",
        sampleRateHertz: 8000, // Lower sample rate for faster processing
        effectsProfileId: ["small-bluetooth-speaker-class-device"], // Optimized for speed
        pitch: 0,
        speakingRate: 1.1 // Slightly faster speaking rate
      }
    };
    
    // Check cache first
    const ultraCacheKey = `${voiceName}:${text}`;
    if (ultraFastCache.has(ultraCacheKey)) {
      const cacheTime = Date.now() - startTime;
      console.log(`Using ultra-fast cached TTS audio (${(cacheTime/1000).toFixed(5)}s)`);
      return ultraFastCache.get(ultraCacheKey);
    }
    
    // Generate audio with optimized settings
    try {
      const [response] = await speech_client.synthesizeSpeech(request);
      const audioContent = response.audioContent;
      
      // Cache for future use
      ultraFastCache.set(ultraCacheKey, audioContent);
      responseCache.set(responseCache.generateKey(text, voiceName), audioContent);
      
      const genTime = Date.now() - startTime;
      console.log(`Generated ultra-fast TTS in ${(genTime/1000).toFixed(5)}s`);
      return audioContent;
    } catch (error) {
      console.error('Error in ultra-fast TTS:', error.message);
      // Fall through to standard processing
    }
  }
  
  // 1. Check ultra-fast in-memory cache first (no serialization overhead)
  const ultraCacheKey = `${voiceName}:${text}`;
  if (ultraFastCache.has(ultraCacheKey)) {
    const cacheTime = Date.now() - startTime;
    console.log(`Using ultra-fast cached TTS audio (${(cacheTime/1000).toFixed(5)}s)`);
    return ultraFastCache.get(ultraCacheKey);
  }
  
  // 2. Check persistent cache
  const cacheKey = responseCache.generateKey(text, voiceName);
  const cachedAudio = responseCache.get(cacheKey);
  if (cachedAudio) {
    // Add to ultra-fast cache for future use
    ultraFastCache.set(ultraCacheKey, cachedAudio);
    
    const cacheTime = Date.now() - startTime;
    console.log(`Using cached TTS audio (${(cacheTime/1000).toFixed(5)}s)`);
    return cachedAudio;
  }

  // 3. Check if this is a common phrase or contains common phrases
  for (const phrase of commonPhrases) {
    if (text.includes(phrase)) {
      // Try to get the phrase from cache
      const phraseKey = responseCache.generateKey(phrase, voiceName);
      const phraseCached = responseCache.get(phraseKey);
      
      if (phraseCached) {
        // Use the cached phrase as a fallback
        console.log(`Using cached common phrase as fallback: "${phrase}"`);
        
        // Store in both caches for future use
        responseCache.set(cacheKey, phraseCached);
        ultraFastCache.set(ultraCacheKey, phraseCached);
        
        return phraseCached;
      }
    }
  }

  // Determine language code from voice name
  const languageCode = voiceName.substring(0, 5);
  
  // Configure request with ultra-fast settings
  const request = {
    input: { text },
    voice: { name: voiceName, languageCode },
    audioConfig: { 
      audioEncoding: "LINEAR16", 
      sampleRateHertz: 8000, // Ultra-low sample rate for maximum speed
      effectsProfileId: ['small-bluetooth-speaker-class-device'], // Optimize for faster processing
      pitch: 0,
      speakingRate: 1.0
    },
  };

  try {
    // Call Google TTS API with short timeout
    const apiPromise = speech_client.synthesizeSpeech(request);
    
    // Add a timeout to prevent hanging on slow API responses (reduced to 2 seconds)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TTS API timeout')), 2000);
    });
    
    // Race the API call against the timeout
    const [response] = await Promise.race([apiPromise, timeoutPromise]);
    const audioContent = response.audioContent;
    
    // Store in both caches for future use
    responseCache.set(cacheKey, audioContent);
    ultraFastCache.set(ultraCacheKey, audioContent);
    
    // If this is a common phrase, cache it separately
    for (const phrase of commonPhrases) {
      if (text.includes(phrase)) {
        const phraseKey = responseCache.generateKey(phrase, voiceName);
        responseCache.set(phraseKey, audioContent);
        ultraFastCache.set(`${voiceName}:${phrase}`, audioContent);
      }
    }
    
    const apiTime = Date.now() - startTime;
    console.log(`Google TTS API call completed in ${(apiTime/1000).toFixed(3)}s - ${text.length} chars, ${(audioContent.length/1024).toFixed(1)}KB`);
    
    return audioContent;
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`TTS error after ${(errorTime/1000).toFixed(3)}s:`, error.message);
    
    // Generate silent audio as fallback
    console.log("Generating silent audio as fallback");
    const silentAudio = Buffer.alloc(1000); // Small buffer of silence
    
    // Cache the silent audio to prevent future API calls for this text
    responseCache.set(cacheKey, silentAudio);
    ultraFastCache.set(ultraCacheKey, silentAudio);
    
    return silentAudio;
  }
}

async function googleTextToBase64(voiceName, text, speech_model) {
  console.log(text, "Bot response");
  const request = {
    input: { ssml: `<speak>${text}</speak>` },
    voice: {
      languageCode: voiceName.split("-").slice(0, 2).join("-"),
      name: voiceName,
    },
    audioConfig: { audioEncoding: "LINEAR16" },
  };

  try {
    const [response] = await speech_model.synthesizeSpeech(request);
    const audioContent = response.audioContent;
    const audioDuration = getWavAudioDuration(audioContent);

    // return new Promise((resolve, reject) => {
    //   const wavStream = new stream.PassThrough();
    //   wavStream.end(audioContent);

    //   const mulawStream = new stream.PassThrough();
    //   const chunks = [];

    //   mulawStream.on("data", (chunk) => {
    //     chunks.push(chunk);
    //   });

    //   mulawStream.on("end", () => {
    //     const buffer = Buffer.concat(chunks);
    //     const base64Audio = buffer.toString("base64");
    //     resolve({ base64Audio, audioDuration });
    //   });

    //   mulawStream.on("error", (err) => {
    //     reject(err);
    //   });

    //   ffmpeg(wavStream)
    //     .audioFrequency(8000)
    //     .audioChannels(1)
    //     .audioCodec("pcm_mulaw")
    //     .format("mulaw")
    //     .on("error", (err) => reject(err))
    //     .pipe(mulawStream, { end: true });
    // });

    const wavStream = new stream.PassThrough();
    wavStream.end(audioContent);

    const ffmpegStream = ffmpeg(wavStream)
      .audioFrequency(8000)
      .audioChannels(1)
      .audioCodec("pcm_mulaw")
      .format("mulaw")
      .on("error", (err) => console.error("FFmpeg error:", err));

    const mulawStream = new stream.PassThrough();
    const chunks = [];
    mulawStream.on("data", (chunk) => chunks.push(chunk));
    await pipelineAsync(ffmpegStream, mulawStream);

    const buffer = Buffer.concat(chunks);
    const base64Audio = buffer.toString("base64");
    return { base64Audio, audioDuration };
  } catch (error) {
    console.error("Error in Google TTS or audio conversion:", error);
  }
}

function getWavAudioDuration(buffer) {
  if (buffer.length < 44) throw new Error("Invalid WAV file.");
  const byteRate = buffer.readUInt32LE(28);
  const dataSize = buffer.readUInt32LE(40);
  const durationInSeconds = dataSize / byteRate;
  return Math.round(durationInSeconds * 1000);
}

module.exports = { googleTextToWav, googleTextToBase64 };
