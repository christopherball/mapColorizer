import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");

const copyEntries = [
  "index.html",
  "styles.css",
  "app.js",
  "LICENSE",
  "sampleMap.png",
  "js",
  "vendor",
  "data/example-states.csv",
  "data/example-counties.csv",
  "data/reference/us-counties-fips.csv",
  "data/boundaries/states-albers-10m.json",
  "data/boundaries/counties-census-2024-5m-projected.geojson",
  "data/boundaries/states-census-2024-5m-projected.geojson",
];

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

for (const relativePath of copyEntries) {
  const sourcePath = path.join(projectRoot, relativePath);
  const targetPath = path.join(distRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true });
}

console.log(`Built dist bundle at ${path.relative(projectRoot, distRoot)}`);
