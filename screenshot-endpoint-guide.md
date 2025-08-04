# Screenshot Endpoint Usage Guide

This guide explains how to use the screenshot endpoint in the Studio Web API server to capture screenshots of the current browser page.

## Overview

The screenshot endpoint captures a screenshot of the current browser viewport and returns it as base64-encoded PNG data along with metadata about the current page.

## Prerequisites

### Environment Variables
You must set one of the following API keys in your environment:
- `ANTHROPIC_API_KEY` - For using Anthropic's Claude models
- `OPENAI_API_KEY` - For using OpenAI's models

### Optional Configuration
- `PORT` - Server port (default: 5553)

## Starting the Server

1. Make sure you have the required environment variables set:
```bash
export ANTHROPIC_API_KEY="your-api-key-here"
# OR
export OPENAI_API_KEY="your-api-key-here"
```

2. Start the server:
```bash
npm start
# or
node dist/server.js
```

The server will start on port 5553 by default.

## Endpoint Details

### URL
```
GET /screenshot
```

### Parameters
None required. The endpoint accepts no query parameters or request body.

### Automatic Browser Management
- The endpoint automatically starts a browser session if one isn't already running
- It waits for the page to be stable before taking the screenshot
- Default viewport size: 1500x800 pixels

## API Response

### Success Response (200 OK)
```json
{
  "success": true,
  "data": "iVBORw0KGgoAAAANSUhEUgAAA...", // Base64-encoded PNG data
  "encoding": "base64",
  "mimeType": "image/png",
  "current_url": "https://example.com",
  "current_title": "Example Page Title"
}
```

### Error Response (500 Internal Server Error)
```json
{
  "success": false,
  "error": "Error message describing what went wrong",
  "details": "Stack trace (in development mode)"
}
```

## Usage Examples

### 1. Basic Screenshot with cURL
```bash
curl -X GET http://localhost:5553/screenshot
```

### 2. JavaScript/Node.js
```javascript
async function takeScreenshot() {
  try {
    const response = await fetch('http://localhost:5553/screenshot');
    const data = await response.json();
    
    if (data.success) {
      console.log('Current URL:', data.current_url);
      console.log('Page Title:', data.current_title);
      
      // Convert base64 to image file
      const buffer = Buffer.from(data.data, 'base64');
      require('fs').writeFileSync('screenshot.png', buffer);
      console.log('Screenshot saved as screenshot.png');
    } else {
      console.error('Error:', data.error);
    }
  } catch (error) {
    console.error('Request failed:', error);
  }
}

takeScreenshot();
```

### 3. Python
```python
import requests
import base64

def take_screenshot():
    try:
        response = requests.get('http://localhost:5553/screenshot')
        data = response.json()
        
        if data['success']:
            print(f"Current URL: {data['current_url']}")
            print(f"Page Title: {data['current_title']}")
            
            # Save screenshot to file
            image_data = base64.b64decode(data['data'])
            with open('screenshot.png', 'wb') as f:
                f.write(image_data)
            print("Screenshot saved as screenshot.png")
        else:
            print(f"Error: {data['error']}")
    except Exception as e:
        print(f"Request failed: {e}")

take_screenshot()
```

### 4. Browser JavaScript (with CORS enabled)
```javascript
async function takeScreenshot() {
  try {
    const response = await fetch('http://localhost:5553/screenshot');
    const data = await response.json();
    
    if (data.success) {
      // Display the screenshot in an img element
      const img = document.createElement('img');
      img.src = `data:${data.mimeType};${data.encoding},${data.data}`;
      img.alt = `Screenshot of ${data.current_title}`;
      document.body.appendChild(img);
      
      console.log('Current URL:', data.current_url);
      console.log('Page Title:', data.current_title);
    } else {
      console.error('Error:', data.error);
    }
  } catch (error) {
    console.error('Request failed:', error);
  }
}
```

## Streaming Screenshots (Polling)

For real-time monitoring, you can poll the endpoint at regular intervals:

```javascript
class ScreenshotStreamer {
  constructor(intervalMs = 1000) {
    this.intervalMs = intervalMs;
    this.intervalId = null;
    this.isStreaming = false;
  }

  async fetchScreenshot() {
    try {
      const response = await fetch('http://localhost:5553/screenshot');
      const data = await response.json();
      
      if (data.success) {
        // Update your UI with the new screenshot
        this.onScreenshotReceived(data);
      }
    } catch (error) {
      console.error('Error fetching screenshot:', error);
    }
  }

  startStreaming() {
    if (this.isStreaming) return;
    
    this.isStreaming = true;
    this.fetchScreenshot(); // Initial fetch
    this.intervalId = setInterval(() => {
      this.fetchScreenshot();
    }, this.intervalMs);
  }

  stopStreaming() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isStreaming = false;
  }

  onScreenshotReceived(data) {
    // Override this method to handle screenshot updates
    console.log('New screenshot received for:', data.current_url);
  }
}

// Usage
const streamer = new ScreenshotStreamer(1000); // 1 second interval
streamer.onScreenshotReceived = (data) => {
  // Update your image element
  document.getElementById('screenshot').src = 
    `data:${data.mimeType};${data.encoding},${data.data}`;
};
streamer.startStreaming();
```

## Integration with Other Endpoints

The screenshot endpoint works well with other browser control endpoints:

### 1. Navigate then Screenshot
```javascript
// First navigate to a page
await fetch('http://localhost:5553/goto', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com' })
});

// Then take a screenshot
const screenshot = await fetch('http://localhost:5553/screenshot');
```

### 2. Perform Action then Screenshot
```javascript
// Perform an action
await fetch('http://localhost:5553/act', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    action: 'click the search button',
    action_type: 'click' 
  })
});

// Take a screenshot to see the result
const screenshot = await fetch('http://localhost:5553/screenshot');
```

## Local File Storage

The endpoint automatically saves screenshots to a local `screenshots/` directory with randomly generated filenames. These files are saved asynchronously and won't affect the API response time.

## React Component Example

The server provides a pre-built React component for streaming screenshots:

```bash
# Access the component code at:
curl http://localhost:5553/chrome-streamer-component
```

This component includes:
- Start/stop streaming controls
- Click-to-interact functionality
- Real-time URL display

## Troubleshooting

### Common Issues

1. **Browser fails to start**
   - Ensure you have the required API key environment variable set
   - Check that Chrome/Chromium is installed on your system

2. **Screenshot endpoint returns 500 error**
   - Check server logs for specific error messages
   - Ensure the browser session is healthy by calling `/start_browser` first

3. **Long response times**
   - The endpoint waits for page stability before capturing
   - Complex pages with ongoing animations may take longer

### Health Check

Before taking screenshots, you can verify the browser is running:

```javascript
const healthCheck = await fetch('http://localhost:5553/start_browser', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({})
});
```

## Performance Considerations

- Screenshots are captured at CSS scale with animations disabled
- Viewport-only captures (not full page) for faster performance
- Network idle state waiting has a 5-second timeout
- Base64 encoding adds ~33% to the data size

## Security Notes

- The endpoint doesn't require authentication by default
- Screenshots may contain sensitive information visible in the browser
- Consider implementing access controls for production use
- Local screenshot files are automatically cleaned up by other endpoints

## Next Steps

- Explore the `/act` endpoint for browser automation
- Use `/goto` for navigation
- Check `/start_browser` for browser configuration options
- Review the React component for interactive screenshot streaming 