"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// node_modules/mmdb-lib/lib/utils.js
var require_utils = __commonJS({
  "node_modules/mmdb-lib/lib/utils.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var legacyErrorMessage = `Maxmind v2 module has changed API.
Upgrade instructions can be found here: https://github.com/runk/node-maxmind/wiki/Migration-guide
If you want to use legacy library then explicitly install maxmind@1`;
    var assert = (condition, message) => {
      if (!condition) {
        throw new Error(message);
      }
    };
    exports2.default = {
      assert,
      legacyErrorMessage
    };
  }
});

// node_modules/mmdb-lib/lib/decoder.js
var require_decoder = __commonJS({
  "node_modules/mmdb-lib/lib/decoder.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var utils_1 = __importDefault(require_utils());
    utils_1.default.assert(typeof BigInt !== "undefined", "Apparently you are using old version of node. Please upgrade to node 10.4.x or above.");
    var MAX_INT_32 = 2147483647;
    var DataType;
    (function(DataType2) {
      DataType2[DataType2["Extended"] = 0] = "Extended";
      DataType2[DataType2["Pointer"] = 1] = "Pointer";
      DataType2[DataType2["Utf8String"] = 2] = "Utf8String";
      DataType2[DataType2["Double"] = 3] = "Double";
      DataType2[DataType2["Bytes"] = 4] = "Bytes";
      DataType2[DataType2["Uint16"] = 5] = "Uint16";
      DataType2[DataType2["Uint32"] = 6] = "Uint32";
      DataType2[DataType2["Map"] = 7] = "Map";
      DataType2[DataType2["Int32"] = 8] = "Int32";
      DataType2[DataType2["Uint64"] = 9] = "Uint64";
      DataType2[DataType2["Uint128"] = 10] = "Uint128";
      DataType2[DataType2["Array"] = 11] = "Array";
      DataType2[DataType2["Container"] = 12] = "Container";
      DataType2[DataType2["EndMarker"] = 13] = "EndMarker";
      DataType2[DataType2["Boolean"] = 14] = "Boolean";
      DataType2[DataType2["Float"] = 15] = "Float";
    })(DataType || (DataType = {}));
    var pointerValueOffset = [0, 2048, 526336, 0];
    var noCache = {
      get: () => void 0,
      set: () => void 0
    };
    var cursor = (value, offset) => ({ value, offset });
    var Decoder = class {
      constructor(db, baseOffset = 0, cache = noCache) {
        this.telemetry = {};
        utils_1.default.assert(Boolean(db), "Database buffer is required");
        this.db = db;
        this.baseOffset = baseOffset;
        this.cache = cache;
      }
      decode(offset) {
        let tmp;
        const ctrlByte = this.db[offset++];
        let type = ctrlByte >> 5;
        if (type === DataType.Pointer) {
          tmp = this.decodePointer(ctrlByte, offset);
          return cursor(this.decodeFast(tmp.value).value, tmp.offset);
        }
        if (type === DataType.Extended) {
          tmp = this.db[offset] + 7;
          if (tmp < 8) {
            throw new Error("Invalid Extended Type at offset " + offset + " val " + tmp);
          }
          type = tmp;
          offset++;
        }
        const size = this.sizeFromCtrlByte(ctrlByte, offset);
        return this.decodeByType(type, size.offset, size.value);
      }
      decodeFast(offset) {
        const cached = this.cache.get(offset);
        if (cached) {
          return cached;
        }
        const result = this.decode(offset);
        this.cache.set(offset, result);
        return result;
      }
      decodeByType(type, offset, size) {
        const newOffset = offset + size;
        switch (type) {
          case DataType.Utf8String:
            return cursor(this.decodeString(offset, size), newOffset);
          case DataType.Map:
            return this.decodeMap(size, offset);
          case DataType.Uint32:
            return cursor(this.decodeUint(offset, size), newOffset);
          case DataType.Double:
            return cursor(this.decodeDouble(offset), newOffset);
          case DataType.Array:
            return this.decodeArray(size, offset);
          case DataType.Boolean:
            return cursor(this.decodeBoolean(size), offset);
          case DataType.Float:
            return cursor(this.decodeFloat(offset), newOffset);
          case DataType.Bytes:
            return cursor(this.decodeBytes(offset, size), newOffset);
          case DataType.Uint16:
            return cursor(this.decodeUint(offset, size), newOffset);
          case DataType.Int32:
            return cursor(this.decodeInt32(offset, size), newOffset);
          case DataType.Uint64:
            return cursor(this.decodeBigUint(offset, size), newOffset);
          case DataType.Uint128:
            return cursor(this.decodeBigUint(offset, size), newOffset);
        }
        throw new Error("Unknown type " + type + " at offset " + offset);
      }
      sizeFromCtrlByte(ctrlByte, offset) {
        const size = ctrlByte & 31;
        if (size < 29) {
          return cursor(size, offset);
        }
        if (size === 29) {
          return cursor(29 + this.db[offset], offset + 1);
        }
        if (size === 30) {
          return cursor(285 + this.db.readUInt16BE(offset), offset + 2);
        }
        return cursor(65821 + this.db.readUIntBE(offset, 3), offset + 3);
      }
      decodeBytes(offset, size) {
        return this.db.subarray(offset, offset + size);
      }
      decodePointer(ctrlByte, offset) {
        const pointerSize = ctrlByte >> 3 & 3;
        const pointer = this.baseOffset + pointerValueOffset[pointerSize];
        let packed = 0;
        if (pointerSize === 0) {
          packed = (ctrlByte & 7) << 8 | this.db[offset];
        } else if (pointerSize === 1) {
          packed = (ctrlByte & 7) << 16 | this.db.readUInt16BE(offset);
        } else if (pointerSize === 2) {
          packed = (ctrlByte & 7) << 24 | this.db.readUIntBE(offset, 3);
        } else {
          packed = this.db.readUInt32BE(offset);
        }
        offset += pointerSize + 1;
        return cursor(pointer + packed, offset);
      }
      decodeArray(size, offset) {
        let tmp;
        const array = new Array(size);
        for (let i = 0; i < size; i++) {
          tmp = this.decode(offset);
          offset = tmp.offset;
          array[i] = tmp.value;
        }
        return cursor(array, offset);
      }
      decodeBoolean(size) {
        return size !== 0;
      }
      decodeDouble(offset) {
        return this.db.readDoubleBE(offset);
      }
      decodeFloat(offset) {
        return this.db.readFloatBE(offset);
      }
      decodeMap(size, offset) {
        let tmp;
        let key;
        const map = {};
        for (let i = 0; i < size; i++) {
          tmp = this.decode(offset);
          key = tmp.value;
          tmp = this.decode(tmp.offset);
          offset = tmp.offset;
          map[key] = tmp.value;
        }
        return cursor(map, offset);
      }
      decodeInt32(offset, size) {
        if (size === 0) {
          return 0;
        }
        if (size < 4) {
          return this.db.readUIntBE(offset, size);
        }
        return this.db.readInt32BE(offset);
      }
      decodeUint(offset, size) {
        if (size === 0) {
          return 0;
        }
        if (size <= 4) {
          return this.db.readUIntBE(offset, size);
        }
        throw new Error(`Invalid size for unsigned integer: ${size}`);
      }
      decodeString(offset, size) {
        const newOffset = offset + size;
        return newOffset >= MAX_INT_32 ? this.db.subarray(offset, newOffset).toString("utf8") : this.db.toString("utf8", offset, newOffset);
      }
      decodeBigUint(offset, size) {
        if (size > 16) {
          throw new Error(`Invalid size for big unsigned integer: ${size}`);
        }
        let integer = 0n;
        for (let i = 0; i < size; i++) {
          integer <<= 8n;
          integer |= BigInt(this.db.readUInt8(offset + i));
        }
        return integer;
      }
    };
    exports2.default = Decoder;
  }
});

// node_modules/mmdb-lib/lib/ip.js
var require_ip = __commonJS({
  "node_modules/mmdb-lib/lib/ip.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var v4Seg = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
    var v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
    var IPv4Reg = new RegExp(`^${v4Str}$`);
    var v6Seg = "(?:[0-9a-fA-F]{1,4})";
    var IPv6Reg = new RegExp(`^(?:(?:${v6Seg}:){7}(?:${v6Seg}|:)|(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:)))(?:%[0-9a-zA-Z-.:]{1,})?$`);
    var parseIPv4 = (input) => {
      const ip = input.split(".", 4);
      const o0 = parseInt(ip[0]);
      const o1 = parseInt(ip[1]);
      const o2 = parseInt(ip[2]);
      const o3 = parseInt(ip[3]);
      return [o0, o1, o2, o3];
    };
    var hex = (v) => {
      const h = parseInt(v, 10).toString(16);
      return h.length === 2 ? h : "0" + h;
    };
    var parseIPv6 = (input) => {
      const addr = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let i;
      let parsed;
      let chunk;
      const ip = input.indexOf(".") > -1 ? input.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, (match, a, b, c, d) => {
        return hex(a) + hex(b) + ":" + hex(c) + hex(d);
      }) : input;
      const [left, right] = ip.split("::", 2);
      if (left) {
        parsed = left.split(":");
        for (i = 0; i < parsed.length; i++) {
          chunk = parseInt(parsed[i], 16);
          addr[i * 2] = chunk >> 8;
          addr[i * 2 + 1] = chunk & 255;
        }
      }
      if (right) {
        parsed = right.split(":");
        const offset = 16 - parsed.length * 2;
        for (i = 0; i < parsed.length; i++) {
          chunk = parseInt(parsed[i], 16);
          addr[offset + i * 2] = chunk >> 8;
          addr[offset + (i * 2 + 1)] = chunk & 255;
        }
      }
      return addr;
    };
    var parse = (ip) => {
      return ip.indexOf(":") === -1 ? parseIPv4(ip) : parseIPv6(ip);
    };
    var bitAt = (rawAddress, idx) => {
      const bufIdx = idx >> 3;
      const bitIdx = 7 ^ idx & 7;
      return rawAddress[bufIdx] >>> bitIdx & 1;
    };
    var validate = (ip) => IPv4Reg.test(ip) || IPv6Reg.test(ip);
    exports2.default = {
      bitAt,
      parse,
      validate
    };
  }
});

// node_modules/mmdb-lib/lib/metadata.js
var require_metadata = __commonJS({
  "node_modules/mmdb-lib/lib/metadata.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.isLegacyFormat = exports2.parseMetadata = void 0;
    var decoder_1 = __importDefault(require_decoder());
    var utils_1 = __importDefault(require_utils());
    var METADATA_START_MARKER = Buffer.from("ABCDEF4D61784D696E642E636F6D", "hex");
    var parseMetadata = (db) => {
      const offset = findStart(db);
      const decoder = new decoder_1.default(db, offset);
      const metadata = decoder.decode(offset).value;
      if (!metadata) {
        throw new Error((0, exports2.isLegacyFormat)(db) ? utils_1.default.legacyErrorMessage : "Cannot parse binary database");
      }
      utils_1.default.assert([24, 28, 32].indexOf(metadata.record_size) > -1, "Unsupported record size");
      return {
        binaryFormatMajorVersion: metadata.binary_format_major_version,
        binaryFormatMinorVersion: metadata.binary_format_minor_version,
        buildEpoch: new Date(Number(metadata.build_epoch) * 1e3),
        databaseType: metadata.database_type,
        description: metadata.description,
        ipVersion: metadata.ip_version,
        languages: metadata.languages,
        nodeByteSize: metadata.record_size / 4,
        nodeCount: metadata.node_count,
        recordSize: metadata.record_size,
        searchTreeSize: metadata.node_count * metadata.record_size / 4,
        // Depth depends on the IP version, it's 32 for IPv4 and 128 for IPv6.
        treeDepth: Math.pow(2, metadata.ip_version + 1)
      };
    };
    exports2.parseMetadata = parseMetadata;
    var findStart = (db) => {
      let found = 0;
      let fsize = db.length - 1;
      const mlen = METADATA_START_MARKER.length - 1;
      while (found <= mlen && fsize-- > 0) {
        found += db[fsize] === METADATA_START_MARKER[mlen - found] ? 1 : -found;
      }
      return fsize + found;
    };
    var isLegacyFormat = (db) => {
      const structureInfoMaxSize = 20;
      for (let i = 0; i < structureInfoMaxSize; i++) {
        const delim = db.slice(db.length - 3 - i, db.length - i);
        if (delim[0] === 255 && delim[1] === 255 && delim[2] === 255) {
          return true;
        }
      }
      return false;
    };
    exports2.isLegacyFormat = isLegacyFormat;
  }
});

// node_modules/mmdb-lib/lib/reader/walker.js
var require_walker = __commonJS({
  "node_modules/mmdb-lib/lib/reader/walker.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var readNodeRight24 = (db) => (offset) => db.readUIntBE(offset + 3, 3);
    var readNodeLeft24 = (db) => (offset) => db.readUIntBE(offset, 3);
    var readNodeLeft28 = (db) => (offset) => (db[offset + 3] & 240) << 20 | db.readUIntBE(offset, 3);
    var readNodeRight28 = (db) => (offset) => (db[offset + 3] & 15) << 24 | db.readUIntBE(offset + 4, 3);
    var readNodeLeft32 = (db) => (offset) => db.readUInt32BE(offset);
    var readNodeRight32 = (db) => (offset) => db.readUInt32BE(offset + 4);
    exports2.default = (db, recordSize) => {
      switch (recordSize) {
        case 24:
          return { left: readNodeLeft24(db), right: readNodeRight24(db) };
        case 28:
          return { left: readNodeLeft28(db), right: readNodeRight28(db) };
        case 32:
          return { left: readNodeLeft32(db), right: readNodeRight32(db) };
      }
      throw new Error("Unsupported record size");
    };
  }
});

// node_modules/mmdb-lib/lib/reader/response.js
var require_response = __commonJS({
  "node_modules/mmdb-lib/lib/reader/response.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// node_modules/mmdb-lib/lib/index.js
var require_lib = __commonJS({
  "node_modules/mmdb-lib/lib/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Reader = void 0;
    var decoder_1 = __importDefault(require_decoder());
    var ip_1 = __importDefault(require_ip());
    var metadata_1 = require_metadata();
    var walker_1 = __importDefault(require_walker());
    var DATA_SECTION_SEPARATOR_SIZE = 16;
    var Reader = class {
      constructor(db, opts = {}) {
        this.opts = opts;
        this.load(db);
      }
      load(db) {
        if (!Buffer.isBuffer(db)) {
          throw new Error(`mmdb-lib expects an instance of Buffer, got: ${typeof db}`);
        }
        this.db = db;
        this.metadata = (0, metadata_1.parseMetadata)(this.db);
        this.decoder = new decoder_1.default(this.db, this.metadata.searchTreeSize + DATA_SECTION_SEPARATOR_SIZE, this.opts.cache);
        this.walker = (0, walker_1.default)(this.db, this.metadata.recordSize);
        this.ipv4StartNodeNumber = this.ipv4Start();
      }
      get(ipAddress) {
        const [data] = this.getWithPrefixLength(ipAddress);
        return data;
      }
      getWithPrefixLength(ipAddress) {
        const [pointer, prefixLength] = this.findAddressInTree(ipAddress);
        const data = pointer ? this.resolveDataPointer(pointer) : null;
        return [data, prefixLength];
      }
      findAddressInTree(ipAddress) {
        const rawAddress = ip_1.default.parse(ipAddress);
        const nodeCount = this.metadata.nodeCount;
        const bitLength = rawAddress.length * 8;
        let bit;
        let nodeNumber = 0;
        let offset;
        let depth = 0;
        if (rawAddress.length === 4) {
          nodeNumber = this.ipv4StartNodeNumber;
        }
        for (; depth < bitLength && nodeNumber < nodeCount; depth++) {
          bit = ip_1.default.bitAt(rawAddress, depth);
          offset = nodeNumber * this.metadata.nodeByteSize;
          nodeNumber = bit ? this.walker.right(offset) : this.walker.left(offset);
        }
        if (nodeNumber > nodeCount) {
          return [nodeNumber, depth];
        }
        return [null, depth];
      }
      resolveDataPointer(pointer) {
        const resolved = pointer - this.metadata.nodeCount + this.metadata.searchTreeSize;
        return this.decoder.decodeFast(resolved).value;
      }
      ipv4Start() {
        if (this.metadata.ipVersion === 4) {
          return 0;
        }
        const nodeCount = this.metadata.nodeCount;
        let pointer = 0;
        let i = 0;
        for (; i < 96 && pointer < nodeCount; i++) {
          const offset = pointer * this.metadata.nodeByteSize;
          pointer = this.walker.left(offset);
        }
        return pointer;
      }
    };
    exports2.Reader = Reader;
    __exportStar(require_response(), exports2);
  }
});

// node_modules/tiny-lru/dist/tiny-lru.cjs
var require_tiny_lru = __commonJS({
  "node_modules/tiny-lru/dist/tiny-lru.cjs"(exports2) {
    "use strict";
    /**
     * tiny-lru
     *
     * @copyright 2026 Jason Mulligan <jason.mulligan@avoidwork.com>
     * @license BSD-3-Clause
     * @version 13.0.0
     */
    var LRU = class {
      #stats;
      #onEvict;
      /**
       * Creates a new LRU cache instance.
       * Note: Constructor does not validate parameters. Use lru() factory function for parameter validation.
       *
       * @constructor
       * @param {number} [max=0] - Maximum number of items to store. 0 means unlimited.
       * @param {number} [ttl=0] - Time to live in milliseconds. 0 means no expiration.
       * @param {boolean} [resetTTL=false] - Whether to reset TTL when updating existing items via set().
       */
      constructor(max = 0, ttl = 0, resetTTL = false) {
        this.first = null;
        this.items = /* @__PURE__ */ Object.create(null);
        this.last = null;
        this.max = max;
        this.resetTTL = resetTTL;
        this.size = 0;
        this.ttl = ttl;
        this.#stats = { hits: 0, misses: 0, sets: 0, deletes: 0, evictions: 0 };
        this.#onEvict = null;
      }
      /**
       * Removes all items from the cache.
       *
       * @returns {LRU} The LRU instance for method chaining.
       */
      clear() {
        for (let x = this.first; x !== null; ) {
          const next = x.next;
          x.prev = null;
          x.next = null;
          x = next;
        }
        this.first = null;
        this.items = /* @__PURE__ */ Object.create(null);
        this.last = null;
        this.size = 0;
        this.#stats.hits = 0;
        this.#stats.misses = 0;
        this.#stats.sets = 0;
        this.#stats.deletes = 0;
        this.#stats.evictions = 0;
        return this;
      }
      /**
       * Removes an item from the cache by key.
       *
       * @param {string} key - The key of the item to delete.
       * @returns {LRU} The LRU instance for method chaining.
       */
      delete(key) {
        const item = this.items[key];
        if (item !== void 0) {
          delete this.items[key];
          this.size--;
          this.#stats.deletes++;
          this.#unlink(item);
          item.prev = null;
          item.next = null;
        }
        return this;
      }
      /**
       * Returns an array of [key, value] pairs for the specified keys.
       * When no keys provided, returns all entries in LRU order.
       * When keys provided, order matches the input array.
       *
       * @param {string[]} [keys=this.keys()] - Array of keys to get entries for. Defaults to all keys.
       * @returns {Array<Array<*>>} Array of [key, value] pairs.
       */
      entries(keys) {
        if (keys === void 0) {
          keys = this.keys();
        }
        const result = Array.from({ length: keys.length });
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const item = this.items[key];
          result[i] = [key, item !== void 0 ? item.value : void 0];
        }
        return result;
      }
      /**
       * Removes the least recently used item from the cache.
       *
       * @returns {LRU} The LRU instance for method chaining.
       */
      evict() {
        if (this.size === 0) {
          return this;
        }
        const item = this.first;
        delete this.items[item.key];
        this.#stats.evictions++;
        if (--this.size === 0) {
          this.first = null;
          this.last = null;
        } else {
          this.#unlink(item);
        }
        item.prev = null;
        item.next = null;
        if (this.#onEvict !== null) {
          this.#onEvict({
            key: item.key,
            value: item.value,
            expiry: item.expiry
          });
        }
        return this;
      }
      /**
       * Returns the expiration timestamp for a given key.
       *
       * @param {string} key - The key to check expiration for.
       * @returns {number|undefined} The expiration timestamp in milliseconds, or undefined if key doesn't exist.
       */
      expiresAt(key) {
        const item = this.items[key];
        return item !== void 0 ? item.expiry : void 0;
      }
      /**
       * Checks if an item has expired.
       *
       * @param {Object} item - The cache item to check.
       * @returns {boolean} True if the item has expired, false otherwise.
       * @private
       */
      #isExpired(item) {
        if (this.ttl === 0 || item.expiry === 0) {
          return false;
        }
        return item.expiry <= Date.now();
      }
      /**
       * Retrieves a value from the cache by key without updating LRU order.
       * Note: Does not perform TTL checks or remove expired items.
       *
       * @param {string} key - The key to retrieve.
       * @returns {*} The value associated with the key, or undefined if not found.
       */
      peek(key) {
        const item = this.items[key];
        return item !== void 0 ? item.value : void 0;
      }
      /**
       * Retrieves a value from the cache by key. Updates the item's position to most recently used.
       *
       * @param {string} key - The key to retrieve.
       * @returns {*} The value associated with the key, or undefined if not found or expired.
       */
      get(key) {
        const item = this.items[key];
        if (item !== void 0) {
          if (!this.#isExpired(item)) {
            this.moveToEnd(item);
            this.#stats.hits++;
            return item.value;
          }
          this.delete(key);
          this.#stats.misses++;
          return void 0;
        }
        this.#stats.misses++;
        return void 0;
      }
      /**
       * Checks if a key exists in the cache.
       *
       * @param {string} key - The key to check for.
       * @returns {boolean} True if the key exists and is not expired, false otherwise.
       */
      has(key) {
        const item = this.items[key];
        return item !== void 0 && !this.#isExpired(item);
      }
      /**
       * Unlinks an item from the doubly-linked list.
       * Updates first/last pointers if needed.
       * Does NOT clear the item's prev/next pointers or delete from items map.
       *
       * @private
       */
      #unlink(item) {
        if (item.prev !== null) {
          item.prev.next = item.next;
        }
        if (item.next !== null) {
          item.next.prev = item.prev;
        }
        if (this.first === item) {
          this.first = item.next;
        }
        if (this.last === item) {
          this.last = item.prev;
        }
      }
      /**
       * Efficiently moves an item to the end of the LRU list (most recently used position).
       * This is an internal optimization method that avoids the overhead of the full set() operation
       * when only LRU position needs to be updated.
       *
       * @param {Object} item - The cache item with prev/next pointers to reposition.
       * @private
       */
      moveToEnd(item) {
        if (this.last === item) {
          return;
        }
        this.#unlink(item);
        item.prev = this.last;
        item.next = null;
        this.last.next = item;
        this.last = item;
      }
      /**
       * Returns an array of all keys in the cache, ordered from least to most recently used.
       *
       * @returns {string[]} Array of keys in LRU order.
       */
      keys() {
        const result = Array.from({ length: this.size });
        let x = this.first;
        let i = 0;
        while (x !== null) {
          result[i++] = x.key;
          x = x.next;
        }
        return result;
      }
      /**
       * Sets a value in the cache and returns any evicted item.
       *
       * @param {string} key - The key to set.
       * @param {*} value - The value to store.
       * @returns {Object|null} The evicted item (if any) with shape {key, value, expiry}, or null.
       */
      setWithEvicted(key, value) {
        let evicted = null;
        let item = this.items[key];
        if (item !== void 0) {
          item.value = value;
          if (this.resetTTL) {
            item.expiry = this.ttl > 0 ? Date.now() + this.ttl : this.ttl;
          }
          this.moveToEnd(item);
        } else {
          if (this.max > 0 && this.size === this.max) {
            evicted = {
              key: this.first.key,
              value: this.first.value,
              expiry: this.first.expiry
            };
            this.evict();
          }
          item = this.items[key] = {
            expiry: this.ttl > 0 ? Date.now() + this.ttl : this.ttl,
            key,
            prev: this.last,
            next: null,
            value
          };
          if (++this.size === 1) {
            this.first = item;
          } else {
            this.last.next = item;
          }
          this.last = item;
        }
        this.#stats.sets++;
        return evicted;
      }
      /**
       * Sets a value in the cache. Updates the item's position to most recently used.
       *
       * @param {string} key - The key to set.
       * @param {*} value - The value to store.
       * @returns {LRU} The LRU instance for method chaining.
       */
      set(key, value) {
        let item = this.items[key];
        if (item !== void 0) {
          item.value = value;
          if (this.resetTTL) {
            item.expiry = this.ttl > 0 ? Date.now() + this.ttl : this.ttl;
          }
          this.moveToEnd(item);
        } else {
          if (this.max > 0 && this.size === this.max) {
            this.evict();
          }
          item = this.items[key] = {
            expiry: this.ttl > 0 ? Date.now() + this.ttl : this.ttl,
            key,
            prev: this.last,
            next: null,
            value
          };
          if (++this.size === 1) {
            this.first = item;
          } else {
            this.last.next = item;
          }
          this.last = item;
        }
        this.#stats.sets++;
        return this;
      }
      /**
       * Returns an array of all values in the cache for the specified keys.
       * When no keys provided, returns all values in LRU order.
       * When keys provided, order matches the input array.
       *
       * @param {string[]} [keys] - Array of keys to get values for. Defaults to all keys.
       * @returns {Array<*>} Array of values corresponding to the keys.
       */
      values(keys) {
        if (keys === void 0) {
          const result2 = Array.from({ length: this.size });
          let i = 0;
          for (let x = this.first; x !== null; x = x.next) {
            result2[i++] = x.value;
          }
          return result2;
        }
        const result = Array.from({ length: keys.length });
        for (let i = 0; i < keys.length; i++) {
          const item = this.items[keys[i]];
          result[i] = item !== void 0 ? item.value : void 0;
        }
        return result;
      }
      /**
       * Iterate over cache items in LRU order (least to most recent).
       * Note: This method directly accesses items from the linked list without calling
       * get() or peek(), so it does not update LRU order or check TTL expiration during iteration.
       *
       * @param {function(*, any, LRU): void} callback - Function to call for each item. Signature: callback(value, key, cache)
       * @param {Object} [thisArg] - Value to use as `this` when executing callback.
       * @returns {LRU} The LRU instance for method chaining.
       */
      forEach(callback, thisArg) {
        for (let x = this.first; x !== null; x = x.next) {
          callback.call(thisArg, x.value, x.key, this);
        }
        return this;
      }
      /**
       * Batch retrieve multiple items.
       *
       * @param {string[]} keys - Array of keys to retrieve.
       * @returns {Object} Object mapping keys to values (undefined for missing/expired keys).
       */
      getMany(keys) {
        const result = /* @__PURE__ */ Object.create(null);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          result[key] = this.get(key);
        }
        return result;
      }
      /**
       * Batch existence check - returns true if ALL keys exist.
       *
       * @param {string[]} keys - Array of keys to check.
       * @returns {boolean} True if all keys exist and are not expired.
       */
      hasAll(keys) {
        for (let i = 0; i < keys.length; i++) {
          if (!this.has(keys[i])) {
            return false;
          }
        }
        return true;
      }
      /**
       * Batch existence check - returns true if ANY key exists.
       *
       * @param {string[]} keys - Array of keys to check.
       * @returns {boolean} True if any key exists and is not expired.
       */
      hasAny(keys) {
        for (let i = 0; i < keys.length; i++) {
          if (this.has(keys[i])) {
            return true;
          }
        }
        return false;
      }
      /**
       * Remove expired items without affecting LRU order.
       * Unlike get(), this does not move items to the end.
       *
       * @returns {number} Number of expired items removed.
       */
      cleanup() {
        if (this.ttl === 0 || this.size === 0) {
          return 0;
        }
        let removed = 0;
        for (let x = this.first; x !== null; ) {
          const next = x.next;
          if (this.#isExpired(x)) {
            const key = x.key;
            if (this.items[key] !== void 0) {
              delete this.items[key];
              this.size--;
              removed++;
              this.#unlink(x);
              x.prev = null;
              x.next = null;
            }
          }
          x = next;
        }
        if (removed > 0) {
          this.#rebuildList();
        }
        return removed;
      }
      /**
       * Serialize cache to JSON-compatible format.
       *
       * @returns {Array<{key: any, value: *, expiry: number}>} Array of cache items.
       */
      toJSON() {
        const result = [];
        for (let x = this.first; x !== null; x = x.next) {
          result.push({
            key: x.key,
            value: x.value,
            expiry: x.expiry
          });
        }
        return result;
      }
      /**
       * Get cache statistics.
       *
       * @returns {Object} Statistics object with hits, misses, sets, deletes, evictions counts.
       */
      stats() {
        return { ...this.#stats };
      }
      /**
       * Register callback for evicted items.
       *
       * @param {function(Object): void} callback - Function called when item is evicted. Receives {key, value, expiry}.
       * @returns {LRU} The LRU instance for method chaining.
       */
      onEvict(callback) {
        if (typeof callback !== "function") {
          throw new TypeError("onEvict callback must be a function");
        }
        this.#onEvict = callback;
        return this;
      }
      /**
       * Get counts of items by TTL status.
       *
       * @returns {Object} Object with valid, expired, and noTTL counts.
       */
      sizeByTTL() {
        if (this.ttl === 0) {
          return { valid: this.size, expired: 0, noTTL: this.size };
        }
        const now = Date.now();
        let valid = 0;
        let expired = 0;
        let noTTL = 0;
        for (let x = this.first; x !== null; x = x.next) {
          if (x.expiry === 0) {
            noTTL++;
            valid++;
          } else if (x.expiry > now) {
            valid++;
          } else {
            expired++;
          }
        }
        return { valid, expired, noTTL };
      }
      /**
       * Get keys filtered by TTL status.
       *
       * @returns {Object} Object with valid, expired, and noTTL arrays of keys.
       */
      keysByTTL() {
        if (this.ttl === 0) {
          return { valid: this.keys(), expired: [], noTTL: this.keys() };
        }
        const now = Date.now();
        const valid = [];
        const expired = [];
        const noTTL = [];
        for (let x = this.first; x !== null; x = x.next) {
          if (x.expiry === 0) {
            valid.push(x.key);
            noTTL.push(x.key);
          } else if (x.expiry > now) {
            valid.push(x.key);
          } else {
            expired.push(x.key);
          }
        }
        return { valid, expired, noTTL };
      }
      /**
       * Get values filtered by TTL status.
       *
       * @returns {Object} Object with valid, expired, and noTTL arrays of values.
       */
      valuesByTTL() {
        const keysByTTL = this.keysByTTL();
        return {
          valid: this.values(keysByTTL.valid),
          expired: this.values(keysByTTL.expired),
          noTTL: this.values(keysByTTL.noTTL)
        };
      }
      /**
       * Rebuild the doubly-linked list after cleanup by deleting expired items.
       * This removes nodes that were deleted during cleanup.
       *
       * @private
       */
      #rebuildList() {
        if (this.size === 0) {
          this.first = null;
          this.last = null;
          return;
        }
        const keys = this.keys();
        this.first = null;
        this.last = null;
        for (let i = 0; i < keys.length; i++) {
          const item = this.items[keys[i]];
          if (item !== null && item !== void 0) {
            if (this.first === null) {
              this.first = item;
              item.prev = null;
            } else {
              item.prev = this.last;
              this.last.next = item;
            }
            item.next = null;
            this.last = item;
          }
        }
      }
    };
    function lru(max = 1e3, ttl = 0, resetTTL = false) {
      if (isNaN(max) || max < 0) {
        throw new TypeError("Invalid max value");
      }
      if (isNaN(ttl) || ttl < 0) {
        throw new TypeError("Invalid ttl value");
      }
      if (typeof resetTTL !== "boolean") {
        throw new TypeError("Invalid resetTTL value");
      }
      return new LRU(max, ttl, resetTTL);
    }
    exports2.LRU = LRU;
    exports2.lru = lru;
  }
});

// node_modules/maxmind/lib/fs.js
var require_fs = __commonJS({
  "node_modules/maxmind/lib/fs.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var fs_1 = __importDefault(require("fs"));
    var util_1 = __importDefault(require("util"));
    exports2.default = {
      existsSync: fs_1.default.existsSync,
      readFile: util_1.default.promisify(fs_1.default.readFile),
      watchFile: fs_1.default.watchFile,
      createReadStream: fs_1.default.createReadStream,
      stat: util_1.default.promisify(fs_1.default.stat)
    };
  }
});

// node_modules/maxmind/lib/ip.js
var require_ip2 = __commonJS({
  "node_modules/maxmind/lib/ip.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    var net_1 = __importDefault(require("net"));
    var parseIPv4 = (input) => {
      const ip = input.split(".", 4);
      const o0 = parseInt(ip[0]);
      const o1 = parseInt(ip[1]);
      const o2 = parseInt(ip[2]);
      const o3 = parseInt(ip[3]);
      return [o0, o1, o2, o3];
    };
    var hex = (v) => {
      v = parseInt(v, 10).toString(16);
      return v.length === 2 ? v : "0" + v;
    };
    var parseIPv6 = (ip) => {
      const addr = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let i;
      let parsed;
      let chunk;
      if (ip.indexOf(".") > -1) {
        ip = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, (match, a, b, c, d) => {
          return hex(a) + hex(b) + ":" + hex(c) + hex(d);
        });
      }
      const [left, right] = ip.split("::", 2);
      if (left) {
        parsed = left.split(":");
        for (i = 0; i < parsed.length; i++) {
          chunk = parseInt(parsed[i], 16);
          addr[i * 2] = chunk >> 8;
          addr[i * 2 + 1] = chunk & 255;
        }
      }
      if (right) {
        parsed = right.split(":");
        const offset = 16 - parsed.length * 2;
        for (i = 0; i < parsed.length; i++) {
          chunk = parseInt(parsed[i], 16);
          addr[offset + i * 2] = chunk >> 8;
          addr[offset + (i * 2 + 1)] = chunk & 255;
        }
      }
      return addr;
    };
    var parse = (ip) => {
      return ip.indexOf(":") === -1 ? parseIPv4(ip) : parseIPv6(ip);
    };
    var bitAt = (rawAddress, idx) => {
      const bufIdx = idx >> 3;
      const bitIdx = 7 ^ idx & 7;
      return rawAddress[bufIdx] >>> bitIdx & 1;
    };
    var validate = (ip) => {
      const version = net_1.default.isIP(ip);
      return version === 4 || version === 6;
    };
    exports2.default = {
      bitAt,
      parse,
      validate
    };
  }
});

// node_modules/maxmind/lib/is-gzip.js
var require_is_gzip = __commonJS({
  "node_modules/maxmind/lib/is-gzip.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.default = (buf) => {
      if (!buf || buf.length < 3) {
        return false;
      }
      return buf[0] === 31 && buf[1] === 139 && buf[2] === 8;
    };
  }
});

// node_modules/maxmind/lib/utils.js
var require_utils2 = __commonJS({
  "node_modules/maxmind/lib/utils.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var concat2 = (a, b) => {
      return a << 8 | b;
    };
    var concat3 = (a, b, c) => {
      return a << 16 | b << 8 | c;
    };
    var concat4 = (a, b, c, d) => {
      return a << 24 | b << 16 | c << 8 | d;
    };
    var legacyErrorMessage = `Maxmind v2 module has changed API.
Upgrade instructions can be found here: https://github.com/runk/node-maxmind/wiki/Migration-guide
If you want to use legacy libary then explicitly install maxmind@1`;
    exports2.default = {
      concat2,
      concat3,
      concat4,
      legacyErrorMessage
    };
  }
});

// node_modules/maxmind/lib/index.js
var require_lib2 = __commonJS({
  "node_modules/maxmind/lib/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Reader = exports2.validate = exports2.init = exports2.openSync = exports2.open = void 0;
    var assert_1 = __importDefault(require("assert"));
    var mmdb_lib_1 = require_lib();
    Object.defineProperty(exports2, "Reader", { enumerable: true, get: function() {
      return mmdb_lib_1.Reader;
    } });
    var tiny_lru_1 = require_tiny_lru();
    var fs_1 = __importDefault(require_fs());
    var ip_1 = __importDefault(require_ip2());
    var is_gzip_1 = __importDefault(require_is_gzip());
    var utils_1 = __importDefault(require_utils2());
    var LARGE_FILE_THRESHOLD = 512 * 1024 * 1024;
    var STREAM_WATERMARK = 8 * 1024 * 1024;
    var readLargeFile = async (filepath, size) => new Promise((resolve, reject) => {
      let buffer = Buffer.allocUnsafe(size);
      let offset = 0;
      const stream = fs_1.default.createReadStream(filepath, {
        highWaterMark: STREAM_WATERMARK
      });
      stream.on("data", (chunk) => {
        if (Buffer.isBuffer(chunk)) {
          chunk.copy(buffer, offset);
          offset += chunk.length;
        } else {
          const bufferChunk = Buffer.from(chunk);
          bufferChunk.copy(buffer, offset);
          offset += bufferChunk.length;
        }
      });
      stream.on("end", () => {
        stream.close();
        resolve(buffer);
      });
      stream.on("error", (err) => {
        reject(err);
      });
    });
    var readFile = async (filepath) => {
      const fstat = await fs_1.default.stat(filepath);
      return fstat.size < LARGE_FILE_THRESHOLD ? fs_1.default.readFile(filepath) : readLargeFile(filepath, fstat.size);
    };
    var open2 = async (filepath, opts, cb) => {
      (0, assert_1.default)(!cb, utils_1.default.legacyErrorMessage);
      const database = await readFile(filepath);
      if ((0, is_gzip_1.default)(database)) {
        throw new Error("Looks like you are passing in a file in gzip format, please use mmdb database instead.");
      }
      const cache = (0, tiny_lru_1.lru)(opts?.cache?.max || 1e4);
      const reader2 = new mmdb_lib_1.Reader(database, { cache });
      if (opts && !!opts.watchForUpdates) {
        if (opts.watchForUpdatesHook && typeof opts.watchForUpdatesHook !== "function") {
          throw new Error("opts.watchForUpdatesHook should be a function");
        }
        const watcherOptions = {
          persistent: opts.watchForUpdatesNonPersistent !== true
        };
        fs_1.default.watchFile(filepath, watcherOptions, async () => {
          const waitExists = async () => {
            for (let i = 0; i < 3; i++) {
              if (fs_1.default.existsSync(filepath)) {
                return true;
              }
              await new Promise((a) => setTimeout(a, 500));
            }
            return false;
          };
          if (!await waitExists()) {
            return;
          }
          const updatedDatabase = await readFile(filepath);
          cache.clear();
          reader2.load(updatedDatabase);
          if (opts.watchForUpdatesHook) {
            opts.watchForUpdatesHook();
          }
        });
      }
      return reader2;
    };
    exports2.open = open2;
    var openSync = () => {
      throw new Error(utils_1.default.legacyErrorMessage);
    };
    exports2.openSync = openSync;
    var init = () => {
      throw new Error(utils_1.default.legacyErrorMessage);
    };
    exports2.init = init;
    exports2.validate = ip_1.default.validate;
    __exportStar(require_lib(), exports2);
    exports2.default = {
      init: exports2.init,
      open: exports2.open,
      openSync: exports2.openSync,
      validate: ip_1.default.validate
    };
  }
});

// scripts/geo-worker-source.cjs
var { parentPort, workerData, isMainThread } = require("node:worker_threads");
var fs = require("node:fs/promises");
var path = require("node:path");
var { createReadStream, createWriteStream } = require("node:fs");
var { pipeline } = require("node:stream/promises");
var { Readable, Transform } = require("node:stream");
var { createGunzip } = require("node:zlib");
var { createHash } = require("node:crypto");
var maxmind = require_lib2();
var file = workerData?.file || process.env.CB_GEO_DB || path.resolve(__dirname, "../data/dbip-city-lite.mmdb");
var reader;
var updating = false;
var status = { ready: false, updatedAt: 0, error: "" };
var send = (value) => parentPort?.postMessage(value);
function report() {
  send({ type: "status", status });
}
async function open(filePath) {
  const result = await maxmind.open(filePath);
  if (!/city/i.test(result.metadata.databaseType) || result.metadata.nodeCount < 1e3)
    throw Error("invalid_database");
  return result;
}
async function load() {
  try {
    reader = await open(file);
    status = {
      ready: true,
      updatedAt: Number(reader.metadata.buildEpoch),
      error: ""
    };
  } catch {
    status.error = "\u672C\u5730\u5730\u7406\u5E93\u5C1A\u672A\u5C31\u7EEA";
  }
  report();
}
function limit(bytes) {
  let size = 0;
  return new Transform({
    transform(chunk, _, done) {
      size += chunk.length;
      done(size > bytes ? Error("download_limit") : null, chunk);
    }
  });
}
async function update() {
  if (updating) return;
  updating = true;
  const temp = file + ".download", unpacked = file + ".next";
  try {
    const page = await fetch("https://db-ip.com/db/download/ip-to-city-lite", {
      signal: AbortSignal.timeout(3e4),
      redirect: "error"
    });
    if (!page.ok) throw Error("catalog_unavailable");
    const html = await page.text();
    const link = html.match(
      /https:\/\/download\.db-ip\.com\/free\/dbip-city-lite-(\d{4}-\d{2})\.mmdb\.gz/
    );
    if (!link) throw Error("catalog_format");
    const installed = reader && new Date(Number(reader.metadata.buildEpoch)).toISOString().slice(0, 7);
    if (installed === link[1]) return;
    const at = html.indexOf(link[0]);
    const hashes = [
      ...html.slice(Math.max(0, at - 7e3), at).matchAll(/\b[a-f0-9]{40}\b/g)
    ];
    const expected = hashes.at(-1)?.[0];
    if (!expected) throw Error("checksum_missing");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const response = await fetch(link[0], {
      signal: AbortSignal.timeout(6e5),
      redirect: "error"
    });
    if (!response.ok) throw Error("download_unavailable");
    const hash = createHash("sha1");
    const digest = new Transform({
      transform(chunk, _, done) {
        hash.update(chunk);
        done(null, chunk);
      }
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limit(250 * 1024 * 1024),
      createWriteStream(temp, { mode: 384 })
    );
    await pipeline(
      createReadStream(temp),
      createGunzip(),
      limit(600 * 1024 * 1024),
      digest,
      createWriteStream(unpacked, { mode: 384 })
    );
    if (hash.digest("hex") !== expected) throw Error("checksum_mismatch");
    const candidate = await open(unpacked);
    await fs.rename(unpacked, file);
    reader = candidate;
    status = {
      ready: true,
      updatedAt: Number(reader.metadata.buildEpoch),
      error: ""
    };
  } catch (error) {
    if (isMainThread) console.error(error.message, error.cause?.message || "");
    status.error = reader ? "\u5730\u7406\u5E93\u66F4\u65B0\u5931\u8D25\uFF0C\u7EE7\u7EED\u4F7F\u7528\u5DF2\u5B89\u88C5\u7248\u672C" : "\u5730\u7406\u5E93\u4E0D\u53EF\u7528\uFF0C\u7B49\u5F85\u4E0B\u8F7D\u6216\u624B\u52A8\u5B89\u88C5";
  } finally {
    updating = false;
    await fs.unlink(temp).catch(() => {
    });
    await fs.unlink(unpacked).catch(() => {
    });
    report();
  }
}
var name = (entry) => entry?.names?.["zh-CN"] || entry?.names?.en || "";
var chinaRegions = {
  Anhui: "\u5B89\u5FBD\u7701",
  Beijing: "\u5317\u4EAC\u5E02",
  Chongqing: "\u91CD\u5E86\u5E02",
  Fujian: "\u798F\u5EFA\u7701",
  Gansu: "\u7518\u8083\u7701",
  Guangdong: "\u5E7F\u4E1C\u7701",
  Guangxi: "\u5E7F\u897F\u58EE\u65CF\u81EA\u6CBB\u533A",
  Guizhou: "\u8D35\u5DDE\u7701",
  Hainan: "\u6D77\u5357\u7701",
  Hebei: "\u6CB3\u5317\u7701",
  Heilongjiang: "\u9ED1\u9F99\u6C5F\u7701",
  Henan: "\u6CB3\u5357\u7701",
  Hubei: "\u6E56\u5317\u7701",
  Hunan: "\u6E56\u5357\u7701",
  Jiangsu: "\u6C5F\u82CF\u7701",
  Jiangxi: "\u6C5F\u897F\u7701",
  Jilin: "\u5409\u6797\u7701",
  Liaoning: "\u8FBD\u5B81\u7701",
  "Inner Mongolia": "\u5185\u8499\u53E4\u81EA\u6CBB\u533A",
  Ningxia: "\u5B81\u590F\u56DE\u65CF\u81EA\u6CBB\u533A",
  Qinghai: "\u9752\u6D77\u7701",
  Shaanxi: "\u9655\u897F\u7701",
  Shandong: "\u5C71\u4E1C\u7701",
  Shanghai: "\u4E0A\u6D77\u5E02",
  Shanxi: "\u5C71\u897F\u7701",
  Sichuan: "\u56DB\u5DDD\u7701",
  Tianjin: "\u5929\u6D25\u5E02",
  Tibet: "\u897F\u85CF\u81EA\u6CBB\u533A",
  Xinjiang: "\u65B0\u7586\u7EF4\u543E\u5C14\u81EA\u6CBB\u533A",
  Yunnan: "\u4E91\u5357\u7701",
  Zhejiang: "\u6D59\u6C5F\u7701",
  "Hong Kong": "\u9999\u6E2F",
  Macau: "\u6FB3\u95E8",
  Taiwan: "\u53F0\u6E7E"
};
function lookup(ip) {
  try {
    const value = reader?.get(ip);
    if (!value) return null;
    const country = name(value.country), rawRegion = name(value.subdivisions?.[0]);
    const region = value.country?.iso_code === "CN" ? chinaRegions[rawRegion] || rawRegion : rawRegion;
    const lat = value.location?.latitude, lon = value.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return null;
    return {
      country,
      region,
      label: [country, region].filter(Boolean).join(" \xB7 ") || "\u672A\u77E5\u5730\u533A",
      precision: region ? "\u7701 / \u5DDE\u7EA7\u4F30\u7B97" : "\u56FD\u5BB6\u7EA7\u4F30\u7B97",
      lat,
      lon
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

/* Bundled dependency: maxmind
The MIT License (MIT)

Copyright (c) 2026 Dmitry Shirokov

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

/* Bundled dependency: mmdb-lib
The MIT License (MIT)

Copyright (c) 2026 Dmitry Shirokov

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

/* Bundled dependency: tiny-lru
Copyright (c) 2026, Jason Mulligan
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of tiny-lru nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

*/
