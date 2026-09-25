import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';

const PORT = parseInt(process.env.COLLAB_PORT || '4444', 10);

interface Room {
  name: string;
  doc: Y.Doc;
  clients: Set<WebSocket>;
}

const rooms = new Map<string, Room>();

function getOrCreateRoom(roomName: string): Room {
  let room = rooms.get(roomName);
  if (!room) {
    const doc = new Y.Doc();
    const clients = new Set<WebSocket>();
    room = { name: roomName, doc, clients };
    rooms.set(roomName, room);
    console.log(`[Relay] Created room: ${roomName}`);
  }
  return room;
}

const wss = new WebSocketServer({ port: PORT });

console.log(`[Relay] Collaboration server running on ws://localhost:${PORT}`);

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const roomName = url.searchParams.get('room') || 'hello.js';
  const room = getOrCreateRoom(roomName);

  room.clients.add(ws);
  console.log(`[Relay] Client connected to [${roomName}]. Active clients: ${room.clients.size}`);

  // Send initial state to newly connected client
  try {
    const stateUpdate = Y.encodeStateAsUpdate(room.doc);
    const syncMsg = JSON.stringify({
      type: 'sync',
      room: roomName,
      update: Buffer.from(stateUpdate).toString('base64')
    });
    ws.send(syncMsg);
  } catch (err) {
    console.error(`[Relay] Error sending initial sync to client:`, err);
  }

  ws.on('message', (message: string | Buffer) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'update' && data.update) {
        const updateBuffer = Buffer.from(data.update, 'base64');
        
        // Apply update to server doc
        Y.applyUpdate(room.doc, updateBuffer, ws);

        // Forward update to all other clients in this room
        const broadcastMsg = JSON.stringify({
          type: 'update',
          room: roomName,
          update: data.update
        });

        for (const client of room.clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(broadcastMsg);
          }
        }
      }
    } catch (err) {
      console.error(`[Relay] Error processing message:`, err);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`[Relay] Client disconnected from [${roomName}]. Active clients: ${room.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[Relay] Client socket error on [${roomName}]:`, err);
  });
});
