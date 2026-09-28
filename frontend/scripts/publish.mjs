import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
const dist = new URL("../dist/", import.meta.url);
const target = new URL("../../admin-ui/assets/", import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(new URL("../licenses/Manrope-OFL.txt", import.meta.url), new URL("../../admin-ui/Manrope-OFL.txt", import.meta.url));
// Content-hashed assets are additive: open tabs and rollback keep their chunks.
for (const name of await readdir(new URL("assets/", dist))) {
  const source = new URL("assets/" + name, dist), output = new URL(name, target);
  await copyFile(source, output);
  if (/\.(js|css|svg)$/.test(name)) {
    const bytes = await readFile(source);
    await writeFile(new URL(name + ".gz", target), gzipSync(bytes));
    await writeFile(new URL(name + ".br", target), brotliCompressSync(bytes, {params:{[constants.BROTLI_PARAM_QUALITY]:6}}));
  }
}
await writeFile(new URL("../../admin.html", import.meta.url), await readFile(new URL("index.html", dist)));
console.log("Published admin.html and content-hashed admin-ui/assets (deploy both).");
