// // import express from "express";
// // import http from "http";
// // import cors from "cors";
// // import "dotenv/config";
// // import { WebSocketServer } from "ws";
// // import authRoutes from "./auth/authRoutes.js";
// // import modelRoutes from "./routes/modelRoutes.js";
// // import sceneRoutes from "./routes/sceneRoutes.js";

// // import { requestLogger, errorHandler } from "./middleware/errorHandler.js";

// // const PORT = process.env.PORT || 8080;


// // const app = express();
// // app.use(cors({
// //   origin: "http://localhost:3000"
// // }));
// // app.use(express.json());
// // app.use(requestLogger);

// // /* ---------------- REST API ---------------- */

// // app.use("/api/auth", authRoutes);
// // app.use("/api/models", modelRoutes);
// // app.use("/api/scenes", sceneRoutes);

// // app.get("/api/health", (req, res) => {
// //   res.json({ status: "ok" });
// // });

// // /* ---------------- HTTP SERVER ---------------- */

// // const server = http.createServer(app);

// // /* ---------------- WEBSOCKET ---------------- */

// // const wss = new WebSocketServer({ server });

// // const rooms = new Map();

// // wss.on("connection", (ws) => {
// //   let currentRoom = null;

// //   ws.on("message", (msg) => {
// //     try {
// //       const data = JSON.parse(msg);

// //       if (data.type === "join") {
// //         currentRoom = data.sceneId;

// //         if (!rooms.has(currentRoom)) {
// //           rooms.set(currentRoom, new Set());
// //         }

// //         rooms.get(currentRoom).add(ws);
// //       }

// //       if (data.type === "operation" && currentRoom) {
// //         const clients = rooms.get(currentRoom);

// //         for (const client of clients) {
// //           if (client !== ws && client.readyState === 1) {
// //             client.send(JSON.stringify(data));
// //           }
// //         }
// //       }
// //     } catch (err) {
// //       console.error("WS error:", err);
// //     }
// //   });

// //   ws.on("close", () => {
// //     if (currentRoom && rooms.has(currentRoom)) {
// //       rooms.get(currentRoom).delete(ws);
// //     }
// //   });
// // });

// // /* ---------------- ERROR HANDLER ---------------- */

// // app.use(errorHandler);

// // /* ---------------- START ---------------- */

// // server.listen(PORT, () => {
// //   console.log(`🚀 Server running on http://localhost:${PORT}`);
// // });


// // // import express from "express";
// // // import cors from "cors";
// // // import "dotenv/config";

// // // import authRoutes from "./auth/authRoutes.js";
// // // import modelRoutes from "./routes/modelRoutes.js";

// // // const app = express();

// // // app.use(cors());
// // // app.use(express.json());

// // // app.use("/api/auth", authRoutes);
// // // app.use("/api/models", modelRoutes);

// // // app.get("/api/health", (req, res) => {
// // //   res.json({ status: "ok" });
// // // });

// // // app.listen(8080, () => {
// // //   console.log("Server started on 8080");
// // // });

// // server/server.js

// import 'dotenv/config';
// import { createServer } from 'http';
// import { WebSocketServer } from 'ws';
// import express from 'express';
// import cors from 'cors';
// import helmet from 'helmet';
// import compression from 'compression';
// import { rateLimit } from 'express-rate-limit';
// import { parse as parseUrl } from 'url';
// import path from 'path';
// import { fileURLToPath } from 'url';

// import { VectorClock, CRDTObject, OperationType, MessageType, generateId } from './types.js';
// import { verifyWsToken } from './auth/authMiddleware.js';
// import authRoutes  from './auth/authRoutes.js';
// import sceneRoutes from './routes/sceneRoutes.js';
// import modelRoutes from './routes/modelRoutes.js';
// import { requestLogger, notFound, errorHandler } from './middleware/errorHandler.js';

