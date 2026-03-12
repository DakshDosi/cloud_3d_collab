// server/services/versionService.js
// Git-style version history for scenes.
// Versions are saved every N operations or on manual trigger.

import prisma from '../db/client.js';

const AUTO_SNAPSHOT_INTERVAL = parseInt(process.env.AUTO_SNAPSHOT_INTERVAL || '50');

// ── Save a version checkpoint ─────────────────────────────────────────────────
export async function saveVersion(sceneId, userId, snapshotJson, vectorClock, seqNum, options = {}) {
  const { label, branchName = 'main' } = options;

  // Find parent version (latest on this branch)
  const parent = await prisma.sceneVersion.findFirst({
    where: { sceneId, branchName },
    orderBy: { createdAt: 'desc' }
  });

  const version = await prisma.sceneVersion.create({
    data: {
      sceneId,
      parentVersionId: parent?.id ?? null,
      branchName,
      label: label ?? null,
      snapshotJson,
      vectorClock,
      seqNumAt: seqNum,
      createdBy: userId
    },
    include: { createdByUser: { select: { id: true, username: true, avatarUrl: true } } }
  });

  return version;
}

// ── List versions for a scene ─────────────────────────────────────────────────
export async function listVersions(sceneId, options = {}) {
  const { branchName, limit = 50, offset = 0 } = options;

  const where = { sceneId };
  if (branchName) where.branchName = branchName;

  const [versions, total] = await Promise.all([
    prisma.sceneVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      include: { createdByUser: { select: { id: true, username: true, avatarUrl: true } } }
    }),
    prisma.sceneVersion.count({ where })
  ]);

  return { versions, total };
}

// ── Get a single version ──────────────────────────────────────────────────────
export async function getVersion(versionId) {
  return prisma.sceneVersion.findUnique({
    where: { id: versionId },
    include: { createdByUser: { select: { id: true, username: true, avatarUrl: true } } }
  });
}

// ── Restore scene to a version ────────────────────────────────────────────────
export async function restoreVersion(sceneId, versionId, userId) {
  const version = await prisma.sceneVersion.findUnique({ where: { id: versionId } });

  if (!version || version.sceneId !== sceneId) {
    throw new Error('Version not found or does not belong to this scene');
  }

  // Save a "before restore" version first
  const currentScene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (currentScene?.snapshotJson) {
    await saveVersion(
      sceneId,
      userId,
      currentScene.snapshotJson,
      currentScene.vectorClock,
      currentScene.lastSeqNum,
      { label: `Auto-save before restore to v${version.seqNumAt}` }
    );
  }

  // Apply the restored snapshot to the scene
  await prisma.scene.update({
    where: { id: sceneId },
    data: {
      snapshotJson: version.snapshotJson,
      vectorClock:  version.vectorClock,
      lastSeqNum:   version.seqNumAt
    }
  });

  return version;
}

// ── Branch from a version ─────────────────────────────────────────────────────
export async function createBranch(sceneId, sourceVersionId, newBranchName, userId) {
  const source = await prisma.sceneVersion.findUnique({ where: { id: sourceVersionId } });
  if (!source) throw new Error('Source version not found');

  return prisma.sceneVersion.create({
    data: {
      sceneId,
      parentVersionId: sourceVersionId,
      branchName: newBranchName,
      label: `Branched from ${source.branchName}@${source.seqNumAt}`,
      snapshotJson: source.snapshotJson,
      vectorClock:  source.vectorClock,
      seqNumAt:     source.seqNumAt,
      createdBy:    userId
    }
  });
}

// ── Diff two versions ─────────────────────────────────────────────────────────
export async function diffVersions(versionIdA, versionIdB) {
  const [vA, vB] = await Promise.all([
    prisma.sceneVersion.findUnique({ where: { id: versionIdA } }),
    prisma.sceneVersion.findUnique({ where: { id: versionIdB } })
  ]);

  if (!vA || !vB) throw new Error('One or both versions not found');

  const objectsA = vA.snapshotJson?.objects ?? {};
  const objectsB = vB.snapshotJson?.objects ?? {};

  const keysA = new Set(Object.keys(objectsA));
  const keysB = new Set(Object.keys(objectsB));

  const added    = [...keysB].filter(k => !keysA.has(k));
  const removed  = [...keysA].filter(k => !keysB.has(k));
  const modified = [];

  for (const key of keysA) {
    if (keysB.has(key)) {
      const a = objectsA[key];
      const b = objectsB[key];

      const changes = {};
      // Compare position
      const posA = a.transform?.position?.value;
      const posB = b.transform?.position?.value;
      if (JSON.stringify(posA) !== JSON.stringify(posB)) {
        changes.position = { from: posA, to: posB };
      }
      // Compare color
      const colA = a.metadata?.color?.value;
      const colB = b.metadata?.color?.value;
      if (colA !== colB) {
        changes.color = { from: colA, to: colB };
      }

      if (Object.keys(changes).length > 0) {
        modified.push({ objectId: key, changes });
      }
    }
  }

  return {
    versionA: { id: vA.id, seqNumAt: vA.seqNumAt, createdAt: vA.createdAt, branchName: vA.branchName },
    versionB: { id: vB.id, seqNumAt: vB.seqNumAt, createdAt: vB.createdAt, branchName: vB.branchName },
    summary: {
      addedCount:    added.length,
      removedCount:  removed.length,
      modifiedCount: modified.length,
    },
    added,
    removed,
    modified
  };
}

// ── Auto-snapshot trigger — called from RoomManager ──────────────────────────
export async function maybeAutoSnapshot(sceneId, seqNum, userId, snapshotJson, vectorClock) {
  if (seqNum % AUTO_SNAPSHOT_INTERVAL === 0) {
    await saveVersion(sceneId, userId, snapshotJson, vectorClock, seqNum, {
      label: `Auto-save at operation ${seqNum}`
    }).catch(err => console.error('[VersionService] auto-snapshot failed:', err));
  }
}
