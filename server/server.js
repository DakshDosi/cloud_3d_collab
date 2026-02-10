import { WebSocketServer } from 'ws';
import { 
  VectorClock, 
  CRDTObject, 
  OperationType, 
  MessageType,
  generateId 
} from './types.js';

const PORT = 8080;

// Room Manager - manages state for each scene
class RoomManager {
  constructor(sceneId) {
    this.sceneId = sceneId;
    this.objects = new Map(); // objectId -> CRDTObject
    this.clients = new Map(); // clientId -> {ws, presence}
    this.vectorClock = new VectorClock();
    this.seqNum = 0;
    this.operationLog = []; // Recent operations for late joiners
    this.maxLogSize = 1000;
  }

  addClient(clientId, ws) {
    this.clients.set(clientId, {
      ws,
      presence: {
        cursor: null,
        selectedObjects: [],
        color: this.generateUserColor()
      }
    });
    console.log(`[Room ${this.sceneId}] Client ${clientId} joined (${this.clients.size} users)`);
  }

  removeClient(clientId) {
    this.clients.delete(clientId);
    console.log(`[Room ${this.sceneId}] Client ${clientId} left (${this.clients.size} users)`);
    
    // Clean up empty rooms
    if (this.clients.size === 0) {
      return true; // Signal room should be destroyed
    }
    return false;
  }

  generateUserColor() {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  handleOperation(operation, clientId) {
    // Increment sequence number
    this.seqNum++;
    operation.seqNum = this.seqNum;
    operation.serverTimestamp = Date.now();

    // Update vector clock
    this.vectorClock.increment(clientId);

    // Merge operation vector clock
    this.vectorClock = this.vectorClock.merge(
      new VectorClock(operation.vectorClock)
    );

    // Apply operation to authoritative state
    try {
      switch (operation.op) {
        case OperationType.CREATE:
          this.handleCreate(operation);
          break;
        case OperationType.DELETE:
          this.handleDelete(operation);
          break;
        case OperationType.TRANSFORM:
          this.handleTransform(operation);
          break;
        case OperationType.METADATA:
          this.handleMetadata(operation);
          break;
      }

      // Add to operation log
      this.operationLog.push(operation);
      if (this.operationLog.length > this.maxLogSize) {
        this.operationLog.shift();
      }

      // Broadcast to all clients
      this.broadcast(operation, clientId);

      return { success: true, operation };
    } catch (error) {
      console.error(`[Room ${this.sceneId}] Error applying operation:`, error);
      return { success: false, error: error.message };
    }
  }

  handleCreate(operation) {
    const obj = new CRDTObject(operation.objectId, operation.objectData.type, operation.objectData.geometry);
    
    // Set initial transform values
    if (operation.objectData.transform) {
      const { position, rotation, scale } = operation.objectData.transform;
      const vc = new VectorClock(operation.vectorClock);
      
      if (position) {
        obj.transform.position.set(position.value, operation.timestamp, operation.clientId, vc);
      }
      if (rotation) {
        obj.transform.rotation.set(rotation.value, operation.timestamp, operation.clientId, vc);
      }
      if (scale) {
        obj.transform.scale.set(scale.value, operation.timestamp, operation.clientId, vc);
      }
    }

    // Set metadata
    if (operation.objectData.metadata) {
      const vc = new VectorClock(operation.vectorClock);
      for (const [key, data] of Object.entries(operation.objectData.metadata)) {
        if (obj.metadata[key]) {
          obj.metadata[key].set(data.value, operation.timestamp, operation.clientId, vc);
        }
      }
    }

    obj.createdBy = operation.clientId;
    this.objects.set(operation.objectId, obj);
    console.log(`[Room ${this.sceneId}] Created object ${operation.objectId}`);
  }

  handleDelete(operation) {
    const obj = this.objects.get(operation.objectId);
    if (obj) {
      obj.delete(operation.timestamp, operation.clientId, new VectorClock(operation.vectorClock));
      console.log(`[Room ${this.sceneId}] Deleted object ${operation.objectId}`);
    }
  }

  handleTransform(operation) {
    const obj = this.objects.get(operation.objectId);
    if (obj && !obj.isDeleted()) {
      obj.updateProperty(
        `transform.${operation.property}`,
        operation.value,
        operation.timestamp,
        operation.clientId,
        new VectorClock(operation.vectorClock)
      );
    }
  }

  handleMetadata(operation) {
    const obj = this.objects.get(operation.objectId);
    if (obj && !obj.isDeleted()) {
      obj.updateProperty(
        `metadata.${operation.property}`,
        operation.value,
        operation.timestamp,
        operation.clientId,
        new VectorClock(operation.vectorClock)
      );
    }
  }

  broadcast(message, excludeClientId = null) {
    const payload = JSON.stringify(message);
    this.clients.forEach((client, clientId) => {
      if (clientId !== excludeClientId && client.ws.readyState === 1) { // 1 = OPEN
        client.ws.send(payload);
      }
    });
  }

  broadcastToAll(message) {
    this.broadcast(message, null);
  }

  getSnapshot() {
    const objectsData = {};
    this.objects.forEach((obj, id) => {
      if (!obj.isDeleted()) {
        objectsData[id] = obj.toJSON();
      }
    });

    const presenceData = [];
    this.clients.forEach((client, clientId) => {
      presenceData.push({
        clientId,
        ...client.presence
      });
    });

    return {
      type: MessageType.SNAPSHOT,
      sceneId: this.sceneId,
      objects: objectsData,
      presence: presenceData,
      vectorClock: this.vectorClock.toJSON(),
      lastSeqNum: this.seqNum,
      timestamp: Date.now()
    };
  }

  updatePresence(clientId, presenceData) {
    const client = this.clients.get(clientId);
    if (client) {
      client.presence = { ...client.presence, ...presenceData };
      
      // Broadcast presence update
      this.broadcastToAll({
        type: MessageType.PRESENCE,
        sceneId: this.sceneId,
        clientId,
        ...presenceData
      });
    }
  }
}

// Server manages multiple rooms
class CollaborativeServer {
  constructor(port) {
    this.port = port;
    this.rooms = new Map(); // sceneId -> RoomManager
    this.clientRooms = new Map(); // clientId -> sceneId
    this.wss = null;
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });
    
