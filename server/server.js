import express from "express";
import http from "http";
import cors from "cors";
import "dotenv/config";
import { WebSocketServer } from "ws";
import authRoutes from "./auth/authRoutes.js";
import modelRoutes from "./routes/modelRoutes.js";
import sceneRoutes from "./routes/sceneRoutes.js";

import { requestLogger, errorHandler } from "./middleware/errorHandler.js";

const PORT = process.env.PORT || 8080;


const app = express();
app.use(cors({
  origin: "http://localhost:3000"
}));
app.use(express.json());
app.use(requestLogger);

/* ---------------- REST API ---------------- */

app.use("/api/auth", authRoutes);
app.use("/api/models", modelRoutes);
app.use("/api/scenes", sceneRoutes);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ---------------- HTTP SERVER ---------------- */

const server = http.createServer(app);

/* ---------------- WEBSOCKET ---------------- */

const wss = new WebSocketServer({ server });

const rooms = new Map();

wss.on("connection", (ws) => {
  let currentRoom = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "join") {
        currentRoom = data.sceneId;

        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, new Set());
        }

        rooms.get(currentRoom).add(ws);
      }

      if (data.type === "operation" && currentRoom) {
        const clients = rooms.get(currentRoom);

        for (const client of clients) {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(data));
          }
        }
      }
    } catch (err) {
      console.error("WS error:", err);
    }
  });

  ws.on("close", () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
    }
  });
});

/* ---------------- ERROR HANDLER ---------------- */

app.use(errorHandler);

/* ---------------- START ---------------- */

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});