// import {
//   persistOperation, persistSnapshot, loadSnapshot,
//   upsertObject, softDeleteObject, recordLineage
// } from './services/sceneService.js';
// import { maybeAutoSnapshot } from './services/versionService.js';

// const __dirname = path.dirname(fileURLToPath(import.meta.url));
// const PORT      = parseInt(process.env.PORT || '8080');
// const NODE_ENV  = process.env.NODE_ENV || 'development';

// // ─────────────────────────────────────────────────────────────────────────────
// // CORS CONFIG  ← this was the CORS bug: was too restrictive
// // ─────────────────────────────────────────────────────────────────────────────
// const CORS_ORIGINS = process.env.ALLOWED_ORIGINS
//   ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
//   : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];

// const corsOptions = {
//   origin: (origin, cb) => {
//     // Allow requests with no origin (curl, Postman, same-origin)
//     if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
//     // In development allow everything
//     if (NODE_ENV === 'development') return cb(null, true);
//     cb(new Error(`CORS: origin ${origin} not allowed`));
//   },
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization'],
// };

// // ─────────────────────────────────────────────────────────────────────────────
// // ROOM MANAGER  (CRDT engine — unchanged logic + persistence hooks)
// // ─────────────────────────────────────────────────────────────────────────────
// class RoomManager {
//   constructor(sceneId) {
//     this.sceneId      = sceneId;
//     this.objects      = new Map();
//     this.clients      = new Map();
//     this.vectorClock  = new VectorClock();
//     this.seqNum       = 0;
//     this.operationLog = [];
//     this.maxLogSize   = 1000;
//     this.undoStacks   = new Map();
//     this.redoStacks   = new Map();
//     this._dirty       = false;
//     this._flushTimer  = null;
//   }

//   async hydrateFromDB() {
//     try {
//       const saved = await loadSnapshot(this.sceneId);
//       if (!saved?.snapshotJson) return;
//       const { objects, vectorClock, lastSeqNum } = saved.snapshotJson;
//       if (objects) {
//         for (const [id, data] of Object.entries(objects)) {
//           this.objects.set(id, CRDTObject.fromJSON(data));
//         }
//       }
//       if (vectorClock) this.vectorClock = VectorClock.fromJSON(vectorClock);
//       if (lastSeqNum)  this.seqNum      = lastSeqNum;
//       console.log(`[Room ${this.sceneId}] hydrated ${this.objects.size} objects`);
//     } catch (err) {
//       console.error(`[Room ${this.sceneId}] hydrate failed:`, err.message);
//     }
//   }

//   addClient(clientId, ws, userId = null) {
//     this.clients.set(clientId, {
//       ws, userId,
//       presence: { cursor: null, selectedObjects: [], color: this._color() }
//     });
//     this.undoStacks.set(clientId, []);
//     this.redoStacks.set(clientId, []);
//   }

//   removeClient(clientId) {
//     this.clients.delete(clientId);
//     this.undoStacks.delete(clientId);
//     this.redoStacks.delete(clientId);
//     if (this.clients.size === 0) { this._flushSnapshot(); return true; }
//     return false;
//   }

//   _color() {
//     const c = ['#FF6B6B','#4ECDC4','#45B7D1','#FFA07A','#98D8C8','#F7DC6F','#BB8FCE','#85C1E2'];
//     return c[Math.floor(Math.random() * c.length)];
//   }

//   async handleOperation(operation, clientId) {
//     this.seqNum++;
//     operation.seqNum          = this.seqNum;
//     operation.serverTimestamp = Date.now();

//     this.vectorClock.increment(clientId);
//     this.vectorClock = this.vectorClock.merge(new VectorClock(operation.vectorClock || {}));

//     try {
//       switch (operation.op) {
//         case OperationType.CREATE:    this._handleCreate(operation);    break;
//         case OperationType.DELETE:    this._handleDelete(operation);    break;
//         case OperationType.TRANSFORM: this._handleTransform(operation); break;
//         case OperationType.METADATA:  this._handleMetadata(operation);  break;
//         case OperationType.MERGE:     this._handleMerge(operation);     break;
//       }

