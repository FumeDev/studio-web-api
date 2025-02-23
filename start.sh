#!/bin/bash

# Start Xvfb
Xvfb :1 -screen 0 1024x768x24 &
export DISPLAY=:1

# Wait for Xvfb to start
sleep 2

# Start the Node.js server
tsx src/server.ts 