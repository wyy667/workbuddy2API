// Capture repository documentation with isolated, synthetic data only.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=new URL('../../docs/images/',import.meta.url);await mkdir(out,{recursive:true});
const port=8963,base=`http://127.0.0.1:${port}`;
const fixture=new URL('../tests/.docs-preview.fixture.mjs',import.meta.url);
await writeFile(fixture,(await readFile(new URL('../tests/fixture-server.mjs',import.meta.url),'utf8')).replace(/(const mapOrigin = \{ip:)'[^']*'/,"$1'203.0.113.10'").replaceAll('小懿的主账号','演示主账号'));
const server=spawn(process.execPath,[fileURLToPath(fixture)],{cwd:root,env:{...process.env,FIXTURE_PORT:String(port)},windowsHide:true,stdio:'pipe'});
let browser;
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),15000);server.stdout.on('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.once('exit',c=>reject(Error('Fixture exited '+c)));});
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
 await page.goto(base+'/admin?key=fixture#sec-overview');await page.locator('.sync-state').filter({hasText:'已同步'}).waitFor();await page.evaluate(()=>document.fonts.ready);
 async function capture(name){await page.waitForTimeout(500);await page.screenshot({path:fileURLToPath(new URL(name,out)),animations:'disabled'});}
 await capture('overview-light.png');
 await page.getByRole('button',{name:'切换夜间模式'}).click();await capture('overview-dark.png');
 const map=page.locator('.request-map');await map.scrollIntoViewIfNeeded();await map.locator('.map-route').first().waitFor();await page.waitForTimeout(500);await map.screenshot({path:fileURLToPath(new URL('request-map.png',out)),animations:'disabled'});
 await page.getByRole('button',{name:'切换日间模式'}).click();
 for(const id of ['usage','models']){await page.locator(`.nav-link[href="#sec-${id}"]`).click();await capture(id+'.png');}
 await page.locator('.nav-link[href="#sec-overview"]').click();await page.getByRole('button',{name:'选择日间配色'}).click();await page.getByRole('button',{name:'熔岩与深海'}).click();await capture('overview-lava.png');
 console.log('Captured six documentation screenshots using synthetic fixtures.');
}finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
