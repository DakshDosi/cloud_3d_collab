// server/services/modelService.js
// Model Library — publish, browse, like, download, import

import prisma from '../db/client.js';
import { getScene } from './sceneService.js';

// ── Publish a scene as a model ────────────────────────────────────────────────
export async function publishModel(sceneId, userId, { title, description, tags = [], thumbnailUrl } = {}) {
  const scene = await getScene(sceneId);
  if (!scene) throw new Error('Scene not found');
  if (scene.ownerId !== userId) throw new Error('Only the scene owner can publish');

  const model = await prisma.model.upsert({
    where:  { sceneId },
    update: { title, description: description ?? null, tags, thumbnailUrl: thumbnailUrl ?? null, visibility: 'PUBLIC' },
    create: {
      sceneId,
      ownerId:     userId,
      title,
      description: description ?? null,
      tags,
      thumbnailUrl: thumbnailUrl ?? null,
      visibility:   'PUBLIC'
    },
    include: { owner: { select: { id: true, username: true, avatarUrl: true } } }
  });

  return model;
}

// ── Unpublish / set to private ────────────────────────────────────────────────
export async function unpublishModel(modelId, userId) {
  const model = await prisma.model.findUnique({ where: { id: modelId } });
  if (!model) throw new Error('Model not found');
  if (model.ownerId !== userId) throw new Error('Unauthorized');

  return prisma.model.update({
    where: { id: modelId },
    data:  { visibility: 'PRIVATE' }
  });
}

// ── Browse public models ──────────────────────────────────────────────────────
export async function listPublicModels({ limit = 24, offset = 0, search, tag, sortBy = 'createdAt' } = {}) {
  const where = { visibility: 'PUBLIC' };

  if (search) {
    where.OR = [
      { title:       { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }
  if (tag) {
    where.tags = { has: tag };
  }

  const orderBy = {};
  if (sortBy === 'likes')     orderBy.likeCount     = 'desc';
  else if (sortBy === 'downloads') orderBy.downloadCount = 'desc';
  else                        orderBy.createdAt      = 'desc';

  const [models, total] = await Promise.all([
    prisma.model.findMany({
      where,
      orderBy,
      skip: offset,
      take: limit,
      include: { owner: { select: { id: true, username: true, avatarUrl: true } } }
    }),
    prisma.model.count({ where })
  ]);

  return { models, total };
}

// ── Get single model ──────────────────────────────────────────────────────────
export async function getModel(modelId) {
  return prisma.model.findUnique({
    where: { id: modelId },
    include: {
      owner: { select: { id: true, username: true, avatarUrl: true } },
      scene: { select: { id: true, snapshotJson: true, vectorClock: true } }
    }
  });
}

// ── Like / unlike a model ─────────────────────────────────────────────────────
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

// ── Record a download ─────────────────────────────────────────────────────────
export async function recordDownload(modelId, userId) {
  await prisma.modelDownload.create({ data: { modelId, userId } });
  await prisma.model.update({ where: { id: modelId }, data: { downloadCount: { increment: 1 } } });
}

// ── Import a model into a target scene ───────────────────────────────────────
// Returns the source model's snapshot so the client can merge objects into
// the active CRDT scene.
export async function importModelSnapshot(modelId) {
  const model = await prisma.model.findUnique({
    where: { id: modelId },
    include: { scene: { select: { snapshotJson: true } } }
  });
  if (!model) throw new Error('Model not found');
  if (model.visibility !== 'PUBLIC') throw new Error('Model is not public');

  return {
    modelId:  model.id,
    title:    model.title,
    snapshot: model.scene.snapshotJson
  };
}

// ── Get likes status for requesting user ─────────────────────────────────────
export async function getLikeStatus(modelId, userId) {
  if (!userId) return false;
  const like = await prisma.modelLike.findUnique({
    where: { userId_modelId: { userId, modelId } }
  });
  return !!like;
}