//       this.operationLog.push(operation);
//       if (this.operationLog.length > this.maxLogSize) this.operationLog.shift();

//       this.broadcast(operation, clientId);

//       const userId = this.clients.get(clientId)?.userId;
//       setImmediate(() => this._persist({ ...operation, userId }));

//       return { success: true, operation };
//     } catch (err) {
//       console.error(`[Room ${this.sceneId}] op error:`, err);
//       return { success: false, error: err.message };
//     }
//   }

//   _handleCreate(op) {
//     const obj = new CRDTObject(op.objectId, op.objectData.type, op.objectData.geometry);
//     const vc  = new VectorClock(op.vectorClock);
//     const { position, rotation, scale } = op.objectData.transform || {};
//     if (position) obj.transform.position.set(position.value, op.timestamp, op.clientId, vc);
//     if (rotation) obj.transform.rotation.set(rotation.value, op.timestamp, op.clientId, vc);
//     if (scale)    obj.transform.scale.set(scale.value,       op.timestamp, op.clientId, vc);
//     if (op.objectData.metadata) {
//       for (const [k, d] of Object.entries(op.objectData.metadata)) {
//         if (obj.metadata[k]) obj.metadata[k].set(d.value, op.timestamp, op.clientId, vc);
//       }
//     }
//     obj.createdBy = op.clientId;
//     this.objects.set(op.objectId, obj);
//     this._dirty = true;
//   }

//   _handleDelete(op) {
//     const obj = this.objects.get(op.objectId);
//     if (obj) {
//       obj.delete(op.timestamp, op.clientId, new VectorClock(op.vectorClock));
//       this._dirty = true;
//       setImmediate(() => softDeleteObject(op.objectId).catch(() => {}));
//     }
//   }

//   _handleTransform(op) {
//     const obj = this.objects.get(op.objectId);
//     if (obj && !obj.isDeleted()) {
//       obj.updateProperty(`transform.${op.property}`, op.value, op.timestamp, op.clientId, new VectorClock(op.vectorClock));
//       this._dirty = true;
//     }
//   }

//   _handleMetadata(op) {
//     const obj = this.objects.get(op.objectId);
//     if (obj && !obj.isDeleted()) {
//       obj.updateProperty(`metadata.${op.property}`, op.value, op.timestamp, op.clientId, new VectorClock(op.vectorClock));
//       this._dirty = true;
//     }
//   }

//   _handleMerge(op) {
//     const { newObjectId, parentObjectIds, objectData } = op;
//     if (!newObjectId || !parentObjectIds?.length) return;
//     this._handleCreate({ ...op, objectId: newObjectId, objectData });
//     for (const parentId of parentObjectIds) {
//       setImmediate(() => recordLineage(newObjectId, parentId, op.operationId ?? generateId('op')).catch(() => {}));
//     }
//   }

//   getSnapshot() {
//     const objects = {};
//     this.objects.forEach((obj, id) => { if (!obj.isDeleted()) objects[id] = obj.toJSON(); });
//     const presence = [];
//     this.clients.forEach((c, clientId) => presence.push({ clientId, ...c.presence }));
//     return {
//       type: MessageType.SNAPSHOT, sceneId: this.sceneId,
//       objects, presence,
//       vectorClock: this.vectorClock.toJSON(),
//       lastSeqNum: this.seqNum, timestamp: Date.now()
//     };
//   }

//   async _flushSnapshot() {
//     if (!this._dirty) return;
//     try {
//       const snap   = this.getSnapshot();
//       const userId = [...this.clients.values()][0]?.userId ?? null;
//       await persistSnapshot(this.sceneId, snap, this.vectorClock.toJSON(), this.seqNum);
//       if (userId) await maybeAutoSnapshot(this.sceneId, this.seqNum, userId, snap, this.vectorClock.toJSON());
//       this._dirty = false;
//     } catch (err) {
//       console.error(`[Room ${this.sceneId}] flush failed:`, err.message);
//     }
//   }

