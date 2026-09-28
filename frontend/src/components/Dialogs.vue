<script setup>
import {
  ref,
  reactive,
  computed,
  onBeforeUnmount,
  onMounted,
  watch,
} from "vue";
import QRCode from "qrcode";
import Modal from "./Modal.vue";
import {
  state,
  navigation,
  api,
  mutate,
  refresh,
  closeModal,
  copy,
  notify,
  loadProviders,
} from "../store.js";
import { cleanText, dateTime, safeUrl, fmt } from "../utils.js";
const dialog = state.modal;
const site = ref("cn"),
  checkinOnly = ref(false),
  login = ref(null),
  qr = ref(""),
  loginMessage = ref(""),
  loginDone = ref(false);
let poll,
  tornDown = false;
async function startLogin() {
  const d = await api("/login/start", {
    body: { site: site.value, checkinOnly: checkinOnly.value },
  });
  if (tornDown) return;
  login.value = d;
  loginMessage.value = "等待完成账号授权";
  qr.value = await QRCode.toDataURL(d.authUrl, {
    width: 220,
    margin: 1,
    color: { dark: "#20251b", light: "#ffffff" },
  });
  clearTimeout(poll);
  pollLogin();
}
async function pollLogin() {
  if (tornDown || !login.value) return;
  try {
    const d = await api("/login/poll", {
      body: { state: login.value.state },
      allowFalse: true,
      timeout: 30000,
    });
    if (tornDown) return;
    if (d.status === "success") {
      loginDone.value = true;
      loginMessage.value = "账号已连接，可以开始使用";
      await refresh();
      return;
    }
    if (["expired", "error"].includes(d.status)) {
      loginMessage.value = cleanText(d.message || "授权已失效，请重新生成");
      login.value = null;
      return;
    }
    if (Date.now() > login.value.expiresAt) {
      loginMessage.value = "授权已过期，请重新生成";
      login.value = null;
      return;
    }
  } catch (e) {
    if (!tornDown) loginMessage.value = e.message;
  }
  if (!tornDown) poll = setTimeout(pollLogin, 4000);
}
onBeforeUnmount(() => {
  tornDown = true;
  clearTimeout(poll);
});
const keyForm = reactive({
  name: "",
  models: [],
  accounts: [],
  dailyLimit: 0,
  dailyTokenLimit: 0,
  dailyCreditLimit: 0,
  ...dialog.entry,
});
const createdKey = ref(""),
  modelSearch = ref(""),
  modelGroup = ref("全部"),
  keyTab = ref("limits");
const keyModels = computed(() => {
  const list = (state.status?.modelsDetail || []).map((m) => ({
    id: m.id,
    group: "CodeBuddy",
    label: m.id,
  }));
  for (const p of state.providers)
    for (const m of [
      ...new Set([
        ...(p.models || []),
        ...Object.keys(p.modelMap || {}),
        ...(p.models?.length ? [] : p.knownModels || []),
      ]),
    ])
      list.push({ id: p.prefix + "/" + m, group: p.name, label: m });
  return [...new Map(list.map((m) => [m.id, m])).values()];
});
const modelGroups = computed(() => [
  "全部",
  ...new Set(keyModels.value.map((m) => m.group)),
]);
const visibleModels = computed(() =>
  keyModels.value.filter(
    (m) =>
      (modelGroup.value === "全部" || m.group === modelGroup.value) &&
      m.id.toLowerCase().includes(modelSearch.value.toLowerCase()),
  ),
);
function selectVisible(on) {
  keyForm.models = on
    ? [...new Set([...keyForm.models, ...visibleModels.value.map((m) => m.id)])]
    : keyForm.models.filter(
        (m) => !visibleModels.value.some((v) => v.id === m),
      );
}
async function saveKey() {
  if (dialog.busy) return;
  if (!keyForm.name.trim()) throw Error("请填写密钥名称");
  if (keyForm.models.length > 50 || keyForm.accounts.length > 50)
    throw Error("指定模型和账号分别最多 50 个");
  for (const k of ["dailyLimit", "dailyTokenLimit", "dailyCreditLimit"])
    if (!Number.isFinite(Number(keyForm[k])) || Number(keyForm[k]) < 0)
      throw Error("每日额度必须是大于或等于 0 的数字");
  const body = { ...keyForm };
  dialog.busy = true;
  try {
    const d = await api(dialog.entry ? "/keys/update" : "/keys/create", {
      body,
    });
    if (!dialog.entry) createdKey.value = d.key;
    notify(dialog.entry ? "密钥权限已更新" : "密钥已创建");
    dialog.busy = false;
    if (dialog.entry) closeModal();
    await refresh();
  } finally {
    dialog.busy = false;
  }
}
const provider = reactive({
  name: "",
  type: dialog.preset || "custom",
  prefix: dialog.preset || "",
  baseUrl: "",
  key: "",
  note: "",
  enabled: true,
  realm: "cn",
  refreshToken: "",
  callbackUrl: "",
  pat: "",
  clearKey: false,
  clearCreds: false,
  ...dialog.provider,
  modelsText: (dialog.provider?.models || []).join("\n"),
  mapText: Object.entries(dialog.provider?.modelMap || {})
    .map(([k, v]) => k + " = " + v)
    .join("\n"),
});
provider.realm = dialog.provider?.credsSummary?.realm || "cn";
const providerNames = {
  custom: "OpenAI 兼容服务",
  opencode: "OpenCode",
  trae: "Trae SOLO",
  qoder: "Qoder",
};
if (!dialog.provider && dialog.preset)
  provider.name = providerNames[dialog.preset];
