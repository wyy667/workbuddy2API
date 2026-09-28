"use strict";
const { parentPort, workerData, isMainThread } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream, createWriteStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
const { createGunzip } = require("node:zlib");
const { createHash } = require("node:crypto");
const maxmind = require("maxmind");
const file =
  workerData?.file ||
  process.env.CB_GEO_DB ||
  path.resolve(__dirname, "../data/dbip-city-lite.mmdb");
let reader,
  updating = false,
  status = { ready: false, updatedAt: 0, error: "" };
const send = (value) => parentPort?.postMessage(value);
function report() {
  send({ type: "status", status });
}
async function open(filePath) {
  const result = await maxmind.open(filePath);
  if (
    !/city/i.test(result.metadata.databaseType) ||
    result.metadata.nodeCount < 1000
  )
    throw Error("invalid_database");
  return result;
}
async function load() {
  try {
    reader = await open(file);
    status = {
      ready: true,
      updatedAt: Number(reader.metadata.buildEpoch),
      error: "",
    };
  } catch {
    status.error = "本地地理库尚未就绪";
  }
  report();
}
function limit(bytes) {
  let size = 0;
  return new Transform({
    transform(chunk, _, done) {
      size += chunk.length;
      done(size > bytes ? Error("download_limit") : null, chunk);
    },
  });
}
async function update() {
  if (updating) return;
  updating = true;
  const temp = file + ".download",
    unpacked = file + ".next";
  try {
    const page = await fetch("https://db-ip.com/db/download/ip-to-city-lite", {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!page.ok) throw Error("catalog_unavailable");
    const html = await page.text();
    const link = html.match(
      /https:\/\/download\.db-ip\.com\/free\/dbip-city-lite-(\d{4}-\d{2})\.mmdb\.gz/,
    );
    if (!link) throw Error("catalog_format");
    const installed =
      reader &&
      new Date(Number(reader.metadata.buildEpoch)).toISOString().slice(0, 7);
    if (installed === link[1]) return;
    // The official MMDB section publishes the unpacked database checksum.
    const at = html.indexOf(link[0]);
    const hashes = [
      ...html.slice(Math.max(0, at - 7000), at).matchAll(/\b[a-f0-9]{40}\b/g),
    ];
    const expected = hashes.at(-1)?.[0];
    if (!expected) throw Error("checksum_missing");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const response = await fetch(link[0], {
      signal: AbortSignal.timeout(600000),
      redirect: "error",
    });
    if (!response.ok) throw Error("download_unavailable");
    const hash = createHash("sha1");
    const digest = new Transform({
      transform(chunk, _, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limit(250 * 1024 * 1024),
      createWriteStream(temp, { mode: 0o600 }),
    );
    await pipeline(
      createReadStream(temp),
      createGunzip(),
      limit(600 * 1024 * 1024),
      digest,
      createWriteStream(unpacked, { mode: 0o600 }),
    );
    if (hash.digest("hex") !== expected) throw Error("checksum_mismatch");
    const candidate = await open(unpacked);
    await fs.rename(unpacked, file);
    reader = candidate;
    status = {
      ready: true,
      updatedAt: Number(reader.metadata.buildEpoch),
      error: "",
    };
  } catch (error) {
    if (isMainThread) console.error(error.message, error.cause?.message || "");
    status.error = reader
      ? "地理库更新失败，继续使用已安装版本"
      : "地理库不可用，等待下载或手动安装";
  } finally {
    updating = false;
    await fs.unlink(temp).catch(() => {});
    await fs.unlink(unpacked).catch(() => {});
    report();
  }
}
const name = (entry) => entry?.names?.["zh-CN"] || entry?.names?.en || "";
const chinaRegions = {
  Anhui: "安徽省",
  Beijing: "北京市",
  Chongqing: "重庆市",
  Fujian: "福建省",
  Gansu: "甘肃省",
  Guangdong: "广东省",
  Guangxi: "广西壮族自治区",
  Guizhou: "贵州省",
  Hainan: "海南省",
  Hebei: "河北省",
  Heilongjiang: "黑龙江省",
  Henan: "河南省",
  Hubei: "湖北省",
  Hunan: "湖南省",
  Jiangsu: "江苏省",
  Jiangxi: "江西省",
  Jilin: "吉林省",
  Liaoning: "辽宁省",
  "Inner Mongolia": "内蒙古自治区",
  Ningxia: "宁夏回族自治区",
  Qinghai: "青海省",
  Shaanxi: "陕西省",
  Shandong: "山东省",
  Shanghai: "上海市",
  Shanxi: "山西省",
  Sichuan: "四川省",
  Tianjin: "天津市",
  Tibet: "西藏自治区",
  Xinjiang: "新疆维吾尔自治区",
  Yunnan: "云南省",
  Zhejiang: "浙江省",
  "Hong Kong": "香港",
  Macau: "澳门",
  Taiwan: "台湾",
};
function lookup(ip) {
  try {
    const value = reader?.get(ip);
    if (!value) return null;
    const country = name(value.country),
      rawRegion = name(value.subdivisions?.[0]);
    const region =
      value.country?.iso_code === "CN"
        ? chinaRegions[rawRegion] || rawRegion
        : rawRegion;
    const lat = value.location?.latitude,
      lon = value.location?.longitude;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return null;
    return {
      country,
      region,
      label: [country, region].filter(Boolean).join(" · ") || "未知地区",
      precision: region ? "省 / 州级估算" : "国家级估算",
      lat,
      lon,
    };
  } catch {
    return null;
  }
}
parentPort?.on("message", (message) => {
  if (message.type === "lookup")
    send({ type: "result", id: message.id, location: lookup(message.ip) });
  if (message.type === "update") update();
});
(async () => {
  await load();
  if (isMainThread || workerData?.autoUpdate !== false) await update();
  if (isMainThread) {
    console.log(JSON.stringify(status));
    process.exitCode = status.ready ? 0 : 1;
  }
})();
