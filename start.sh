#!/bin/bash

# Kill any existing Chrome processes (platform-agnostic approach)
echo "Killing any existing Chrome processes..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  pkill -f "Google Chrome" || true
else
  # Other platforms
  pkill -f chrome || true
  pkill -f chromium || true
fi

# Kill any process using port 5553 (platform-agnostic approach)
echo "Freeing port 5553..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  lsof -i :5553 | grep LISTEN | awk '{print $2}' | xargs kill -9 || true
else
  # Other platforms
  lsof -i :5553 | grep LISTEN | awk '{print $2}' | xargs -r kill -9 || true
fi

# Set API keys from .env file if they exist
if [ -f .env ]; then
  echo "Loading API keys from .env file..."
  export $(grep -v '^#' .env | xargs)
fi

# Print environment variable status
echo "Environment Variables Status:"
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:+set}${ANTHROPIC_API_KEY:-not set}"
echo "OPENAI_API_KEY: ${OPENAI_API_KEY:+set}${OPENAI_API_KEY:-not set}"
echo "DISPLAY: ${DISPLAY:-not set}"

# Check if API keys are set
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
  echo "Warning: Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set!"
  echo "Please set at least one of these in your .env file or environment."
fi

# Set environment variables for headless Chrome (platform-agnostic)
export PUPPETEER_HEADLESS=new

# Run the server
echo "Starting server with headless Chrome..."
npx tsx src/server.ts 