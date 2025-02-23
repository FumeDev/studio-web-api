#!/bin/bash

# Set the base URL
BASE_URL="http://34.168.116.89:5553"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "Testing Stagehand API endpoints..."

# Function to print response
print_response() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Success${NC}"
        echo "$1"
    else
        echo -e "${RED}Failed${NC}"
    fi
    echo "----------------------------------------"
}

# 1. Setup Agent
echo "1. Testing /setup_agent endpoint..."
response=$(curl -s -X POST "$BASE_URL/setup_agent" \
    -H "Content-Type: application/json" \
    -d '{
        "anthropicApiKey": "your-api-key-here",
        "force": true
    }')
print_response "$response"

# 2. Start Browser
echo "2. Testing /start_browser endpoint..."
response=$(curl -s -X POST "$BASE_URL/start_browser")
print_response "$response"

# 3. Navigate to URL
echo "3. Testing /goto endpoint..."
response=$(curl -s -X POST "$BASE_URL/goto" \
    -H "Content-Type: application/json" \
    -d '{
        "url": "https://www.example.com"
    }')
print_response "$response"

# 4. Take Screenshot
echo "4. Testing /screenshot endpoint..."
curl -s "$BASE_URL/screenshot" -o "screenshot.png"
if [ -f "screenshot.png" ]; then
    echo -e "${GREEN}Screenshot saved as screenshot.png${NC}"
else
    echo -e "${RED}Failed to save screenshot${NC}"
fi
echo "----------------------------------------"

# 5. Perform Action
echo "5. Testing /act endpoint..."
response=$(curl -s -X POST "$BASE_URL/act" \
    -H "Content-Type: application/json" \
    -d '{
        "action": "Click on the first link",
        "url": "https://www.example.com"
    }')
print_response "$response"

# 6. Get Folder Tree
echo "6. Testing /folder-tree endpoint..."
response=$(curl -s "$BASE_URL/folder-tree?folder_path=Documents")
print_response "$response"

# 7. Find Repository
echo "7. Testing /find-repo endpoint..."
response=$(curl -s -X POST "$BASE_URL/find-repo" \
    -H "Content-Type: application/json" \
    -d '{
        "remote_url": "https://github.com/yourusername/yourrepo.git"
    }')
print_response "$response"

echo "All tests completed!" 