watch(
  () => provider.type,
  (t) => {
    if (!dialog.provider) {
      provider.name = providerNames[t];
      provider.prefix = t === "custom" ? "" : t;
      provider.baseUrl = "";
    }
  },
);
async function saveProvider() {
  if (!provider.name.trim()) throw Error("请填写连接名称");
  if (!/^[a-z0-9][a-z0-9_-]{0,19}$/.test(provider.prefix))
    throw Error("前缀需为 1–20 位小写字母、数字、连字符或下划线");
  if (provider.type === "custom" && !safeUrl(provider.baseUrl))
    throw Error("请填写有效的 HTTP 或 HTTPS 上游地址");
  const modelMap = {};
  for (const line of provider.mapText.split("\n").filter((l) => l.trim())) {
    const i = line.indexOf("=");
    if (i < 1 || !line.slice(i + 1).trim())
      throw Error("模型映射格式为：对外名称 = 上游名称");
    modelMap[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = {
    ...provider,
    models: provider.modelsText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    modelMap,
  };
  if (!body.key?.trim()) delete body.key;
  const d = await api("/ext/save", { body });
  await loadProviders();
  notify("连接配置已保存");
  if (provider.type === "trae" && !dialog.provider) {
    Object.assign(provider, d.provider);
    state.modal.provider = d.provider;
    notify("配置已保存，可打开登录页继续授权");
  } else closeModal();
}
const snippetLang = ref("curl"),
  snippetModel = ref(dialog.model || "auto");
const snippet = computed(() => {
  const base = state.status?.service?.baseUrl || location.origin + "/v1",
    model = snippetModel.value;
  if (snippetLang.value === "python")
    return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(base)},\n    api_key="YOUR_API_KEY",\n)\n\nresponse = client.chat.completions.create(\n    model=${JSON.stringify(model)},\n    messages=[{"role": "user", "content": "Hello"}],\n    stream=True,\n)\nfor chunk in response:\n    print(chunk.choices[0].delta.content or "", end="")`;
  if (snippetLang.value === "node")
    return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: ${JSON.stringify(base)},\n  apiKey: process.env.WORKBUDDY_API_KEY,\n});\n\nconst stream = await client.chat.completions.create({\n  model: ${JSON.stringify(model)},\n  messages: [{ role: "user", content: "Hello" }],\n  stream: true,\n});\nfor await (const chunk of stream) {\n  process.stdout.write(chunk.choices[0]?.delta?.content || "");\n}`;
  return `curl ${JSON.stringify(base + "/chat/completions")} \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }], stream: true }, null, 2).replaceAll("'", "'\\''")}'`;
});
onMounted(() => {
  if (dialog.type === "key")
    loadProviders().catch((e) => notify(e.message, "error"));
});
</script>
<template>
  <Modal
    :title="dialog.title"
    :wide="['provider', 'key', 'snippet', 'result'].includes(dialog.type)"
  >
    <template v-if="dialog.type === 'confirm'"
      ><div class="confirm-illustration"><Icon name="alert" :size="27" /></div>
      <p class="confirm-text">{{ dialog.description }}</p></template
    >
    <template v-else-if="dialog.type === 'login'"
      ><div v-if="loginDone" class="login-success">
        <Icon name="success" :size="48" />
        <h3>连接成功</h3>
        <p>账号已自动保存到你的工作空间。</p>
      </div>
      <div v-else class="form-stack">
        <div class="login-intro">
          <span class="avatar accent"><Icon name="users" :size="24" /></span>
          <p>使用官方授权登录。完成后，账号会自动出现在管理台。</p>
        </div>
        <label class="field"
          >账号区域<UiSelect v-model="site" :disabled="!!login">
            <option value="cn">国内站 · CodeBuddy / WorkBuddy</option>
            <option value="intl">国际站 · CodeBuddy</option>
          </UiSelect></label
        ><label class="checkbox"
          ><input
            type="checkbox"
            v-model="checkinOnly"
            :disabled="!!login"
          />仅用于签到，保留当前服务账号</label
        >
        <div v-if="login" class="login-qr">
          <img :src="qr" alt="账号授权二维码" width="180" height="180" /><a
            class="btn dark"
            :href="safeUrl(login.authUrl)"
            target="_blank"
            rel="noopener noreferrer"
            ><Icon name="external" :size="16" />打开官方授权页</a
          ><small class="muted">有效期至 {{ dateTime(login.expiresAt) }}</small>
        </div>
        <div v-if="loginMessage" class="info-strip">
          <Icon :name="login ? 'clock' : 'alert'" :size="17" />{{
            loginMessage
          }}
        </div>
        <ActionButton :action="startLogin" icon="external" variant="primary">{{
          login ? "重新生成授权链接" : "生成授权链接"
        }}</ActionButton>
      </div></template
    >
    <template v-else-if="dialog.type === 'key'"
      ><div v-if="createdKey" class="form-stack">
        <div class="info-strip">
          <Icon name="shield" />密钥仅在创建时完整显示，请现在复制并妥善保存。
        </div>
        <div class="secret-reveal mono">{{ createdKey }}</div>
        <div class="inline">
          <ActionButton
            :action="() => copy(createdKey)"
            icon="copy"
            variant="primary"
            >复制密钥</ActionButton
          ><ActionButton
            :action="() => copy(state.status?.service?.baseUrl)"
            icon="copy"
            >复制接口地址</ActionButton
          >
        </div>
      </div>
      <form
        v-else
        id="key-form"
        class="form-stack"
        @submit.prevent="saveKey().catch((e) => notify(e.message, 'error'))"
      >
        <label class="field"
          >密钥名称<input
            v-model="keyForm.name"
            placeholder="例如：个人开发、团队项目"
            maxlength="40"
            required
        /></label>
        <div class="segmented">
          <button
            type="button"
            :class="{ active: keyTab === 'limits' }"
            @click="keyTab = 'limits'"
          >
            每日额度</button
          ><button
            type="button"
            :class="{ active: keyTab === 'models' }"
            @click="keyTab = 'models'"
          >
            模型权限 · {{ keyForm.models.length || "全部" }}</button
          ><button
            type="button"
            :class="{ active: keyTab === 'accounts' }"
            @click="keyTab = 'accounts'"
          >
            账号范围 · {{ keyForm.accounts.length || "全部" }}
          </button>
        </div>
        <div v-if="keyTab === 'limits'" class="form-grid">
          <label class="field"
            >每日请求上限<input
              type="number"
              min="0"
              step="1"
              v-model.number="keyForm.dailyLimit"
            /><small>0 表示不限</small></label
          ><label class="field"
            >每日 Token 停用阈值<input
              type="number"
              min="0"
              step="1"
              v-model.number="keyForm.dailyTokenLimit"
            /><small>0 表示不限</small></label
          ><label class="field"
            >每日积分停用阈值<input
              type="number"
              min="0"
              step="0.01"
              v-model.number="keyForm.dailyCreditLimit"
            /><small>0 表示不限</small></label
          >
        </div>
        <div v-if="keyTab === 'models'" class="form-stack">
          <div class="toolbar">
            <div class="search-input">
              <Icon name="search" :size="16" /><input
                v-model="modelSearch"
                placeholder="搜索模型"
                aria-label="搜索授权模型"
              />
            </div>
            <UiSelect v-model="modelGroup" aria-label="模型来源">
              <option v-for="g in modelGroups" :key="g">{{ g }}</option>
            </UiSelect>
          </div>
          <div class="inline">
            <button
              type="button"
              class="btn small"
              @click="selectVisible(true)"
            >
              选择当前结果</button
            ><button
              type="button"
              class="btn small"
              @click="selectVisible(false)"
            >
              取消当前结果</button
            ><button
              type="button"
              class="btn small ghost"
              @click="keyForm.models = []"
            >
              允许全部
            </button>
          </div>
          <div class="selection-grid">
            <label v-for="m in visibleModels" :key="m.id" class="checkbox"
              ><input
                type="checkbox"
                :value="m.id"
                v-model="keyForm.models"
              /><span class="mono">{{ $clean(m.id) }}</span></label
            >
          </div>
          <small class="muted"
            >不选择时允许全部模型。最多保存 50 个指定模型。</small
          >
        </div>
        <div v-if="keyTab === 'accounts'" class="form-stack">
          <div class="selection-grid">
            <label
              v-for="a in [
                ...(state.status?.accounts || []),
                ...(state.status?.pool || []),
              ]"
              :key="a.id"
              class="checkbox"
              ><input
                type="checkbox"
                :value="a.uid"
                v-model="keyForm.accounts"
              />{{ $clean(a.nickname) }}
              <span class="muted mono">{{ a.uid }}</span></label
            >
          </div>
          <small class="muted"
            >不选择时允许全部账号，指定范围仅约束 CodeBuddy 账号。</small
          >
        </div>
      </form></template
    >
    <template v-else-if="dialog.type === 'provider'"
      ><div class="form-stack">
        <div class="provider-type-picker">
          <button
            v-for="(label, type) in providerNames"
            :key="type"
            :class="{ active: provider.type === type }"
            @click="provider.type = type"
          >
            <Icon :name="type === 'custom' ? 'globe' : 'box'" /><span>{{
              label
            }}</span>
          </button>
        </div>
        <div class="form-grid">
          <label class="field"
            >连接名称<input
              v-model="provider.name"
              maxlength="40"
              placeholder="为这个连接命名" /></label
          ><label class="field"
            >模型前缀<input
              v-model="provider.prefix"
              maxlength="20"
              placeholder="例如 myapi"
              pattern="[a-z0-9][a-z0-9_-]{0,19}"
            /><small>调用时使用 前缀/模型名</small></label
          ><label class="field span-2"
            >上游 API 地址<input
              v-model="provider.baseUrl"
              :placeholder="
                provider.type === 'custom'
                  ? 'https://api.example.com/v1'
                  : '留空使用内置默认地址'
              " /></label
          ><label
            v-if="['custom', 'opencode'].includes(provider.type)"
            class="field span-2"
            >API Key<input
              type="password"
              autocomplete="new-password"
              v-model="provider.key"
              :placeholder="
                provider.keyMasked
                  ? '已保存 ' + provider.keyMasked + '，留空保留'
                  : 'OpenCode 可留空使用匿名免费层'
              "
            /><label v-if="provider.id" class="checkbox"
              ><input type="checkbox" v-model="provider.clearKey" />清除已保存的
              API Key</label
            ></label
          ><template v-if="provider.type === 'trae'"
            ><label class="field"
              >账号区域<UiSelect v-model="provider.realm">
                <option value="cn">中国</option>
                <option value="sg">新加坡</option>
                <option value="us">美国</option>
              </UiSelect></label
            >
            <div class="field">
              <span>官方授权</span
              ><a
                v-if="
                  provider.traeLoginUrl &&
                  provider.realm === provider.credsSummary?.realm
                "
                class="btn"
                :href="safeUrl(provider.traeLoginUrl)"
                target="_blank"
                rel="noopener noreferrer"
                ><Icon name="external" :size="16" />打开 Trae 登录页</a
              ><small v-else>先保存连接，即可获得匹配设备的登录地址。</small>
            </div>
            <label class="field span-2"
              >登录回调 URL<input
                v-model="provider.callbackUrl"
                autocomplete="off"
                placeholder="将授权后地址栏的完整 URL 粘贴在这里" /></label
            ><label class="field span-2"
              >或填写 Refresh Token<input
                type="password"
                v-model="provider.refreshToken"
                autocomplete="new-password"
                placeholder="留空保留已保存凭据" /></label></template
          ><label v-if="provider.type === 'qoder'" class="field span-2"
            >Personal Access Token<input
              type="password"
              v-model="provider.pat"
              autocomplete="new-password"
              placeholder="填写 Qoder PAT；留空保留" /></label
          ><label
            v-if="provider.id && ['trae', 'qoder'].includes(provider.type)"
            class="checkbox span-2"
            ><input
              type="checkbox"
              v-model="provider.clearCreds"
            />清除已保存的协议凭据</label
          ><label class="field"
            >指定模型<textarea
              v-model="provider.modelsText"
              placeholder="每行一个模型，留空使用探测目录"
            ></textarea></label
          ><label class="field"
            >模型名称映射<textarea
              v-model="provider.mapText"
              placeholder="对外名称 = 上游模型名称"
            ></textarea></label
          ><label class="field span-2"
            >备注<input
              v-model="provider.note"
              maxlength="200"
              placeholder="可选说明" /></label
          ><label class="checkbox span-2"
            ><input
              v-model="provider.enabled"
              type="checkbox"
            />启用此连接</label
          >
        </div>
      </div></template
    >
    <template v-else-if="dialog.type === 'snippet'"
      ><div class="form-stack">
        <div class="inline">
          <span class="badge purple mono">{{ $clean(snippetModel) }}</span
          ><span class="muted text-small">OpenAI 兼容接口</span>
        </div>
        <div class="segmented">
          <button
            v-for="l in ['curl', 'python', 'node']"
            :key="l"
            :class="{ active: snippetLang === l }"
            @click="snippetLang = l"
          >
            {{ { curl: "cURL", python: "Python", node: "Node.js" }[l] }}
          </button>
        </div>
        <pre class="code-block">{{ snippet }}</pre>
        <p class="muted text-small">将 YOUR_API_KEY 替换为管理台创建的密钥。</p>
      </div></template
    >
    <template v-else-if="dialog.type === 'result'"
      ><div class="result-summary" v-if="dialog.data?.content">
        <span class="badge success">连接正常</span>
        <h3>{{ $clean(dialog.data.content) }}</h3>
        <span class="muted text-small"
          >{{ dialog.data.model }} · {{ dialog.data.ms }} ms</span
        >
      </div>
      <template v-if="dialog.data?.packs">
        <div class="plain-stat" style="margin-bottom: 20px">
          <span class="label">账户可用积分</span
          ><strong>{{ fmt(dialog.data.totalLeft) }} <small>pt</small></strong>
          <p>最早到期 {{ dateTime(dialog.data.earliestExpire) }}</p>
        </div>
        <DataTable
          :columns="[
            { key: 'packageName', label: '积分包' },
            { key: 'left', label: '剩余积分' },
            { key: 'total', label: '总量' },
            { key: 'expireAt', label: '到期时间' },
          ]"
          :rows="dialog.data.packs"
        >
          <template #packageName="{ row }">{{
            $clean(row.packageName || row.packageCode || "积分包")
          }}</template>
          <template #left="{ value }"
            ><strong>{{ fmt(value) }}</strong></template
          >
          <template #total="{ value }">{{ fmt(value) }}</template>
          <template #expireAt="{ value }">{{ dateTime(value) }}</template>
        </DataTable>
      </template>
      <pre v-else>{{ $clean(JSON.stringify(dialog.data, null, 2)) }}</pre>
    </template>
    <template v-else-if="dialog.type === 'help'"
      ><p class="muted text-small">
        快捷键在输入框外生效。页面每 10 秒同步状态，切回浏览器时自动刷新。
      </p>
      <div class="shortcut-list">
        <div v-for="(n, i) in navigation" :key="n.id">
          <span>{{ n.label }}</span
          ><kbd>{{ (i + 1) % 10 }}</kbd>
        </div>
        <div><span>刷新数据</span><kbd>R</kbd></div>
        <div><span>关闭弹窗</span><kbd>Esc</kbd></div>
        <div><span>显示帮助</span><kbd>?</kbd></div>
      </div></template
    >
    <template #footer
      ><template v-if="dialog.type === 'confirm'"
        ><button class="btn" @click="closeModal(false)">取消</button
        ><button class="btn danger" @click="closeModal(true)">
          {{ dialog.button }}
        </button></template
      ><template v-else-if="dialog.type === 'key' && !createdKey"
        ><button class="btn" @click="closeModal()">取消</button
        ><ActionButton
          :action="
            () => {
              if (!keyForm.name.trim()) throw Error('请填写密钥名称');
              if (keyForm.models.length > 50) throw Error('最多指定 50 个模型');
              return saveKey();
            }
          "
          variant="primary"
          icon="key"
          >{{ dialog.entry ? "保存权限" : "创建密钥" }}</ActionButton
        ></template
      ><template v-else-if="dialog.type === 'provider'"
        ><button class="btn" @click="closeModal()">取消</button
        ><ActionButton :action="saveProvider" variant="primary" icon="check"
          >保存连接</ActionButton
        ></template
      ><ActionButton
        v-else-if="dialog.type === 'snippet'"
        :action="() => copy(snippet)"
        variant="primary"
        icon="copy"
        >复制代码</ActionButton
      ><button v-else class="btn" @click="closeModal()">
        {{ loginDone ? "开始使用" : "完成" }}
      </button></template
    >
  </Modal>
</template>
