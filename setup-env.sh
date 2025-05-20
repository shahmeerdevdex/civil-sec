#!/bin/bash

# This script sets up the environment variables for the Civil Security app

# Check if .env file exists
if [ -f ".env" ]; then
  echo "Backing up existing .env file to .env.backup"
  cp .env .env.backup
fi

# Create or update .env file
cat > .env << EOL
# Pinecone API Key
PINECONE_API_KEY=your_pinecone_api_key_here

# OpenAI API Key (for embeddings)
OPENAI_API_KEY=your_openai_api_key_here

# Azure OpenAI API Key (optional)
# AZURE_OPENAI_API_KEY_NAME=your_azure_openai_api_key

# Port configuration
CIVIL_SECURITY_PORT=3001
EOL

echo "Environment variables file created at .env"
echo "Please edit the .env file and replace 'your_pinecone_api_key_here' with your actual Pinecone API key"
echo "Then run 'source .env' to load the environment variables"
