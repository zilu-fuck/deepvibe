import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const source = path.join(rootDir, "plugin-host.cjs");
const targetDir = path.join(rootDir, "dist");
const target = path.join(targetDir, "plugin-host.cjs");

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
