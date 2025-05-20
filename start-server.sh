#!/bin/bash

# Set Google Cloud credentials environment variable
export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/google.json"

# Print confirmation
echo "Google credentials set to: $GOOGLE_APPLICATION_CREDENTIALS"

# Start the server
node index.js
