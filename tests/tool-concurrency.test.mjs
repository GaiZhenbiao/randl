import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createServer} from '../backend/dist/server.js';
test('parallel shared-tool edits preserve every operation on the same view',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'randl-parallel-tools-')),server=await createServer(directory);t.after(async()=>{await server.app.close();await rm(directory,{recursive:true,force:true});});
 const view=await server.tools.execute('view_create',{name:'Parallel',project:'local/test'});
 const results=await Promise.all([
  server.tools.execute('panel_add',{view:view.id,plugin:'line',metric:'loss',title:'Loss'}),
  server.tools.execute('panel_add',{view:view.id,plugin:'line',metric:'reward',title:'Reward'}),
  server.tools.execute('runs_select',{view:view.id,visible:['local/test/a'],solo:['local/test/b']}),
  server.tools.execute('view_rename',{id:view.id,name:'Updated'}),
 ]);
 assert.equal(results.length,4);const saved=await server.db.call('view',view.id);assert.deepEqual(saved.body.panels.map(panel=>panel.metric),['loss','reward']);assert.equal(saved.name,'Updated');assert.deepEqual(saved.body.visible,['local/test/a']);assert.deepEqual(saved.body.solo,['local/test/b']);
 await assert.rejects(()=>server.tools.execute('view_save',{id:view.id,name:view.name,project:view.project,version:view.version,body:{...view.body,visible:[]}}),/changed in another session/);
});
