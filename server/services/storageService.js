import fs from "fs/promises";
import path from "path";

const EXPORT_DIR = "./exports";

export async function saveExport(sceneId, format, data) {
  const file = path.join(EXPORT_DIR, `${sceneId}.${format}`);

  await fs.mkdir(EXPORT_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));

  return file;
}