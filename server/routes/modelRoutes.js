// import express from "express";
// import { requireAuth } from "../auth/authMiddleware.js";
// import * as modelService from "../services/modelService.js";

// const router = express.Router();

// router.get("/", async (req, res) => {
//   const models = await modelService.listModels(req.query);
//   res.json(models);
// });

// router.get("/:id", async (req, res) => {
//   const model = await modelService.getModel(req.params.id);
//   res.json(model);
// });

// router.post("/", requireAuth, async (req, res) => {
//   const model = await modelService.publishModel(req.user.id, req.body);
//   res.json(model);
// });

// router.post("/:id/like", requireAuth, async (req, res) => {
//   const result = await modelService.toggleLike(req.user.id, req.params.id);
//   res.json(result);
// });

// router.post("/:id/download", requireAuth, async (req, res) => {
//   const result = await modelService.downloadModel(req.params.id);
//   res.json(result);
// });

// export default router;

// server/routes/modelRoutes.js

import { Router } from 'express';
import { requireAuth, optionalAuth } from '../auth/authMiddleware.js';
import prisma from '../db/client.js';
import {
  listPublicModels, getModel, publishModel, unpublishModel,
  toggleLike, recordDownload, importModelSnapshot, getLikeStatus
} from '../services/modelService.js';

const router = Router();

// GET /models — browse public library
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { limit = 24, offset = 0, search, tag, sort } = req.query;
    const result = await listPublicModels({
      limit: parseInt(limit), offset: parseInt(offset),
      search, tag, sortBy: sort
    });

    // Attach _liked status for the requesting user
    if (req.user?.userId && result.models.length) {
      const userId = req.user.userId;
      const modelIds = result.models.map(m => m.id);
      const likes = await prisma.modelLike.findMany({
        where: { userId, modelId: { in: modelIds } },
        select: { modelId: true }
      });
      const likedSet = new Set(likes.map(l => l.modelId));
      result.models = result.models.map(m => ({ ...m, _liked: likedSet.has(m.id) }));
    } else {
      result.models = result.models.map(m => ({ ...m, _liked: false }));
    }

    res.json(result);
  } catch (err) { next(err); }
});

// GET /models/:id — single model detail
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const model = await getModel(req.params.id);
    if (!model || (!model.isPublic && model.ownerId !== req.user?.userId)) {
      return res.status(404).json({ error: 'Model not found' });
    }
    const liked = await getLikeStatus(req.params.id, req.user?.userId);
    res.json({ model, liked });
  } catch (err) { next(err); }
});

// POST /models — publish scene as model
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { sceneId, title, description, tags, thumbnailUrl } = req.body;
    if (!sceneId || !title) {
      return res.status(400).json({ error: 'sceneId and title are required' });
    }
    const model = await publishModel(sceneId, req.user.userId, { title, description, tags, thumbnailUrl });
    res.status(201).json({ model });
  } catch (err) {
    if (err.message.includes('Unauthorized') || err.message.includes('owner')) {
      return res.status(403).json({ error: err.message });
    }
    next(err);
  }
});

// DELETE /models/:id — unpublish
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await unpublishModel(req.params.id, req.user.userId);
    res.json({ message: 'Model unpublished' });
  } catch (err) {
    if (err.message === 'Unauthorized') return res.status(403).json({ error: err.message });
    next(err);
  }
});

// POST /models/:id/like — toggle like
router.post('/:id/like', requireAuth, async (req, res, next) => {
  try {
    const result = await toggleLike(req.params.id, req.user.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /models/:id/download — record download + return snapshot
router.post('/:id/download', requireAuth, async (req, res, next) => {
  try {
    await recordDownload(req.params.id, req.user.userId);
    const data = await importModelSnapshot(req.params.id);
    res.json(data);
  } catch (err) {
    if (err.message.includes('public')) return res.status(403).json({ error: err.message });
    next(err);
  }
});

export default router;