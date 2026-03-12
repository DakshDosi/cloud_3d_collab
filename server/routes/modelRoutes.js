import express from "express";
import { requireAuth } from "../auth/authMiddleware.js";
import * as modelService from "../services/modelService.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const models = await modelService.listModels(req.query);
  res.json(models);
});

router.get("/:id", async (req, res) => {
  const model = await modelService.getModel(req.params.id);
  res.json(model);
});

router.post("/", requireAuth, async (req, res) => {
  const model = await modelService.publishModel(req.user.id, req.body);
  res.json(model);
});

router.post("/:id/like", requireAuth, async (req, res) => {
  const result = await modelService.toggleLike(req.user.id, req.params.id);
  res.json(result);
});

router.post("/:id/download", requireAuth, async (req, res) => {
  const result = await modelService.downloadModel(req.params.id);
  res.json(result);
});

export default router;