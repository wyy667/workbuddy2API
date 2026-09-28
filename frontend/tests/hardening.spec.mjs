import {test,expect} from '@playwright/test';
test.beforeEach(async({request})=>{await request.post('/__reset');});
test('notifications work when randomUUID is unavailable on HTTP',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
 await page.route('**/admin/api/tasks/list*',route=>route.fulfill({status:503,json:{message:'模拟扫描失败'}}));
 await page.goto('/admin?key=fixture#sec-tasks');await expect(page.locator('.sync-state')).toContainText('已同步');
 await page.getByRole('button',{name:'扫描任务',exact:true}).click();
 await expect(page.locator('.toast').first()).toContainText('模拟扫描失败');expect(errors).toEqual([]);
});
test('select options refresh after asynchronous account data arrives',async({page})=>{
 let release;const gate=new Promise(r=>release=r);
 await page.route('**/admin/api/tasks/accounts*',async route=>{await gate;await route.fulfill({json:{ok:true,accounts:[{id:'async.json',uid:'async-user',nickname:'异步到达账号'}]}});});
 await page.goto('/admin?key=fixture#sec-tasks');
 await page.getByRole('combobox',{name:'选择任务账号'}).click();
 await expect(page.getByRole('option').filter({hasText:'当前服务账号'})).toBeVisible();release();
 await expect(page.getByRole('option').filter({hasText:'异步到达账号'})).toBeVisible();
 await page.getByRole('option').filter({hasText:'异步到达账号'}).click();
 await expect(page.getByRole('combobox',{name:'选择任务账号'})).toContainText('异步到达账号');
});
test('queue refresh and page reactivation share one pending request',async({page})=>{
 let calls=0,release;const gate=new Promise(r=>release=r);
 await page.route('**/admin/api/tasks/queue*',async route=>{calls++;await gate;await route.fulfill({json:{ok:true,running:false,items:[]}});});
 await page.goto('/admin?key=fixture#sec-tasks');await expect.poll(()=>calls).toBe(1);
 await page.getByRole('button',{name:'刷新队列',exact:true}).click();
 await page.locator('.nav-link[href="#sec-overview"]').click();await page.locator('.nav-link[href="#sec-tasks"]').click();
 expect(calls).toBe(1);release();await expect(page.getByRole('button',{name:'刷新队列',exact:true})).toBeEnabled();
});

test('production CSP allows bundled pages and map without script policy violations',async({page})=>{
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
 const policy=source.match(/'Content-Security-Policy': "([^"]+)"/)[1];
 const violations=[];
 await page.addInitScript(()=>{window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push(e.violatedDirective));});
 page.on('pageerror',e=>violations.push(e.message));
 await page.route(/\/admin\?/,async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});});
 await page.goto('/admin?key=fixture#sec-overview');await expect(page.locator('.sync-state')).toContainText('已同步');
 for(const id of ['tasks','keys','ext','backup','overview']){await page.locator(`.nav-link[href="#sec-${id}"]`).click();await expect(page.locator('.main-content')).toBeVisible();}
 expect(await page.evaluate(()=>window.__cspViolations)).toEqual([]);expect(violations).toEqual([]);
});
