import { build } from "esbuild";
import { readFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
for (const [entry, output] of [
  ["ip-source.cjs", "geo-ip.cjs"],
  ["geo-worker-source.cjs", "geo-worker.cjs"],
]) {
  const destination = new URL("../../backend/" + output, import.meta.url);
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile: fileURLToPath(destination),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    legalComments: "inline",
  });
  for (const dependency of entry === "ip-source.cjs"
    ? ["ipaddr.js"]
    : ["maxmind", "mmdb-lib", "tiny-lru"]) {
    const license = await readFile(
      new URL("../node_modules/" + dependency + "/LICENSE", import.meta.url),
      "utf8",
    );
    await appendFile(
      destination,
      "\n/* Bundled dependency: " +
        dependency +
        "\n" +
        license.replaceAll("*/", "* /") +
        "\n*/\n",
    );
  }
}
