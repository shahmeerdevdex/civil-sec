# Civil Security Voice AI Chatbot

## Overview
The Civil Security Voice AI Chatbot is a real-time voice assistant designed to provide security-related information and assistance. It features speech recognition, text-to-speech, and integration with Pinecone for vector retrieval.

## Key Features
- Real-time speech recognition and text-to-speech
- Integration with Pinecone vector database for knowledge retrieval
- Optimized audio processing for fast response times
- Multi-language support
- Socket.IO for real-time communication

## Performance Optimizations
- Batch processing of TTS chunks (sending multiple chunks at once)
- Parallel TTS processing using Promise.all
- Optimized minimum chunk size (50 characters)
- Reduced silence timeout (200ms)
- Enhanced TTS caching with performance logging
- Detailed performance logging in seconds

## Setup Instructions

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn
- Google Cloud account with Speech-to-Text and Text-to-Speech APIs enabled
- Pinecone account with an index created

### Environment Variables
Create a `.env` file in the root directory with the following variables:

```
# OpenAI API Key (for embeddings)
OPENAI_API_KEY=your_openai_api_key

# Pinecone API Key
PINECONE_API_KEY=your_pinecone_api_key

# Azure OpenAI API Key (optional)
AZURE_OPENAI_API_KEY_NAME=your_azure_openai_api_key

# Port configuration
CIVIL_SECURITY_PORT=3001
```

### Google Cloud Credentials
Ensure your Google Cloud credentials are properly set up in the `google.json` file in the root directory.

### Pinecone Configuration
The app expects the following configuration from the frontend:
- `pinecone_index`: This is used as the namespace in Pinecone
- `pinecone_namespace`: This is used as the index name in Pinecone

For example, if your frontend sends:
```json
{
  "pinecone_index": "Texas",
  "pinecone_namespace": "index1"
}
```

The app will use:
- Index name: "index1"
- Namespace: "Texas"

### Installation
1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
   Or use the provided script:
   ```
   ./start-server.sh
   ```

## Usage
Once the server is running, you can access the chatbot at `http://localhost:3001` (or the port specified in your environment variables).

## Troubleshooting

### Pinecone Integration Issues
If you encounter issues with Pinecone integration:
1. Ensure your Pinecone API key is valid and correctly set in the `.env` file
2. Verify that your Pinecone index exists and is properly configured
3. Check the console logs for specific error messages

### Speech Recognition Errors
If speech recognition is not working:
1. Verify your Google Cloud credentials in the `google.json` file
2. Ensure the Speech-to-Text API is enabled in your Google Cloud project
3. Check browser console for any WebSocket connection errors

## License
ISC
