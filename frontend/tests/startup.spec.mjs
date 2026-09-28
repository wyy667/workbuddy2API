import {test, expect} from '@playwright/test';
test.beforeEach(async ({request}) => { await request.post('/__reset'); });

test('overview renders and navigation works before status returns', async ({page}) => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  await page.route('**/admin/api/status?**', async route => { await gate; await route.continue(); });
  await page.goto('/admin?key=fixture#sec-overview');
  await expect(page.locator('.welcome-card')).toBeVisible();
  await expect(page.locator('.stat-card').first()).toContainText('正在加载用量');
  await page.getByRole('button',{name:'切换夜间模式'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.locator('.nav-link[href="#sec-accounts"]').click();
  await expect(page.locator('h1')).toHaveText('账号管理.');
  release();
  await expect(page.locator('.sync-state')).toContainText('已同步');
  await expect(page.locator('.initial-skeleton')).toHaveCount(0);
});

test('slow independent modules do not block status or mask failures as zero', async ({page}) => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  await page.route('**/admin/api/usage*', async route => { await gate; await route.fulfill({status:503,json:{message:'用量暂不可用'}}); });
  await page.route('**/admin/api/credits*', async route => { await gate; await route.continue(); });
  await page.goto('/admin?key=fixture#sec-overview');
  await expect(page.locator('.sync-state')).toContainText('已同步');
  await expect(page.locator('.stat-card').first()).toContainText('正在加载用量');
  await expect(page.locator('.system-panel')).not.toContainText('正在加载运行指标');
  release();
  await expect(page.locator('.module-placeholder').first()).toContainText('用量暂不可用');
  await expect(page.locator('.connection-alert')).toHaveCount(0);
  await page.unroute('**/admin/api/usage*');
  await page.locator('.module-placeholder').getByRole('button',{name:'重试'}).click();
  await expect(page.locator('.stat-card').first()).not.toContainText('加载失败');
});

test('disabled map is not downloaded; hashed entry assets cache independently', async ({page,request}) => {
  await request.post('/admin/api/request-map/settings?key=fixture',{data:{enabled:false}});
  const urls=[];
  page.on('request',r=>urls.push(r.url()));
  await page.goto('/admin?key=fixture#sec-overview');
  await expect(page.locator('.map-disabled-panel')).toContainText('已关闭');
  expect(urls.filter(u=>/\/RequestMap-/.test(u))).toHaveLength(0);
  const entry=urls.find(u=>/\/index-[^/]+\.js$/.test(u));
  expect(entry).toBeTruthy();
  const asset=await request.get(entry);
  expect(asset.headers()['cache-control']).toContain('immutable');
  const html=await (await request.get('/admin?key=fixture')).body();
  expect(html.length).toBeLessThan(5000);
  await page.getByRole('button',{name:'开启地图'}).click();
  await expect(page.locator('.map-route')).toHaveCount(5);
  expect(urls.some(u=>/\/RequestMap-.*\.js$/.test(u))).toBe(true);
});


test('admin key leaves URL, API uses headers and reload retains cookie authentication', async ({page}) => {
  const requests=[];page.on('request',r=>{if(r.url().includes('/admin/api/'))requests.push(r);});
  await page.goto('/admin?key=fixture#sec-overview');
  await expect(page.locator('.sync-state')).toContainText('已同步');
  expect(new URL(page.url()).searchParams.has('key')).toBe(false);
  expect(requests.every(r=>!new URL(r.url()).searchParams.has('key'))).toBe(true);
  expect(requests.find(r=>r.url().includes('/status')).headers()['x-api-key']).toBe('fixture');
  expect(await page.evaluate(()=>document.cookie)).not.toContain('fixture_admin');
  await page.reload();await expect(page.locator('.sync-state')).toContainText('已同步');
  await page.locator('.nav-link[href="#sec-logs"]').click();
  await expect(page.locator('.nav-live')).toHaveClass(/on/);
});
