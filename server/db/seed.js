import prisma from "./client.js";
import bcrypt from "bcrypt";

async function seed() {
  const password = await bcrypt.hash("password123", 10);

  const user = await prisma.user.create({
    data: {
      username: "demo",
      email: "demo@collab3d.com",
      passwordHash: password
    }
  });

  await prisma.scene.create({
    data: {
      name: "Demo Scene",
      ownerId: user.id
    }
  });

  console.log("Seed completed");
}

seed().finally(() => process.exit());