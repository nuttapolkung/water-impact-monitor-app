import { rm, mkdir, copyFile, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/", import.meta.url);
// dist is a generated build artifact: publish only the frontend, never the repo root.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await copyFile(root + "index.html", new URL("index.html", output));
await cp(root + "assets", new URL("assets", output), { recursive: true });
console.info("Static frontend built in dist/");
