import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withMapPython } from '../src/runtime-environment.mjs';

test('Windows Path casing survives the portable Python environment', () => {
  for (const name of ['Path','PATH','path']) {
    const source = { [name]: 'C:\\Windows;C:\\Windows\\System32', PythonHome:'old', PYTHONHOME:'duplicate', KEEP:'yes' };
    const actual = withMapPython(source,'E:\\运行环境\\python','E:\\游戏\\plugins');
    assert.equal(actual.PATH,'E:\\运行环境\\python'+path.delimiter+source[name]);
    assert.equal(Object.keys(actual).filter(key=>key.toUpperCase()==='PATH').length,1);
    assert.equal(Object.keys(actual).filter(key=>key.toUpperCase()==='PYTHONHOME').length,1);
    assert.equal(actual.KEEP,'yes'); assert.equal(source.PythonHome,'old');
    assert.ok(!actual.PATH.includes('undefined'));
  }
});
test('a real child can find PowerShell with a mixed-case Path', {skip:process.platform!=='win32'}, async () => {
  const source={...process.env};
  const key=Object.keys(source).find(name=>name.toUpperCase()==='PATH');
  const value=source[key];
  for (const name of Object.keys(source)) if(name.toUpperCase()==='PATH')delete source[name];
  source.Path=value;
  const env=withMapPython(source,'E:\\portable-python-test','E:\\plugin-test');
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Console]::Write('powershell-found')"],{env,windowsHide:true,timeout:15000});
  assert.equal(stdout,'powershell-found');
});
