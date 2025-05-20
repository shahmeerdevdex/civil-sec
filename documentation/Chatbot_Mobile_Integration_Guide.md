# Civil Security Chatbot Mobile Integration Guide

This guide explains how to integrate the Civil Security AI Chatbot with your mobile application (iOS, Android, React Native, Flutter, etc.).

---

## 1. Overview
- The Civil Security Chatbot provides real-time, AI-powered security assistance via REST API and Socket.IO endpoints.
- Supports text chat, streaming audio responses (TTS), and advanced conversation management.
- Optimized for low latency and high reliability.

---

## 2. Key Features
- **Text and Voice Chat**: Send text queries and receive both text and audio responses.
- **Streaming Audio**: Receive audio in chunks for instant playback (low latency).
- **Conversation History**: Maintain chat history for context-aware responses.
- **Performance Optimizations**: Fast chunked TTS, caching, and parallel processing.

---

## 3. API Endpoints

### a. Socket.IO (Recommended for Real-Time)
- **Namespace**: `/civil-security`
- **Events**:
  - `message` (client → server): Send a chat message `{ query: string, chatHistory: array }`
  - `audio-out` (server → client): Receive audio chunk `{ audio: base64 }`
  - `response-end` (server → client): End of response `{ message: string, timeTaken: number }`
  - `error` (server → client): Error message

#### Example (JavaScript/React Native):
```javascript
import io from 'socket.io-client';

const socket = io('https://your-server.com/civil-security');

socket.emit('message', {
  query: 'What are the emergency procedures?',
  chatHistory: [
    { query: 'Who can access the building?', response: 'Only authorized personnel.' }
  ]
});

socket.on('audio-out', (data) => {
  // Play audio chunk (base64-encoded WAV)
});

socket.on('response-end', (data) => {
  // Display final text response
});

socket.on('error', (err) => {
  // Handle error
});
```

### b. REST API (For Text-Only or Non-Realtime)
- **POST** `/api/civil-security/chat`
  - **Body**: `{ query: string, chatHistory: array }`
  - **Response**: `{ response: string }`

#### Example (Axios):
```javascript
import axios from 'axios';

const res = await axios.post('https://your-server.com/api/civil-security/chat', {
  query: 'What is the visitor policy?',
  chatHistory: []
});
console.log(res.data.response);
```

---

## 4. Authentication
- Most endpoints require a JWT token in the `Authorization` header.
- Obtain the token via login (`/api/auth/login`) and store it securely.
- Include the token for all requests:
  - REST: `Authorization: Bearer <token>`
  - Socket.IO: `{ auth: { token: '<token>' } }` during connection

---

## 5. Audio Playback (Mobile)
- Decode received `audio` (base64) to WAV and play using your platform's audio library.
- For React Native: use `react-native-sound` or similar.
- For Flutter: use `audioplayers` or `just_audio`.

---

## 6. Conversation History
- Maintain an array of `{ query, response }` for context-aware answers.
- Always send the latest history with each message.

---

## 7. Error Handling
- Listen for `error` events (Socket.IO) or check error fields in REST responses.
- Handle network issues and token expiry gracefully.

---

## 8. Example Chat Flow
1. User sends a message via Socket.IO or REST.
2. Server streams audio chunks and/or sends text response.
3. Client plays audio and displays text.
4. Client appends new exchange to chat history.

---

## 9. Security & Best Practices
- Always use HTTPS in production.
- Store tokens securely (Keychain/Keystore/SecureStorage).
- Never expose sensitive API keys in the app.
- Limit permissions and validate all user input.

---

## 10. Support
For integration help, contact the backend team or refer to the main API documentation.
