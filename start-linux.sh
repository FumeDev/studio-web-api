#!/bin/bash

# This script is specifically for Linux environments to ensure Chrome runs properly in headless mode

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

# Set environment variables for headless Chrome
export PUPPETEER_HEADLESS=new
export CHROME_DBUS_DISABLE=1
export DBUS_SESSION_BUS_ADDRESS=/dev/null

# Explicitly set the browser to use headless mode
echo "Starting server with headless Chrome in Linux environment..."
BROWSER_HEADLESS=new npx tsx src/server.ts 