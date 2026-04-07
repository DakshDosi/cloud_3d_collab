import express from "express";
import { requireAuth } from "../auth/authMiddleware.js";

import * as sceneService from "../services/sceneService.js";
import * as versionService from "../services/versionService.js";
import * as storageService from "../services/storageService.js";

const router = express.Router();

/* ---------------- CREATE SCENE ---------------- */

router.post("/", requireAuth, async (req, res) => {
  try {
    const scene = await sceneService.createScene(
      req.user.userId || req.user.id,
      { name: req.body.name || "Untitled Scene" }
    );

    res.json(scene);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- ENSURE SCENE ---------------- */

router.post("/ensure", requireAuth, async (req, res) => {
  try {
    const { sceneId, name, snapshot } = req.body;
    let scene = await sceneService.getScene(sceneId);
    if (!scene) {
      scene = await sceneService.createSceneWithId(sceneId, req.user.userId || req.user.id, { name: name || sceneId, description: "" });
    }
    if (snapshot) {
      await sceneService.persistSnapshot(sceneId, snapshot, snapshot.vectorClock || {}, 0);
    }
    res.json(scene);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- GET SCENE ---------------- */

router.get("/:id", async (req, res) => {
  try {
    const scene = await sceneService.getScene(req.params.id);

    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }

    res.json(scene);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- SAVE VERSION ---------------- */

router.post("/:id/save", requireAuth, async (req, res) => {
  try {
    const version = await versionService.saveVersion(
      req.params.id,
      req.body.snapshot,
      req.user.id
    );

    res.json(version);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- GET VERSION HISTORY ---------------- */

router.get("/:id/history", async (req, res) => {
  try {
    const versions = await versionService.getHistory(req.params.id);

    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- RESTORE VERSION ---------------- */

router.post("/:sceneId/restore/:versionId", requireAuth, async (req, res) => {
  try {
    const snapshot = await versionService.restoreVersion(
      req.params.versionId
    );

    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- EXPORT SCENE ---------------- */

router.post("/:id/export", requireAuth, async (req, res) => {
  try {
    const format = req.body.format || "json";
    const scene = await sceneService.getScene(req.params.id);

    const file = await storageService.saveExport(
      req.params.id,
      format,
      scene
    );

    res.json({ url: `/${file}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- PUBLISH MODEL ---------------- */

router.post("/:id/publish", requireAuth, async (req, res) => {
  try {
    const model = await sceneService.publishScene(
      req.params.id,
      req.user.id,
      req.body
    );

    res.json(model);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;