//   _scheduleDirtyFlush() {
//     if (this._flushTimer) return;
//     this._flushTimer = setTimeout(async () => { this._flushTimer = null; await this._flushSnapshot(); }, 5000);
//   }

//   async _persist(op) {
//     try {
//       await persistOperation(this.sceneId, op);
//       if ([OperationType.CREATE, OperationType.TRANSFORM, OperationType.METADATA].includes(op.op)) {
//         const obj = this.objects.get(op.objectId);
//         if (obj && !obj.isDeleted()) await upsertObject(this.sceneId, op.objectId, obj.toJSON(), op.userId);
//       }
//       this._scheduleDirtyFlush();
//     } catch (err) {
//       console.error(`[Room ${this.sceneId}] persist failed:`, err.message);
//     }
//   }

//   updatePresence(clientId, data) {
//     const c = this.clients.get(clientId);
//     if (!c) return;
//     c.presence = { ...c.presence, ...data };
//     this.broadcastToAll({ type: MessageType.PRESENCE, sceneId: this.sceneId, clientId, ...data });
//   }

//   broadcast(msg, excludeId = null) {
//     const payload = JSON.stringify(msg);
//     this.clients.forEach((c, id) => {
//       if (id !== excludeId && c.ws.readyState === 1) c.ws.send(payload);
//     });
//   }

//   broadcastToAll(msg) { this.broadcast(msg, null); }
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // COLLABORATIVE SERVER
// // ─────────────────────────────────────────────────────────────────────────────
// class CollaborativeServer {
//   constructor() {
//     this.rooms       = new Map();
//     this.clientRooms = new Map();
//   }

//   async handleJoin(ws, clientId, sceneId, userId) {
//     let room = this.rooms.get(sceneId);
//     if (!room) {
//       room = new RoomManager(sceneId);
//       await room.hydrateFromDB();
//       this.rooms.set(sceneId, room);
//     }
//     room.addClient(clientId, ws, userId);
//     this.clientRooms.set(clientId, sceneId);
//     ws.send(JSON.stringify(room.getSnapshot()));
//     room.broadcast({ type: 'user_joined', clientId, userId, timestamp: Date.now() }, clientId);
//   }

//   handleOperation(msg, clientId) {
//     this._room(clientId)?.handleOperation(msg, clientId);
//   }

//   handlePresence(msg, clientId) {
//     this._room(clientId)?.updatePresence(clientId, { cursor: msg.cursor, selectedObjects: msg.selectedObjects });
//   }

//   handleDisconnect(clientId) {
//     const room = this._room(clientId);
//     if (!room) return;
//     const empty = room.removeClient(clientId);
//     room.broadcastToAll({ type: 'user_left', clientId, timestamp: Date.now() });
//     if (empty) {
//       const sceneId = this.clientRooms.get(clientId);
//       this.rooms.delete(sceneId);
//     }
//     this.clientRooms.delete(clientId);
//   }

//   _room(clientId) {
//     const sceneId = this.clientRooms.get(clientId);
//     return sceneId ? this.rooms.get(sceneId) : null;
//   }
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // EXPRESS APP
// // ─────────────────────────────────────────────────────────────────────────────
// const app = express();

// // ── Core middleware ───────────────────────────────────────────────────────────
// app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// app.use(compression());
// app.use(cors(corsOptions));
// app.options('/', cors(corsOptions));   // handle pre-flight for ALL routes
// app.use(express.json({ limit: '5mb' }));
// app.use(requestLogger);

// // ── API routes FIRST — must come before static files ─────────────────────────
// // Rate limiter on all /api/* routes
// app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));

// app.use('/api/auth',   authRoutes);
// app.use('/api/scenes', sceneRoutes);
// app.use('/api/models', modelRoutes);

