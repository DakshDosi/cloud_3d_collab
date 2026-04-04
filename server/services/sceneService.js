// import prisma from "../db/client.js";

// export async function createScene(ownerId, name) {
//   return prisma.scene.create({
//     data: {
//       ownerId,
//       name
//     }
//   });
// }

// export async function getScene(sceneId) {
//   return prisma.scene.findUnique({
//     where: { id: sceneId },
//     include: {
//       objects: true
//     }
//   });
// }

// export async function saveSnapshot(sceneId, snapshot) {
//   return prisma.sceneVersion.create({
//     data: {
//       sceneId,
//       snapshot
//     }
//   });
// }

// server/services/sceneService.js
// Persists CRDT operations and snapshots to PostgreSQL.
// The RoomManager calls these methods; the real-time engine is unaffected.

import prisma from '../db/client.js';

// ── Create scene ──────────────────────────────────────────────────────────────
export async function createScene(ownerId, { name, description, isPublic = false }) {
  const scene = await prisma.scene.create({
    data: {
      name,
      description: description ?? null,
      ownerId,
      isPublic,
      permissions: {
        create: { userId: ownerId, role: 'OWNER' }
      }
    },
    include: { owner: { select: { id: true, username: true } } }
  });
  return scene;
}

// ── Get scene by id ───────────────────────────────────────────────────────────
export async function getScene(sceneId) {
  return prisma.scene.findUnique({
    where: { id: sceneId },
    include: {
      owner:       { select: { id: true, username: true, avatarUrl: true } },
      permissions: { include: { user: { select: { id: true, username: true, avatarUrl: true } } } }
    }
  });
}

// ── List scenes for a user (owned + shared) ───────────────────────────────────
export async function listUserScenes(userId, { limit = 20, offset = 0 } = {}) {
  const where = {
    OR: [
      { ownerId: userId },
      { permissions: { some: { userId } } }
    ]
  };
  const [scenes, total] = await Promise.all([
    prisma.scene.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit,
      include: { owner: { select: { id: true, username: true } } }
    }),
    prisma.scene.count({ where })
  ]);
  return { scenes, total };
}

// ── Update scene snapshot (persists full CRDT state) ─────────────────────────
export async function persistSnapshot(sceneId, snapshotJson, vectorClock, lastSeqNum) {
  await prisma.scene.update({
    where: { id: sceneId },
    data: { snapshotJson, vectorClock, lastSeqNum, updatedAt: new Date() }
  });
}

// ── Upsert a single SceneObject row ──────────────────────────────────────────
export async function upsertObject(sceneId, objectId, stateJson, createdBy = null) {
  await prisma.sceneObject.upsert({
    where: { id: objectId },
    update: { stateJson, updatedAt: new Date() },
    create: {
      id: objectId,
      sceneId,
      type:     stateJson.type ?? 'mesh',
      geometry: stateJson.geometry ?? 'box',
      stateJson,
      createdBy
    }
  });
}

// ── Soft-delete a SceneObject ─────────────────────────────────────────────────
export async function softDeleteObject(objectId) {
  await prisma.sceneObject.update({
    where: { id: objectId },
    data: { deletedAt: new Date() }
  });
}

// ── Persist an operation to the operations log ────────────────────────────────
export async function persistOperation(sceneId, operation) {
  const { clientId, userId, op, objectId, vectorClock, timestamp, seqNum } = operation;

  await prisma.operation.create({
    data: {
      sceneId,
      clientId:    clientId ?? 'unknown',
      userId:      userId ?? null,
      op,
      objectId:    objectId ?? null,
      payloadJson: operation,
      vectorClock: vectorClock ?? {},
      timestamp:   BigInt(timestamp ?? Date.now()),
      seqNum:      seqNum ?? 0
    }
  });
}

// ── Load snapshot from DB (used when room is cold-started) ────────────────────
export async function loadSnapshot(sceneId) {
  const scene = await prisma.scene.findUnique({
    where: { id: sceneId },
    select: { snapshotJson: true, vectorClock: true, lastSeqNum: true }
  });
  return scene;
}

// ── Get operations after seqNum (for replay) ──────────────────────────────────
export async function getOperationsSince(sceneId, fromSeqNum) {
  return prisma.operation.findMany({
    where: { sceneId, seqNum: { gt: fromSeqNum } },
    orderBy: { seqNum: 'asc' }
  });
}

// ── Add lineage record ────────────────────────────────────────────────────────
export async function recordLineage(objectId, parentObjectId, operationId) {
  try {
    await prisma.objectLineage.create({
      data: { objectId, parentObjectId, operationId }
    });
  } catch (err) {
    // Lineage is informational; don't crash the request
    console.error('[SceneService] lineage insert failed:', err.message);
  }
}

// ── Get full lineage tree for an object ──────────────────────────────────────
export async function getObjectLineage(objectId, depth = 5) {
  const visited = new Set();
  const result  = [];

  async function traverse(id, currentDepth) {
    if (currentDepth <= 0 || visited.has(id)) return;
    visited.add(id);

    const parents = await prisma.objectLineage.findMany({
      where: { objectId: id },
      include: { parentObject: { select: { id: true, geometry: true, createdAt: true } } }
    });

    for (const link of parents) {
      result.push({
        childId:  id,
        parentId: link.parentObjectId,
        parent:   link.parentObject
      });
      await traverse(link.parentObjectId, currentDepth - 1);
    }
  }

  await traverse(objectId, depth);
  return result;
}

// ── Permission management ─────────────────────────────────────────────────────
export async function setPermission(sceneId, userId, role) {
  return prisma.scenePermission.upsert({
    where:  { sceneId_userId: { sceneId, userId } },
    update: { role },
    create: { sceneId, userId, role }
  });
}

export async function removePermission(sceneId, userId) {
  return prisma.scenePermission.delete({
    where: { sceneId_userId: { sceneId, userId } }
  });
}

export async function checkPermission(sceneId, userId) {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId }, select: { ownerId: true, isPublic: true } });
  if (!scene) return null;
  if (scene.ownerId === userId) return 'OWNER';

  const perm = await prisma.scenePermission.findUnique({
    where: { sceneId_userId: { sceneId, userId } }
  });
  if (perm) return perm.role;
  if (scene.isPublic) return 'VIEWER';
  return null;
}