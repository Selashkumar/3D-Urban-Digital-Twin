const WebSocket = require('ws');

const url = 'wss://3d-urban-twin-backend-fpgufvbxgqbsefgx.southindia-01.azurewebsites.net/ws';
console.log('Connecting to:', url);

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('Connected successfully!');
});

ws.on('message', (data) => {
  console.log('Received message:', data.toString());
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket Error:', err);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log(`Connection closed: ${code} - ${reason}`);
});

// timeout after 10 seconds
setTimeout(() => {
  console.error('Connection timed out');
  ws.close();
  process.exit(1);
}, 10000);