// // Health check
// app.get('/api/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));
// app.get('/health',     (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// // ── 404 for any unmatched /api/* routes ───────────────────────────────────────
// // Must be BEFORE static files so API 404s return JSON, not index.html
// app.use('/api', (req, res) => {
//   res.status(404).json({ error: `${req.method} ${req.path} not found` });
// });

// // ── Static files AFTER API routes ────────────────────────────────────────────
// app.use(express.static(path.join(__dirname, '../client')));

// // SPA fallback — non-API routes serve index.html
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, '../client/index.html'));
// });

// app.use(errorHandler);

// // ─────────────────────────────────────────────────────────────────────────────
// // WEBSOCKET
// // ─────────────────────────────────────────────────────────────────────────────
// const httpServer = createServer(app);
// const wss        = new WebSocketServer({ server: httpServer });
// const collab     = new CollaborativeServer();

// wss.on('connection', (ws, req) => {
//   const { query } = parseUrl(req.url, true);
//   const payload   = verifyWsToken(query.token ?? null);
//   const userId    = payload?.userId ?? null;
//   let   clientId  = null;

//   ws.on('message', async (data) => {
//     let msg;
//     try { msg = JSON.parse(data.toString()); }
//     catch { ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' })); return; }

//     switch (msg.type) {
//       case MessageType.JOIN:
//         clientId = msg.clientId || generateId('user');
//         await collab.handleJoin(ws, clientId, msg.sceneId, userId);
//         break;
//       case MessageType.OPERATION:
//         if (clientId) collab.handleOperation(msg, clientId);
//         break;
//       case MessageType.PRESENCE:
//         if (clientId) collab.handlePresence(msg, clientId);
//         break;
//       case MessageType.PING:
//         ws.send(JSON.stringify({ type: MessageType.PONG, timestamp: msg.timestamp, serverTime: Date.now() }));
//         break;
//     }
//   });

//   ws.on('close', () => { if (clientId) collab.handleDisconnect(clientId); });
//   ws.on('error', (err) => { console.error('WS error:', err.message); if (clientId) collab.handleDisconnect(clientId); });
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // START
// // ─────────────────────────────────────────────────────────────────────────────
// httpServer.listen(PORT, () => {
//   console.log(`\n🚀 Collab3D running`);
//   console.log(`   REST  → http://localhost:${PORT}/api`);
//   console.log(`   WS    → ws://localhost:${PORT}`);
//   console.log(`   CORS  → ${NODE_ENV === 'development' ? 'all origins (dev)' : CORS_ORIGINS.join(', ')}`);
//   console.log(`   Env   → ${NODE_ENV}\n`);
// });

// process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });


// server/server.js

import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { parse as parseUrl } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

import { VectorClock, CRDTObject, OperationType, MessageType, generateId } from './types.js';
import { verifyWsToken } from './auth/authMiddleware.js';
import authRoutes  from './auth/authRoutes.js';
import sceneRoutes from './routes/sceneRoutes.js';
import modelRoutes from './routes/modelRoutes.js';
import { requestLogger, notFound, errorHandler } from './middleware/errorHandler.js';

import {
  persistOperation, persistSnapshot, loadSnapshot,
  upsertObject, softDeleteObject, recordLineage
} from './services/sceneService.js';
import { maybeAutoSnapshot } from './services/versionService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT || '8080');
const NODE_ENV  = process.env.NODE_ENV || 'development';

// ─────────────────────────────────────────────────────────────────────────────
// CORS CONFIG  ← this was the CORS bug: was too restrictive
// ─────────────────────────────────────────────────────────────────────────────
const CORS_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

