import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

describe('isolated HYOPU nested miniapp',()=>{
 it('loads local assets under /pilot-bot/ without loading the portal entry point',()=>{
  const html=readFileSync(new URL('../pilot-miniapp/index.html',import.meta.url),'utf8');
  expect(html).toContain('href="./style.css"');
  expect(html).toContain('src="./boot.js"');
  expect(html).not.toMatch(/(?:src|href)="\/(?:boot\.js|style\.css)"/);
 });
});
