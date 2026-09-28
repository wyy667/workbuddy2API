'use strict';
const net = require('node:net');
const bad = message => { const e=new Error(message);e.status=400;throw e; };
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function normalizeBase(input,noV1=false) {
 let s=String(input||'').trim();if(!s)return '';
 if(!/^[a-z][a-z\d+.-]*:\/\//i.test(s))s='https://'+s;
 let u;try{u=new URL(s);}catch{bad('服务商地址无效');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)bad('服务商地址仅支持 HTTP(S)，不可含账号、查询参数或锚点');
 const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(host==='169.254.169.254'||host==='metadata.google.internal'||host==='0.0.0.0'||host==='::'||host.startsWith('169.254.')||/^fe[89ab][0-9a-f]:/.test(host))bad('不允许云元数据、链路本地或未指定地址');
 const local=host==='localhost'||host==='::1'||(net.isIP(host)===4&&(/^(127|10)\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host)))||(/^(fc|fd)/.test(host)&&net.isIP(host)===6);
 if(u.protocol==='http:'&&!local)bad('公网服务商必须使用 HTTPS；本地/私网服务可显式使用 HTTP');
 let pathname=u.pathname.replace(/\/+$/,'');
 if(!noV1&&!/\/v1$/i.test(pathname))pathname+='/v1';
 u.pathname=pathname;
 return u.toString().replace(/\/+$/,'');
}
function parseReset(msg, now=Date.now()) {
 const p=String(msg||'').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*(Z|[+-]\d{2}:?\d{2}))?/);
 if(p){
  const stamp=`${p[1]}-${p[2]}-${p[3]}T${p[4]}:${p[5]}:${p[6]}`;
  // Native CodeBuddy reset messages without an offset use China Standard Time.
  const offset=p[7]||'+08:00';const t=Date.parse(stamp+offset);
  const d=new Date(Date.UTC(+p[1],+p[2]-1,+p[3]));
  if(Number.isFinite(t)&&d.getUTCMonth()===+p[2]-1&&d.getUTCDate()===+p[3]&&+p[4]<24&&+p[5]<60&&+p[6]<60)return t;
 }
 return now+3600000;
}
function validateBackup(data) {
 if(!record(data)||!record(data.accounts))bad('备份文件缺少有效 accounts 对象');
 if(data.app!==undefined&&data.app!=='codebuddy-proxy')bad('不支持此备份来源');
 if(data.version!==undefined&&![1,2].includes(data.version))bad('不支持此备份版本');
 const safe=(obj,depth=0)=>{if(depth>64)bad('备份嵌套过深');if(!obj||typeof obj!=='object')return;for(const [k,v]of Object.entries(obj)){if(['__proto__','constructor','prototype'].includes(k))bad('备份包含非法字段');safe(v,depth+1);}};safe(data);
 const credential=(v)=>{
  if(!record(v)||!record(v.auth)||!record(v.account)||!['string','number'].includes(typeof v.account.uid)||!String(v.account.uid))bad('账号缺少有效身份或凭据');
  if(typeof v.auth.accessToken!=='string'||!v.auth.accessToken.trim())bad('账号缺少 accessToken');
  for(const k of ['refreshToken','domain'])if(v.auth[k]!==undefined&&typeof v.auth[k]!=='string')bad('账号凭据字段类型无效');
  for(const k of ['expiresAt','refreshExpiresAt','lastRefreshTime'])if(v.auth[k]!==undefined&&(!Number.isFinite(v.auth[k])||v.auth[k]<0))bad('账号时间字段无效');
 };
 for(const [name,v]of Object.entries(data.accounts)){if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,75}\.json$/.test(name))bad('备份包含非法账号文件名');credential(v);}
 if(data.active!=null)credential(data.active);
 for(const k of ['usageStats','checkinState','settings','rotation'])if(k in data&&!record(data[k]))bad(k+' 必须是对象');
 for(const k of ['days','total','accountStats','hours'])if(data.usageStats?.[k]!==undefined&&!record(data.usageStats[k]))bad('用量统计结构无效');
 if(data.checkinState?.accounts!==undefined&&!record(data.checkinState.accounts))bad('签到状态结构无效');
 if('apiKeys'in data){
  if(!Array.isArray(data.apiKeys))bad('apiKeys 必须是数组');const seen=new Set(),ids=new Set();
  for(const e of data.apiKeys){
   if(!record(e)||typeof e.key!=='string'||!e.key||seen.has(e.key))bad('密钥无效或重复');seen.add(e.key);
   if(e.id!==undefined){if(typeof e.id!=='string'||!e.id||ids.has(e.id))bad('密钥标识重复或无效');ids.add(e.id);}
   if(e.name!==undefined&&typeof e.name!=='string')bad('密钥名称无效');
   for(const k of ['models','accounts'])if(e[k]!==undefined&&(!Array.isArray(e[k])||e[k].some(x=>typeof x!=='string')))bad('密钥权限结构无效');
   for(const k of ['dailyLimit','dailyTokenLimit','dailyCreditLimit'])if(e[k]!==undefined&&(!Number.isFinite(e[k])||e[k]<0))bad('密钥限额无效');
   if(e.disabled!==undefined&&typeof e.disabled!=='boolean')bad('密钥状态无效');
   if(e.usage!==undefined){if(!record(e.usage))bad('密钥用量无效');for(const k of ['requests','tokens','credit'])if(e.usage[k]!==undefined&&(!Number.isFinite(e.usage[k])||e.usage[k]<0))bad('密钥用量无效');}
  }
 }
 if('extProviders'in data){
  if(!Array.isArray(data.extProviders))bad('extProviders 必须是数组');const ids=new Set(),prefixes=new Set();
  for(const e of data.extProviders){
   if(!record(e)||typeof e.id!=='string'||!e.id||ids.has(e.id)||!String(e.prefix||'').match(/^[a-z0-9][a-z0-9_-]{0,19}$/)||prefixes.has(e.prefix))bad('服务商标识无效或重复');ids.add(e.id);prefixes.add(e.prefix);
   if(!['custom','opencode','trae','qoder'].includes(e.type||'custom'))bad('服务商类型无效');
   if(!e.baseUrl)bad('服务商缺少地址');normalizeBase(e.baseUrl,true);
   if(e.key!==undefined&&typeof e.key!=='string')bad('服务商密钥无效');
   if(e.creds!==undefined&&!record(e.creds))bad('服务商凭据无效');
   if(e.models!==undefined&&(!Array.isArray(e.models)||e.models.some(x=>typeof x!=='string')))bad('服务商模型列表无效');
   if(e.modelMap!==undefined&&(!record(e.modelMap)||Object.values(e.modelMap).some(x=>typeof x!=='string')))bad('模型映射无效');
  }
 }
 const settings=data.settings;
 if(settings){
  for(const [k,min,max]of [['pollMin',5,1440],['keepaliveEveryDays',1,30]])if(k in settings&&(!Number.isInteger(settings[k])||settings[k]<min||settings[k]>max))bad('设置范围无效: '+k);
  for(const k of ['keepaliveAt','backupAt'])if(k in settings&&!/^([01]?\d|2[0-3]):[0-5]\d$/.test(settings[k]))bad('设置时间无效');
  if('paidRoute'in settings&&!['expire','balance'].includes(settings.paidRoute))bad('选号策略无效');
  if('requestMapEnabled'in settings&&typeof settings.requestMapEnabled!=='boolean')bad('地图设置无效');
 }
 if(data.rotation&&(typeof data.rotation.enabled!=='boolean'||![15,30,60,120].includes(data.rotation.intervalMin)))bad('轮换配置无效');
 return data;
}
module.exports={normalizeBase,parseReset,validateBackup};
