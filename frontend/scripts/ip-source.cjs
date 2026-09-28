const ipaddr = require("ipaddr.js");
function parsed(value) {
  try {
    return ipaddr.process(
      String(value || "")
        .trim()
        .split("%")[0],
    );
  } catch {
    return null;
  }
}
function normalize(value) {
  return parsed(value)?.toString() || "";
}
function publicIP(value) {
  return parsed(value)?.range() === "unicast";
}
function trusted(value, ranges) {
  const ip = parsed(value);
  return (
    !!ip &&
    ranges.some((range) => {
      try {
        const [net, bits] = ipaddr.parseCIDR(range);
        return net.kind() === ip.kind() && ip.match(net, bits);
      } catch {
        return false;
      }
    })
  );
}
function clientIP(req, ranges = []) {
  let current = normalize(req.socket?.remoteAddress);
  if (!trusted(current, ranges)) return current;
  const raw = req.headers["x-forwarded-for"];
  if (typeof raw !== "string" || raw.length > 4096) return current;
  const chain = raw.split(",");
  for (let i = chain.length - 1; i >= 0 && trusted(current, ranges); i--) {
    const next = normalize(chain[i]);
    if (!next) break;
    current = next;
  }
  return current;
}
module.exports = { normalize, publicIP, clientIP };
