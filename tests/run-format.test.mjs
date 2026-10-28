import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ts from 'typescript';
const source=await readFile(new URL('../frontend/src/run-format.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {loggedCommand}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('logged commands preserve literal arguments and module invocation',()=>{
 assert.equal(loggedCommand({executable:'/usr/bin/python',program:'-m trainer.main',args:['--label','a b',"it's",'', '$HOME']}),"/usr/bin/python -m trainer.main --label 'a b' 'it'\\''s' '' '$HOME'");
 assert.equal(loggedCommand({executable:'/usr/bin/python',program:'<python with no main file>'}), '');
 assert.equal(loggedCommand({executable:'/usr/bin/python',codePath:'train.py'}), '');
});
