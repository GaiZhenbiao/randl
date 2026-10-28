import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/section-layout.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { columnsFor, cardWidth } = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('section sizing matches measured W&B 3-to-2 column resize',()=>{
  assert.equal(columnsFor(1063,343,12),3);
  assert.equal(columnsFor(1063,523,12),2);
  assert.equal(cardWidth(1063,2),523.5);
});
test('sparse and narrow sections use the same legal columns for preview and layout',()=>{
  for(const width of [208,320,600,900,1440])for(const count of [1,2,12])for(const desired of [240,360,700]){
    const n=columnsFor(width,desired,count);
    assert.ok(n>=1&&n<=count&&n<=6);
    assert.ok(cardWidth(width,n)>=Math.min(width,240));
    assert.equal(columnsFor(width,cardWidth(width,n),count),n);
  }
});