const corsOptions = {
  origin: (origin, cb) => {
    // Allow same-origin, Postman, curl (no origin header)
    if (!origin) return cb(null, true);
    // Always allow localhost on any port
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    // Allow any private/LAN IP (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if (/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin)) return cb(null, true);
    // Allow explicit allowlist from env
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    // In development allow everything else too
    if (NODE_ENV === 'development') return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─────────────────────────────────────────────────────────────────────────────
// ROOM MANAGER  (CRDT engine — unchanged logic + persistence hooks)
// ─────────────────────────────────────────────────────────────────────────────
class RoomManager {
  constructor(sceneId) {
    this.sceneId      = sceneId;
    this.objects      = new Map();
    this.clients      = new Map();
    this.vectorClock  = new VectorClock();
    this.seqNum       = 0;
    this.operationLog = [];
    this.maxLogSize   = 1000;
    this.undoStacks   = new Map();
    this.redoStacks   = new Map();
    this._dirty       = false;
    this._flushTimer  = null;
  }

  async hydrateFromDB() {
    try {
      const saved = await loadSnapshot(this.sceneId);
      if (!saved?.snapshotJson) return;
      const { objects, vectorClock, lastSeqNum } = saved.snapshotJson;
      if (objects) {
        for (const [id, data] of Object.entries(objects)) {
          this.objects.set(id, CRDTObject.fromJSON(data));
        }
      }
      if (vectorClock) this.vectorClock = VectorClock.fromJSON(vectorClock);
      if (lastSeqNum)  this.seqNum      = lastSeqNum;
      console.log(`[Room ${this.sceneId}] hydrated ${this.objects.size} objects`);
    } catch (err) {
      console.error(`[Room ${this.sceneId}] hydrate failed:`, err.message);
    }
  }

  addClient(clientId, ws, userId = null) {
    this.clients.set(clientId, {
      ws, userId,
      presence: { cursor: null, selectedObjects: [], color: this._color() }
    });
    this.undoStacks.set(clientId, []);
    this.redoStacks.set(clientId, []);
  }

  removeClient(clientId) {
    this.clients.delete(clientId);
    this.undoStacks.delete(clientId);
    this.redoStacks.delete(clientId);
    if (this.clients.size === 0) { this._flushSnapshot(); return true; }
    return false;
  }

  _color() {
    const c = ['#FF6B6B','#4ECDC4','#45B7D1','#FFA07A','#98D8C8','#F7DC6F','#BB8FCE','#85C1E2'];
    return c[Math.floor(Math.random() * c.length)];
  }

  async handleOperation(operation, clientId) {
    this.seqNum++;
    operation.seqNum          = this.seqNum;
    operation.serverTimestamp = Date.now();

    this.vectorClock.increment(clientId);
    this.vectorClock = this.vectorClock.merge(new VectorClock(operation.vectorClock || {}));

    try {
      switch (operation.op) {
        case OperationType.CREATE:    this._handleCreate(operation);    break;
        case OperationType.DELETE:    this._handleDelete(operation);    break;
        case OperationType.TRANSFORM: this._handleTransform(operation); break;
        case OperationType.METADATA:  this._handleMetadata(operation);  break;
        case OperationType.MERGE:     this._handleMerge(operation);     break;
      }

      this.operationLog.push(operation);
      if (this.operationLog.length > this.maxLogSize) this.operationLog.shift();

      this.broadcast(operation, clientId);

      const userId = this.clients.get(clientId)?.userId;
      setImmediate(() => this._persist({ ...operation, userId }));

      return { success: true, operation };
    } catch (err) {
      console.error(`[Room ${this.sceneId}] op error:`, err);
      return { success: false, error: err.message };
    }
  }

  _handleCreate(op) {
    const obj = new CRDTObject(op.objectId, op.objectData.type, op.objectData.geometry);
    const vc  = new VectorClock(op.vectorClock);
    const { position, rotation, scale } = op.objectData.transform || {};
    if (position) obj.transform.position.set(position.value, op.timestamp, op.clientId, vc);
    if (rotation) obj.transform.rotation.set(rotation.value, op.timestamp, op.clientId, vc);
    if (scale)    obj.transform.scale.set(scale.value,       op.timestamp, op.clientId, vc);
    if (op.objectData.metadata) {
      for (const [k, d] of Object.entries(op.objectData.metadata)) {
        if (obj.metadata[k]) obj.metadata[k].set(d.value, op.timestamp, op.clientId, vc);
      }
    }
    obj.createdBy = op.clientId;
    this.objects.set(op.objectId, obj);
    this._dirty = true;
  }

  _handleDelete(op) {
    const obj = this.objects.get(op.objectId);
    if (obj) {
      obj.delete(op.timestamp, op.clientId, new VectorClock(op.vectorClock));
      this._dirty = true;
      setImmediate(() => softDeleteObject(op.objectId).catch(() => {}));
    }
  }

  _handleTransform(op) {
    const obj = this.objects.get(op.objectId);
    if (obj && !obj.isDeleted()) {
      obj.updateProperty(`transform.${op.property}`, op.value, op.timestamp, op.clientId, new VectorClock(op.vectorClock));
      this._dirty = true;
    }
  }

  _handleMetadata(op) {
    const obj = this.objects.get(op.objectId);
    if (obj && !obj.isDeleted()) {
      obj.updateProperty(`metadata.${op.property}`, op.value, op.timestamp, op.clientId, new VectorClock(op.vectorClock));
      this._dirty = true;
    }
  }

  _handleMerge(op) {
    const { newObjectId, parentObjectIds, objectData } = op;
    if (!newObjectId || !parentObjectIds?.length) return;
    this._handleCreate({ ...op, objectId: newObjectId, objectData });
    for (const parentId of parentObjectIds) {
      setImmediate(() => recordLineage(newObjectId, parentId, op.operationId ?? generateId('op')).catch(() => {}));
    }
  }

  getSnapshot() {
    const objects = {};
    this.objects.forEach((obj, id) => { if (!obj.isDeleted()) objects[id] = obj.toJSON(); });
    const presence = [];
    this.clients.forEach((c, clientId) => presence.push({ clientId, ...c.presence }));
    return {
      type: MessageType.SNAPSHOT, sceneId: this.sceneId,
      objects, presence,
      vectorClock: this.vectorClock.toJSON(),
      lastSeqNum: this.seqNum, timestamp: Date.now()
    };
  }

  async _flushSnapshot() {
    if (!this._dirty) return;
    try {
      const snap   = this.getSnapshot();
      const userId = [...this.clients.values()][0]?.userId ?? null;
      await persistSnapshot(this.sceneId, snap, this.vectorClock.toJSON(), this.seqNum);
      if (userId) await maybeAutoSnapshot(this.sceneId, this.seqNum, userId, snap, this.vectorClock.toJSON());
      this._dirty = false;
    } catch (err) {
      console.error(`[Room ${this.sceneId}] flush failed:`, err.message);
    }
  }

  _scheduleDirtyFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(async () => { this._flushTimer = null; await this._flushSnapshot(); }, 5000);
  }

  async _persist(op) {
    try {
      await persistOperation(this.sceneId, op);
      if ([OperationType.CREATE, OperationType.TRANSFORM, OperationType.METADATA].includes(op.op)) {
        const obj = this.objects.get(op.objectId);
        if (obj && !obj.isDeleted()) await upsertObject(this.sceneId, op.objectId, obj.toJSON(), op.userId);
      }
      this._scheduleDirtyFlush();
    } catch (err) {
      console.error(`[Room ${this.sceneId}] persist failed:`, err.message);
    }
  }

  updatePresence(clientId, data) {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.presence = { ...c.presence, ...data };
    this.broadcastToAll({ type: MessageType.PRESENCE, sceneId: this.sceneId, clientId, ...data });
  }

  broadcast(msg, excludeId = null) {
    const payload = JSON.stringify(msg);
    this.clients.forEach((c, id) => {
      if (id !== excludeId && c.ws.readyState === 1) c.ws.send(payload);
    });
  }

  broadcastToAll(msg) { this.broadcast(msg, null); }
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLABORATIVE SERVER
// ─────────────────────────────────────────────────────────────────────────────
class CollaborativeServer {
  constructor() {
    this.rooms       = new Map();
    this.clientRooms = new Map();
  }

  async handleJoin(ws, clientId, sceneId, userId) {
    let room = this.rooms.get(sceneId);
    if (!room) {
      room = new RoomManager(sceneId);
      await room.hydrateFromDB();
      this.rooms.set(sceneId, room);
    }
    room.addClient(clientId, ws, userId);
    this.clientRooms.set(clientId, sceneId);
    ws.send(JSON.stringify(room.getSnapshot()));
    room.broadcast({ type: 'user_joined', clientId, userId, timestamp: Date.now() }, clientId);
  }

  handleOperation(msg, clientId) {
    this._room(clientId)?.handleOperation(msg, clientId);
  }

  handlePresence(msg, clientId) {
    this._room(clientId)?.updatePresence(clientId, { cursor: msg.cursor, selectedObjects: msg.selectedObjects });
  }

  handleDisconnect(clientId) {
    const room = this._room(clientId);
    if (!room) return;
    const empty = room.removeClient(clientId);
    room.broadcastToAll({ type: 'user_left', clientId, timestamp: Date.now() });
    if (empty) {
      const sceneId = this.clientRooms.get(clientId);
      this.rooms.delete(sceneId);
    }
    this.clientRooms.delete(clientId);
  }

  _room(clientId) {
    const sceneId = this.clientRooms.get(clientId);
    return sceneId ? this.rooms.get(sceneId) : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors(corsOptions));
app.options('/', cors(corsOptions));   // handle pre-flight for ALL routes
app.use(express.json({ limit: '5mb' }));
app.use(requestLogger);

// ── API routes FIRST — must come before static files ─────────────────────────
// Rate limiter on all /api/* routes
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));

app.use('/api/auth',   authRoutes);
app.use('/api/scenes', sceneRoutes);
app.use('/api/models', modelRoutes);

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/health',     (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── 404 for any unmatched /api/* routes ───────────────────────────────────────
// Must be BEFORE static files so API 404s return JSON, not index.html
app.use('/api', (req, res) => {
  res.status(404).json({ error: `${req.method} ${req.path} not found` });
});

// ── Static files AFTER API routes ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client')));

// SPA fallback — non-API routes serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });
const collab     = new CollaborativeServer();

wss.on('connection', (ws, req) => {
  const { query } = parseUrl(req.url, true);
  const payload   = verifyWsToken(query.token ?? null);
  const userId    = payload?.userId ?? null;
  let   clientId  = null;

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' })); return; }

    switch (msg.type) {
      case MessageType.JOIN:
        clientId = msg.clientId || generateId('user');
        await collab.handleJoin(ws, clientId, msg.sceneId, userId);
        break;
      case MessageType.OPERATION:
        if (clientId) collab.handleOperation(msg, clientId);
        break;
      case MessageType.PRESENCE:
        if (clientId) collab.handlePresence(msg, clientId);
        break;
      case MessageType.PING:
        ws.send(JSON.stringify({ type: MessageType.PONG, timestamp: msg.timestamp, serverTime: Date.now() }));
        break;
    }
  });

  ws.on('close', () => { if (clientId) collab.handleDisconnect(clientId); });
  ws.on('error', (err) => { console.error('WS error:', err.message); if (clientId) collab.handleDisconnect(clientId); });
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Collab3D running`);
  console.log(`   REST  → http://localhost:${PORT}/api`);
  console.log(`   WS    → ws://localhost:${PORT}`);
  console.log(`   CORS  → ${NODE_ENV === 'development' ? 'all origins (dev)' : CORS_ORIGINS.join(', ')}`);
  console.log(`   Env   → ${NODE_ENV}\n`);
});

process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });
