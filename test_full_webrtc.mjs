import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:5553/webrtc-signal');

// Simulate RTCPeerConnection
const mockPeerConnection = {
  createAnswer: async () => ({
    type: 'answer',
    sdp: 'mock-answer-sdp'
  }),
  setLocalDescription: async (desc) => {
    console.log('Set local description:', desc.type);
  },
  setRemoteDescription: async (desc) => {
    console.log('Set remote description:', desc.type);
  },
  addIceCandidate: async (candidate) => {
    console.log('Added ICE candidate');
  }
};

ws.on('open', function open() {
  console.log('WebSocket connected');
  
  // Send start-stream message
  ws.send(JSON.stringify({
    type: 'start-stream',
    width: 1920,
    height: 1080
  }));
});

ws.on('message', async function message(data) {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg.type);
  
  switch (msg.type) {
    case 'offer':
      console.log('Processing WebRTC offer...');
      await mockPeerConnection.setRemoteDescription(msg.offer);
      const answer = await mockPeerConnection.createAnswer();
      await mockPeerConnection.setLocalDescription(answer);
      
      // Send answer back
      ws.send(JSON.stringify({
        type: 'answer',
        answer: answer
      }));
      break;
      
    case 'ice-candidate':
      console.log('Processing ICE candidate...');
      if (msg.candidate) {
        await mockPeerConnection.addIceCandidate(msg.candidate);
      }
      break;
      
    default:
      console.log('Unknown message type:', msg.type);
  }
});

ws.on('error', function error(err) {
  console.error('WebSocket error:', err);
});

ws.on('close', function close() {
  console.log('WebSocket closed');
  process.exit(0);
});

// Keep alive for 10 seconds to process all messages
setTimeout(() => {
  console.log('Test complete, closing connection');
  ws.close();
}, 10000);