#!/bin/bash

# Kill any existing Chrome processes
echo "Killing any existing Chrome processes..."
pkill -f chrome || true
pkill -f chromium || true

# Kill any process using port 5553
echo "Freeing port 5553..."
lsof -i :5553 | grep LISTEN | awk '{print $2}' | xargs -r kill -9 || true

# Set API keys from .env file if they exist
if [ -f .env ]; then
  echo "Loading API keys from .env file..."
  export $(grep -v '^#' .env | xargs)
fi

# Check if API keys are set
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
  echo "Warning: Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set!"
  echo "Please set at least one of these in your .env file or environment."
fi

# Run the server
echo "Starting server..."
npx tsx src/server.ts 