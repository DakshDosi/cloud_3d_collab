import prisma from "../db/client.js";

export async function createScene(ownerId, name) {
  return prisma.scene.create({
    data: {
      ownerId,
      name
    }
  });
}

export async function getScene(sceneId) {
  return prisma.scene.findUnique({
    where: { id: sceneId },
    include: {
      objects: true
    }
  });
}

export async function saveSnapshot(sceneId, snapshot) {
  return prisma.sceneVersion.create({
    data: {
      sceneId,
      snapshot
    }
  });
}