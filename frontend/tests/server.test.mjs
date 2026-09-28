import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

test("real backend serves the Vue artifact and preserves saved OpenCode credentials on status updates", async () => {
  const sandbox = await fs.mkdtemp(
    path.join(os.tmpdir(), "workbuddy-console-test-"),
  );
  await fs.mkdir(path.join(sandbox, "backend"));
  await fs.copyFile(new URL('../../backend/project-version.json', import.meta.url), path.join(sandbox, 'backend', 'project-version.json'));
  for (const name of (await fs.readdir(new URL("../../backend", import.meta.url))).filter(n => n.endsWith(".cjs"))) await fs.copyFile(new URL("../../backend/" + name, import.meta.url), path.join(sandbox, "backend", name));
  await fs.copyFile(
    new URL("../../server.js", import.meta.url),
    path.join(sandbox, "server.cjs"),
  );
  await fs.copyFile(
    new URL("../../admin.html", import.meta.url),
    path.join(sandbox, "admin.html"),
  );
  await fs.writeFile(
    path.join(sandbox, "bootstrap.cjs"),
    `require('node:os').homedir=()=>__dirname;global.fetch=async()=>{throw Error('Outbound requests disabled in integration test')};require('./server.cjs');`,
  );
  const child = spawn(process.execPath, ["bootstrap.cjs"], {
    cwd: sandbox,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: "18951",
      HOST: "127.0.0.1",
      CB_API_KEY: "local-integration-test",
      CB_GEO_DISABLED: "1",
      CB_AUTH_FILE: path.join(sandbox, "no-auth.json"),
      LOCALAPPDATA: sandbox,
      XDG_DATA_HOME: sandbox,
    },
  });
  const base = "http://127.0.0.1:18951";
  const request = async (p, body) => {
    const r = await fetch(
      base + "/admin/api" + p + "?key=local-integration-test",
      {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(Error("Server startup timed out")),
        10000,
      );
      child.stdout.on("data", (d) => {
        if (String(d).includes("监听")) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(t);
        reject(Error("Server exited " + code));
      });
      child.stderr.on("data", (d) => {
        if (String(d).includes("监听")) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    assert.equal((await fetch(base + "/admin?key=invalid")).status, 401);
    assert.equal((await fetch(base + '/admin/api/project/version')).status, 401);
    assert.equal((await fetch(base + '/admin/api/project/check-update', {method:'POST'})).status, 401);
    assert.equal((await request('/project/version')).version, '3.0.1');
    assert.equal((await request('/project/check-update', {})).status, 'error');
    const html = await (
      await fetch(base + "/admin?key=local-integration-test")
    ).text();
    assert.equal(
      html,
      await fs.readFile(path.join(sandbox, "admin.html"), "utf8"),
    );
    assert.ok(html.includes("workbuddy"));
    const session = await fetch(base + "/admin?key=local-integration-test");
    const setCookie = session.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    assert.ok(!setCookie.includes("local-integration-test"));
    const cookie = setCookie.split(";")[0];
    assert.equal((await fetch(base + "/admin", {headers:{Cookie:cookie}})).status,200);
    assert.equal((await fetch(base + "/admin/api/status?detail=light", {headers:{Cookie:cookie}})).status,200);
    const headerLogin=await fetch(base + "/admin/api/status?detail=light", {headers:{"X-Api-Key":"local-integration-test"}});
    assert.equal(headerLogin.status,200);assert.match(headerLogin.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await fetch(base + "/admin/api/status?key=invalid", {headers:{Cookie:cookie}})).status,401);
    assert.equal((await fetch(base + "/v1/models", {headers:{Cookie:cookie}})).status,401);
    assert.equal((await fetch(base + "/admin/api/request-map/settings", {method:"POST",headers:{Cookie:cookie,Origin:"https://other.invalid","Content-Type":"application/json"},body:'{"enabled":false}'})).status,403);
    assert.equal((await fetch(base + "/admin/api/request-map/settings", {method:"POST",headers:{Cookie:cookie,Origin:base,"Content-Type":"application/json"},body:'{"enabled":false}'})).status,200);
    const events = new AbortController();
    const live = await fetch(base + "/admin/api/live", {headers:{Cookie:cookie}, signal:events.signal});
    assert.equal(live.status,200);await live.body.getReader().read();events.abort();
    const s = await request("/status");
    assert.equal(s.ok, true);
    assert.deepEqual(s.accounts, []);
    const body = {
      type: "opencode",
      prefix: "integration",
      name: "Integration",
      baseUrl: "https://example.com/v1",
      key: "test-upstream-secret",
      models: ["model-a"],
      modelMap: {},
    };
    const created = await request("/ext/save", body);
    const id = created.provider.id;
    const { key, ...patch } = body;
    await request("/ext/save", { ...patch, id, enabled: false });
    let stored = JSON.parse(
      await fs.readFile(path.join(sandbox, ".ext-providers.json"), "utf8"),
    )[0];
    assert.equal(
      stored.key,
      "test-upstream-secret",
      "disabling must preserve the saved key",
    );
    await request("/ext/save", {
      ...patch,
      id,
      enabled: true,
      clearDown: true,
    });
    stored = JSON.parse(
      await fs.readFile(path.join(sandbox, ".ext-providers.json"), "utf8"),
    )[0];
    assert.equal(
      stored.key,
      "test-upstream-secret",
      "clearing cooldown must preserve the saved key",
    );
    await request("/ext/save", { ...patch, id, clearKey: true });
    stored = JSON.parse(
      await fs.readFile(path.join(sandbox, ".ext-providers.json"), "utf8"),
    )[0];
    assert.equal(stored.key, undefined, "explicit clearKey removes saved key");
    await request("/ext/save", { ...body, id });
    await request("/ext/save", { ...patch, id, key: "" });
    stored = JSON.parse(
      await fs.readFile(path.join(sandbox, ".ext-providers.json"), "utf8"),
    )[0];
    assert.equal(
      stored.key,
      undefined,
      "legacy explicit empty key still selects anonymous mode",
    );

    assert.match(session.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(session.headers.get('x-frame-options'), 'SAMEORIGIN');
    await request('/keys/create',{name:'backup-key',models:['test-model']});
    const backup=await request('/backup');
    assert.equal(backup.version,2);assert.equal(backup.apiKeys.length,1);
    assert.equal(backup.extProviders.length,1);assert.ok(backup.settings);assert.ok(backup.rotation);
    const credential={account:{uid:'restore-test-user',nickname:'Restored'},auth:{domain:'www.workbuddy.cn',accessToken:'synthetic-token',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000}};
    const complete={...backup,accounts:{'restored.json':credential},active:credential,settings:{...backup.settings,paidRoute:'balance'}};
    const response=await request('/restore',complete);assert.equal(response.restored,1);
    const again=await request('/backup');assert.deepEqual(again.apiKeys,complete.apiKeys);assert.deepEqual(again.extProviders,complete.extProviders);assert.equal(again.settings.paidRoute,'balance');assert.equal(again.active.account.uid,'restore-test-user');
    const invalid=await fetch(base+'/admin/api/restore?key=local-integration-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...complete,accounts:{'restored.json':{...credential,account:{uid:'MUST-NOT-WRITE'}},'broken.json':{auth:{}}}})});
    assert.equal(invalid.status,400);assert.equal(JSON.parse(await fs.readFile(path.join(sandbox,'auths/restored.json'),'utf8')).account.uid,'restore-test-user');
    await request('/restore',{accounts:{}});assert.deepEqual((await request('/backup')).apiKeys,complete.apiKeys);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    const resolved = path.resolve(sandbox),
      temp = path.resolve(os.tmpdir()) + path.sep;
    if (
      !resolved.startsWith(temp) ||
      !path.basename(resolved).startsWith("workbuddy-console-test-")
    )
      throw Error("Unsafe sandbox cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
