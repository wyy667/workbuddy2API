import { test, expect } from '@playwright/test';

test('project navigation: version, explicit update check and source link', async ({ page }) => {
  let checks = 0;
  await page.route('**/admin/api/project/check-update*', async route => {
    checks++;
    await route.fulfill({json:{ok:true,version:'3.0.1',latestVersion:'3.1.0',status:'available',checkedAt:Date.now()}});
  });
  await page.goto('/admin?key=fixture');
  const section=page.getByRole('region',{name:'workbuddy2API 项目信息'});
  await expect(section.getByText('v3.0.1',{exact:true})).toBeVisible();
  expect(checks).toBe(0);
  await expect(section.getByRole('link',{name:'GitHub 项目'})).toHaveAttribute('href','https://github.com/wyy667/workbuddy2API');
  await section.getByRole('button',{name:'检查更新'}).click();
  await expect(section.getByRole('status')).toContainText('发现新版本 v3.1.0');
  await expect(section.getByRole('link',{name:'查看更新说明'})).toBeVisible();
  expect(checks).toBe(1);
  await page.screenshot({path:'test-results/project-links-desktop.png'});
});

test('update states and mobile navigation', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  let status='error';
  await page.route('**/admin/api/project/check-update*',route=>route.fulfill({json:{ok:true,version:'3.0.1',latestVersion:'3.0.1',status,message:'无法获取 GitHub 版本信息',checkedAt:Date.now()}}));
  await page.goto('/admin?key=fixture');
  await page.getByRole('button',{name:'打开导航'}).click();
  const section=page.getByRole('region',{name:'workbuddy2API 项目信息'});
  await section.getByRole('button',{name:'检查更新'}).click();
  await expect(section.getByRole('status')).toContainText('无法获取');
  await expect(section.getByRole('status')).not.toContainText('最新版本');
  status='current';
  await section.getByRole('button',{name:'检查更新'}).click();
  await expect(section.getByRole('status')).toContainText('已是最新版本 v3.0.1');
  await page.screenshot({path:'test-results/project-links-mobile.png'});
});
