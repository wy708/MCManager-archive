import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';

// Drives the actual deployed UI. It does not intercept requests or fabricate states.
export async function restoreBrowser({base,username,password,serverId,directory}) {
  const browser=await chromium.launch(),page=await browser.newPage({baseURL:base,viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const region=page.getByRole('region',{name:'新目录恢复任务',exact:true}),dialog=page.getByRole('dialog');
  try {
    await page.goto('/');await expect(page.getByRole('button',{name:'进入工作台'})).toBeEnabled();await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'进入工作台'}).click();await expect(page.getByRole('heading',{name:'数据总览',exact:true})).toBeVisible();
    await page.getByLabel('统计范围').selectOption(serverId);await page.locator('.sidebar').getByRole('button',{name:'备份中心',exact:true}).click();await expect(region.getByRole('button',{name:'刷新恢复任务'})).toBeEnabled();
  }catch(error){await browser.close();throw error;}
  async function refresh(){await region.getByRole('button',{name:'刷新恢复任务'}).click();await expect(region.getByRole('button',{name:'刷新恢复任务'})).toBeEnabled();}
  return {
    async create(backupId,body){
      await page.locator(`[data-backup="${backupId}"]`).getByRole('button',{name:'恢复到新目录'}).click();await expect(dialog.getByLabel('恢复方式',{exact:true})).toBeFocused();await dialog.getByLabel('恢复方式',{exact:true}).selectOption(body.mode);await dialog.getByLabel('恢复执行端',{exact:true}).selectOption(body.hostId);await dialog.getByLabel('新目录名称',{exact:true}).fill(body.destinationName);await dialog.getByLabel('恢复备注',{exact:true}).fill(body.note);
      if(body.mode==='FORK'){await dialog.getByLabel('新一期名称',{exact:true}).fill(body.forkName);await dialog.getByLabel('新一期开服日期',{exact:true}).fill(body.forkStartDate);}
      await dialog.getByRole('button',{name:'下一步，核对方案'}).click();await expect(dialog.getByRole('heading',{name:'核对恢复方案'})).toBeVisible();await dialog.getByRole('checkbox',{name:/确认使用新目录/}).check();
      await page.screenshot({path:path.join(directory,'web-review-'+body.destinationName+'.png')});
      const response=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/api/backups/'+backupId+'/restores'));await dialog.getByRole('button',{name:'创建恢复任务',exact:true}).click();const result=await response;assert.equal(result.status(),201);const job=await result.json();assert.equal(job.mode,body.mode);assert.equal(job.hostId,body.hostId);assert.equal(job.destinationName,body.destinationName);await expect(dialog).not.toBeVisible();return job;
    },
    async ready(job){await refresh();const card=page.locator(`[data-restore="${job.id}"]`);await expect(card).toContainText('文件准备完成，尚未确认实际游玩',{timeout:20000});await card.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'web-ready-'+job.mode+'.png')});},
    async resolve(job,note){await refresh();const card=page.locator(`[data-restore="${job.id}"]`);await card.getByRole('button',{name:'核实处理结果'}).click();await dialog.getByLabel('核实结果',{exact:true}).selectOption('FAILED');await dialog.getByLabel('核实说明',{exact:true}).fill(note);await dialog.getByRole('button',{name:'保存核实结果'}).click();await expect(dialog).not.toBeVisible();await expect(card).toContainText('已失败');},
    async close(){try{assert.deepEqual(errors,[]);}finally{await browser.close();}},
  };
}
