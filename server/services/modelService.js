// server/services/modelService.js

import prisma from '../db/client.js';
import { getScene } from './sceneService.js';

// ── Publish a scene as a model ────────────────────────────────────────────────
export async function publishModel(sceneId, userId, { title, description, tags = [], thumbnailUrl } = {}) {
  const scene = await getScene(sceneId);
  if (!scene) throw new Error('Scene not found');
  if (scene.ownerId !== userId) throw new Error('Only the scene owner can publish');

  const model = await prisma.model.upsert({
    where:  { sceneId },
    update: { title, description: description ?? null, tags, thumbnailUrl: thumbnailUrl ?? null, isPublic: true },
    create: {
      sceneId,
      ownerId:      userId,
      title,
      description:  description ?? null,
      tags,
      thumbnailUrl: thumbnailUrl ?? null,
      isPublic:     true,
    },
    include: { owner: { select: { id: true, username: true, avatarUrl: true } } }
  });

  return model;
}

// ── Unpublish ─────────────────────────────────────────────────────────────────
export async function unpublishModel(modelId, userId) {
  const model = await prisma.model.findUnique({ where: { id: modelId } });
  if (!model) throw new Error('Model not found');
  if (model.ownerId !== userId) throw new Error('Unauthorized');
  return prisma.model.update({ where: { id: modelId }, data: { isPublic: false } });
}

// ── Browse public models ──────────────────────────────────────────────────────
export async function listPublicModels({ limit = 24, offset = 0, search, tag, sortBy = 'createdAt' } = {}) {
  const where = { isPublic: true };

  if (search) {
    where.OR = [
      { title:       { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (tag) where.tags = { has: tag };

  const orderBy = sortBy === 'likes'     ? { likeCount: 'desc' }
                : sortBy === 'downloads' ? { downloadCount: 'desc' }
                : { createdAt: 'desc' };

  const [models, total] = await Promise.all([
    prisma.model.findMany({
      where,
      orderBy,
      skip:    Number(offset),   // ← must be Number, not string
      take:    Number(limit),    // ← must be Number, not string
      include: { owner: { select: { id: true, username: true, avatarUrl: true } } }
    }),
    prisma.model.count({ where })
  ]);

  return { models, total };
}

// ── Get single model ──────────────────────────────────────────────────────────
export async function getModel(modelId) {
  return prisma.model.findUnique({
    where:   { id: modelId },
    include: {
      owner: { select: { id: true, username: true, avatarUrl: true } },
      scene: { select: { id: true, snapshotJson: true, vectorClock: true } }
    }
  });
}

// ── Like / unlike ─────────────────────────────────────────────────────────────
export async function toggleLike(modelId, userId) {
  const existing = await prisma.modelLike.findUnique({
    where: { userId_modelId: { userId, modelId } }
  });
  if (existing) {
    await prisma.modelLike.delete({ where: { userId_modelId: { userId, modelId } } });
    await prisma.model.update({ where: { id: modelId }, data: { likeCount: { decrement: 1 } } });
    return { liked: false };
  } else {
    await prisma.modelLike.create({ data: { userId, modelId } });
    await prisma.model.update({ where: { id: modelId }, data: { likeCount: { increment: 1 } } });
    return { liked: true };
  }
}

// ── Record download ───────────────────────────────────────────────────────────
export async function recordDownload(modelId, userId) {
  await prisma.modelDownload.create({ data: { modelId, userId } });
  await prisma.model.update({ where: { id: modelId }, data: { downloadCount: { increment: 1 } } });
}

// ── Import snapshot ───────────────────────────────────────────────────────────
export async function importModelSnapshot(modelId) {
  const model = await prisma.model.findUnique({
    where:   { id: modelId },
    include: { scene: { select: { snapshotJson: true } } }
  });
  if (!model) throw new Error('Model not found');
  if (!model.isPublic) throw new Error('Model is not public');
  return { modelId: model.id, title: model.title, snapshot: model.scene.snapshotJson };
}

// ── Like status ───────────────────────────────────────────────────────────────
export async function getLikeStatus(modelId, userId) {
  if (!userId) return false;
  const like = await prisma.modelLike.findUnique({
    where: { userId_modelId: { userId, modelId } }
  });
  return !!like;
}