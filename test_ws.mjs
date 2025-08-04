import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:5553/webrtc-signal');

ws.on('open', function open() {
  console.log('WebSocket connected');
  
  // Send start-stream message
  ws.send(JSON.stringify({
    type: 'start-stream',
    width: 1920,
    height: 1080
  }));
});

ws.on('message', function message(data) {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg);
  
  // Close after receiving response
  ws.close();
});

ws.on('error', function error(err) {
  console.error('WebSocket error:', err);
});

ws.on('close', function close() {
  console.log('WebSocket closed');
  process.exit(0);
});

// Timeout after 5 seconds
setTimeout(() => {
  console.log('Test timeout');
  ws.close();
  process.exit(1);
}, 5000);