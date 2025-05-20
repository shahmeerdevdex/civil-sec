/**
 * Text-to-Speech Module for Civil Security Chatbot
 * 
 * This module provides optimized TTS functionality with caching
 * for improved performance and reduced latency.
 */

const textToSpeech = require('@google-cloud/text-to-speech');
const stream = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);

// Import the simple cache for TTS responses
const { ttsCache, responseCache } = require('./simpleCache');
const googleConfig = require('../../google.json');

process.env.GOOGLE_APPLICATION_CREDENTIALS = 'google.json';

/**
 * Determine the gender of a voice based on its name
 * @param {string} voice - Voice name
 * @returns {string} - 'FEMALE' or 'MALE'
 */
function determineVoiceGender(voice) {
  // Map specific voices to their correct gender
  const femaleVoices = [
    'en-US-Neural2-C',
    'ru-RU-Standard-A',
    'fr-FR-Standard-C',
    'es-ES-Standard-A'
  ];
  
  const maleVoices = [
    'en-GB-News-K',
    'ru-RU-Standard-B',
    'fr-FR-Standard-B',
    'es-ES-Standard-B'
  ];
  
  if (femaleVoices.includes(voice)) {
    return 'FEMALE';
  } else if (maleVoices.includes(voice)) {
    return 'MALE';
  }
  
  // Default fallback based on voice name pattern
  return 'NEUTRAL';
}

/**
 * Convert text to audio using Google Text-to-Speech
 * Includes performance optimizations and caching
 * 
 * @param {string} voiceName - The voice to use
 * @param {string} text - The text to convert to speech
 * @param {Object} speech_client - The Google TTS client
 * @returns {Promise<Buffer>} - The audio content
 */
async function googleTextToWav(voiceName, text, speech_client) {
  const startTime = Date.now();
  
  // Skip TTS for empty or very short text
  if (!text || text.trim().length <= 1) {
    console.log('Skipping TTS for empty or very short text');
    return Buffer.from('UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==', 'base64'); // Silent audio
  }
  
  // Check for common phrases in cache first
  if (text.length < 60) {
    const ultraCacheKey = `${voiceName}:${text}`;
    if (ttsCache.get(ultraCacheKey)) {
      const cacheTime = Date.now() - startTime;
      console.log(`Using ultra-fast cached TTS audio (${(cacheTime/1000).toFixed(5)}s)`);
      return ttsCache.get(ultraCacheKey);
    }
  }
  
  // For ultra-fast response, use a simplified approach for short text
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
    if (ttsCache.get(ultraCacheKey)) {
      const cacheTime = Date.now() - startTime;
      console.log(`Using ultra-fast cached TTS audio (${(cacheTime/1000).toFixed(5)}s)`);
      return ttsCache.get(ultraCacheKey);
    }
  }
  
  // If no client is provided, create one with explicit credentials
  if (!speech_client) {
    speech_client = new textToSpeech.TextToSpeechClient({
      projectId: googleConfig.project_id,
      credentials: {
        private_key: googleConfig.private_key,
        client_email: googleConfig.client_email,
      },
    });
  }
  
  try {
    // Generate a cache key for this request
    const cacheKey = responseCache.generateKey(text, voiceName);
    const ultraCacheKey = `${voiceName}:${text}`;
    
    // Check both caches
    const cachedResponse = responseCache.get(cacheKey) || ttsCache.get(ultraCacheKey);
    if (cachedResponse) {
      const cacheTime = Date.now() - startTime;
      console.log(`TTS cache hit in ${(cacheTime/1000).toFixed(3)}s`);
      return cachedResponse;
    }
    
    // Set up the request with high-quality settings for general text
    const request = {
      input: { text },
      voice: { 
        languageCode: voiceName.split('-')[0] + '-' + voiceName.split('-')[1], 
        name: voiceName,
        ssmlGender: determineVoiceGender(voiceName)
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.0,
        pitch: 0.0,
        effectsProfileId: ['small-bluetooth-speaker-class-device'],
      },
    };
    
    // Create a promise for the API call
    const apiPromise = speech_client.synthesizeSpeech(request);
    
    // Add a timeout to prevent hanging on slow API responses (2 seconds)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TTS API timeout')), 2000);
    });
    
    // Race the API call against the timeout
    const [response] = await Promise.race([apiPromise, timeoutPromise]);
    const audioContent = response.audioContent;
    
    // Store in both caches for future use
    responseCache.set(cacheKey, audioContent);
    ttsCache.set(ultraCacheKey, audioContent);
    
    // If this is a common phrase, cache it separately
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
    
    for (const phrase of commonPhrases) {
      if (text.includes(phrase)) {
        const phraseKey = responseCache.generateKey(phrase, voiceName);
        responseCache.set(phraseKey, audioContent);
        ttsCache.set(`${voiceName}:${phrase}`, audioContent);
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
    const cacheKey = responseCache.generateKey(text, voiceName);
    const ultraCacheKey = `${voiceName}:${text}`;
    responseCache.set(cacheKey, silentAudio);
    ttsCache.set(ultraCacheKey, silentAudio);
    
    return silentAudio;
  }
}

/**
 * Pre-warm the TTS cache with common phrases
 * 
 * @param {string} voice - The voice to use
 * @param {Object} client - The Google TTS client
 */
function prewarmTTSCache(voice, client) {
  const commonPhrases = [
    "Thank you for your question.",
    "I understand.",
    "Let me check that for you.",
    "Is there anything else you'd like to know?",
    "I'm here to help with security-related questions.",
    "Could you please provide more details?",
    "For security purposes, I need to verify some information.",
    "I'll look into that right away.",
    "Let me connect you with a security specialist.",
    "Hello",
    "Yes",
    "No",
    "We provide",
    "Our services",
    "Please",
    "Thank you"
  ];
  
  // Start preloading in the background
  setTimeout(() => {
    console.log("Pre-warming TTS cache with common phrases...");
    commonPhrases.forEach(phrase => {
      googleTextToWav(voice, phrase, client).catch(err => {
        console.error(`Error pre-warming cache: ${err.message}`);
      });
    });
  }, 0);
}

/**
 * Convert text to audio and return as base64 with wav-to-mulaw conversion
 * 
 * @param {string} voiceName - Voice name to use
 * @param {string} text - Text to convert to speech
 * @param {Object} speech_model - Google TTS client
 * @returns {Promise<Object>} - Object with base64Audio and audioDuration
 */
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
    return { base64Audio: "", audioDuration: 0 };
  }
}

/**
 * Calculate the duration of a WAV audio buffer
 * 
 * @param {Buffer} buffer - WAV audio buffer
 * @returns {number} - Duration in milliseconds
 */
function getWavAudioDuration(buffer) {
  if (buffer.length < 44) throw new Error("Invalid WAV file.");
  const byteRate = buffer.readUInt32LE(28);
  const dataSize = buffer.readUInt32LE(40);
  const durationInSeconds = dataSize / byteRate;
  return Math.round(durationInSeconds * 1000);
}

module.exports = {
  googleTextToWav,
  googleTextToBase64,
  prewarmTTSCache
};