    this.wss.on('connection', (ws) => {
      let clientId = null;
      let sceneId = null;

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          switch (message.type) {
            case MessageType.JOIN:
              ({ clientId, sceneId } = message);
              this.handleJoin(ws, clientId, sceneId);
              break;

            case MessageType.OPERATION:
              this.handleOperation(message, clientId);
              break;

            case MessageType.PRESENCE:
              this.handlePresence(message, clientId);
              break;

            case MessageType.PING:
              ws.send(JSON.stringify({
                type: MessageType.PONG,
                timestamp: message.timestamp,
                serverTime: Date.now()
              }));
              break;
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(clientId);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });

    console.log(`🚀 Collaborative 3D Server running on ws://localhost:${this.port}`);
  }

  handleJoin(ws, clientId, sceneId) {
    // Get or create room
    let room = this.rooms.get(sceneId);
    if (!room) {
      room = new RoomManager(sceneId);
      this.rooms.set(sceneId, room);
      console.log(`Created new room: ${sceneId}`);
    }

    // Add client to room
    room.addClient(clientId, ws);
    this.clientRooms.set(clientId, sceneId);

    // Send snapshot to joining client
    const snapshot = room.getSnapshot();
    ws.send(JSON.stringify(snapshot));

    // Notify others about new user
    room.broadcast({
      type: 'user_joined',
      clientId,
      timestamp: Date.now()
    }, clientId);
  }

  handleOperation(message, clientId) {
    const sceneId = this.clientRooms.get(clientId);
    if (!sceneId) return;

    const room = this.rooms.get(sceneId);
    if (!room) return;

    room.handleOperation(message, clientId);
  }

  handlePresence(message, clientId) {
    const sceneId = this.clientRooms.get(clientId);
    if (!sceneId) return;

    const room = this.rooms.get(sceneId);
    if (!room) return;

    room.updatePresence(clientId, {
      cursor: message.cursor,
      selectedObjects: message.selectedObjects
    });
  }

  handleDisconnect(clientId) {
    if (!clientId) return;

    const sceneId = this.clientRooms.get(clientId);
    if (!sceneId) return;

    const room = this.rooms.get(sceneId);
    if (!room) return;

    const shouldDestroy = room.removeClient(clientId);
    
    // Notify others about user leaving
    room.broadcastToAll({
      type: 'user_left',
      clientId,
      timestamp: Date.now()
    });

    if (shouldDestroy) {
      this.rooms.delete(sceneId);
      console.log(`Destroyed empty room: ${sceneId}`);
    }

    this.clientRooms.delete(clientId);
  }
}

// Start server
const server = new CollaborativeServer(PORT);
server.start();
