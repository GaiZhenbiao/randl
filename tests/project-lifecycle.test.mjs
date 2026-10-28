import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {Store} from '../backend/dist/database.js';
import {createServer} from '../backend/dist/server.js';
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'randl-project-')),store=new Store(directory);
  t.after(async()=>{store.db.close();await rm(directory,{recursive:true,force:true});});
  return {directory,store};
}
test('project create and partial updates preserve archives and reject invalid or vanished identities',async t=>{
  const {store}=await fixture(t);
  store.projectCreate({id:'local/project',name:'  Display  ',description:'原始描述'});
  store.projectUpdate({id:'local/project',archived:true});
  store.projectUpdate({id:'local/project',name:'Renamed'});
  let project=store.projectGet('local/project');
  assert.equal(project.name,'Renamed');assert.equal(project.archived,1);assert.equal(project.description,'原始描述');
  store.projectUpdate({id:'local/project',description:''});
  assert.equal(store.projectGet('local/project').name,'Renamed');
  assert.throws(()=>store.projectCreate({id:'local/project',name:'Duplicate'}),{code:'projects.errors.alreadyExists'});
  assert.throws(()=>store.projectUpdate({id:'local/project',name:'   '}),{code:'projects.errors.nameRequired'});
  assert.throws(()=>store.projectUpdate({id:'local/project',description:'a'.repeat(5001)}),{code:'projects.errors.descriptionTooLong'});
  assert.throws(()=>store.projectUpdate({id:'local/missing',name:'Recreate'}),{code:'projects.errors.notFound'});
  assert.throws(()=>store.projectUpdate({id:'local/project'}),{code:'projects.errors.emptyUpdate'});
});
test('project details count UTF8 logical bytes, deleted runs and reported runtime',async t=>{
 const {store,directory}=await fixture(t),a=store.upsert({entity:'local',project:'bytes',name:'one'}),b=store.upsert({entity:'local',project:'bytes',name:'trash'});
 store.ingest(a.id,{files:{'output.log':{offset:0,content:['中'.repeat(10)]}},complete:true});
 store.db.prepare("UPDATE runs SET state='finished',runtime=20,runtime_reported=1 WHERE id=?").run(a.id);
 store.runManage({ids:[b.id],action:'delete'});
 assert.equal(store.runFileWritten(a.id,3),true);
 store.ingest(a.id,{files:{'wandb-summary.json':{offset:0,content:['{"a":1}']}}});
 store.ingest(a.id,{files:{'wandb-summary.json':{offset:0,content:['{"a":12}']}}});
 const info=store.projectGet('local/bytes');
 assert.equal(info.storage.history,30+8);assert.equal(info.storage.files,3);assert.equal(info.totalCompute,20);
 assert.equal(info.counts.runs,2);assert.equal(info.counts.deletedRuns,1);assert.equal(info.states.finished,1);
 assert.equal(info.runningRuns,1);
 assert.throws(()=>store.projectDelete({id:'local/bytes',confirm:'bytes'}),{code:'projects.errors.runningRuns'});
 store.db.prepare('UPDATE runs SET heartbeat=?,runtime_at=? WHERE id=?').run(1,1,b.id);
 assert.deepEqual(store.staleRuns(Date.now()/1000,600),[b.id]);
 assert.equal(store.projectGet('local/bytes').runningRuns,0);
});
test('project deletion rechecks reviewed counts and isolates similar IDs and cross-project artifacts',async t=>{
 const {store}=await fixture(t);
 for(const project of ['a_','ax']) {
   const run=store.upsert({entity:'local',project,name:'one'});
   store.ingest(run.id,{files:{'wandb-history.jsonl':{offset:0,content:[JSON.stringify({_step:0,loss:1})]}},complete:true});
   store.viewSave({id:project,name:'view',project:'local/'+project,body:{panels:[],visible:[run.id],solo:[]}});
 }
 const owned=store.artifact('create',{entityName:'local',projectName:'a_',artifactCollectionName:'owned',clientID:'owned-client',aliases:['keep']});
 const external=store.artifact('create',{entityName:'local',projectName:'ax',artifactCollectionName:'external',clientID:'external-client'});
 store.artifact('file',{id:owned.id,name:'data',size:7,digest:'synthetic'});
 store.artifact('alias',{id:owned.id,aliases:['keep']});
 store.artifact('use',{artifactID:owned.id,entityName:'local',projectName:'ax',runName:'one'});
 store.artifact('use',{artifactID:external.id,entityName:'local',projectName:'a_',runName:'one'});
 const target='local/a_',info=store.projectGet(target);
 assert.equal(info.crossProjectUsers,1);assert.equal(info.artifactCollections,1);assert.equal(info.counts.artifactVersions,1);assert.equal(info.storage.artifacts,7);
 assert.throws(()=>store.projectDelete({id:target,confirm:'wrong'}),{code:'projects.errors.confirmName'});
 assert.throws(()=>store.projectDelete({id:target,confirm:'a_',expected:{...info.counts,views:99}}),{code:'projects.errors.changed'});
 const result=store.projectDelete({id:target,confirm:'a_',expected:info.counts});
 assert.equal(result.counts.runs,1);assert.equal(result.counts.views,1);
 assert.equal(store.artifact('get',{id:owned.id}),undefined);assert.ok(store.artifact('get',{id:external.id}));
 assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_usage').get().n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_files WHERE artifact_id=?').get(owned.id).n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_aliases WHERE artifact_id=?').get(owned.id).n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_clients WHERE artifact_id=?').get(owned.id).n,0);
 assert.equal(store.run('local/a_/one'),undefined);assert.ok(store.run('local/ax/one'));assert.ok(store.view('ax'));
 assert.equal(store.history.runKey('local/a_/one'),undefined);
 for(const table of ['point_tail','point_blocks','stream_tail','stream_blocks','media','run_metrics'])assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table} WHERE run NOT IN (SELECT key FROM run_keys)`).get().n,0);
 assert.throws(()=>store.projectUpdate({id:target,name:'Zombie'}),{code:'projects.errors.notFound'});
 store.upsert({entity:'local',project:'a_',name:'new'});
 assert.equal(store.projectGet(target).name,'a_');
});
test('shared project deletion removes local folders and audits only identity and counts',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'randl-project-server-')),server=await createServer(directory);
 t.after(async()=>{await server.app.close();await rm(directory,{recursive:true,force:true});});
 await server.tools.execute('project_create',{id:'local/delete',name:'Delete fixture'});
 const run=await server.db.call('upsert',{entity:'local',project:'delete',name:'one'});
 await server.db.call('ingest',run.id,{files:{},complete:true});
 const folder=join(directory,'files',createHash('sha256').update(run.id).digest('hex'));
 await mkdir(folder,{recursive:true});await writeFile(join(folder,'bytes'),'abc');
 const result=await server.tools.execute('project_delete',{id:'local/delete',confirm:'Delete fixture'});
 assert.equal(result.cleanupFailed,0);
 await assert.rejects(stat(folder),{code:'ENOENT'});
 const audit=await server.db.call('auditList');
 const deletion=audit.find(row=>row.tool==='project_delete');
 assert.deepEqual(JSON.parse(deletion.arguments),{id:'local/delete',counts:result.counts});
});

test('captured running states contribute source state counts without blocking project deletion',async t=>{
 const {store}=await fixture(t),run=store.upsert({entity:'local',project:'capture',name:'one'});
 store.db.prepare('UPDATE runs SET snapshot_at=? WHERE id=?').run(1700000000,run.id);
 const project=store.projectGet('local/capture');
 assert.equal(project.states.running,1);assert.equal(project.runningRuns,0);
 assert.equal(store.projectDelete({id:'local/capture',confirm:'capture',expected:project.counts}).counts.runs,1);
});

test('project list aggregates live runs, last activity and logical storage without disk walks',async t=>{
 const {store}=await fixture(t);
 store.projectCreate({id:'local/empty',name:'Empty'});
 const run=store.upsert({entity:'local',project:'listed',name:'one'}),trash=store.upsert({entity:'local',project:'listed',name:'two'});
 store.ingest(run.id,{files:{'output.log':{offset:0,content:['abc']}},complete:true});
 store.runManage({ids:[trash.id],action:'delete'});
 store.runFileWritten(trash.id,5);
 const artifact=store.artifact('create',{entityName:'local',projectName:'listed',artifactCollectionName:'data',clientID:'listed-client'});
 store.artifact('file',{id:artifact.id,name:'blob',size:11,digest:'synthetic'});
 const rows=Object.fromEntries(store.projects().map(row=>[row.id,row]));
 assert.equal(rows['local/empty'].runs,0);assert.equal(rows['local/empty'].storage,0);assert.equal(rows['local/empty'].lastActivity,null);
 assert.equal(rows['local/listed'].runs,1);
 assert.equal(rows['local/listed'].storage,3+5+11);
 assert.ok(rows['local/listed'].lastActivity>0);
 const details=store.projectGet('local/listed');
 assert.equal(details.storage.history+details.storage.files+details.storage.artifacts,rows['local/listed'].storage);
});

async function listening(t){
 const directory=await mkdtemp(join(tmpdir(),'randl-project-http-')),server=await createServer(directory);
 await server.app.listen({port:0,host:'127.0.0.1'});
 t.after(async()=>{await server.app.close();await rm(directory,{recursive:true,force:true});});
 const {port}=server.app.server.address();
 return {directory,server,origin:'http://127.0.0.1:'+port};
}
function heldPut(url){
 const request=http.request(url,{method:'PUT',headers:{'content-type':'application/octet-stream'}});
 const response=new Promise((resolve,reject)=>{request.on('response',res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});request.on('error',reject);});
 request.write('first-');
 return {response,finish:()=>request.end('last')};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,100));
test('a run file upload that finishes after project deletion is discarded and recreates nothing',async t=>{
 const {directory,server,origin}=await listening(t);
 await server.tools.execute('project_create',{id:'local/race',name:'Race'});
 const run=await server.db.call('upsert',{entity:'local',project:'race',name:'one'});
 await server.db.call('ingest',run.id,{files:{},complete:true});
 const upload=heldPut(origin+'/upload/local/race/one/media/late.bin');
 await settle();
 const removed=await server.tools.execute('project_delete',{id:'local/race',confirm:'Race'});
 assert.equal(removed.counts.runs,1);
 upload.finish();
 const response=await upload.response;
 assert.equal(response.status,404);
 assert.equal(JSON.parse(response.body).code,'RUN_NOT_FOUND');
 assert.equal(await server.db.call('run',run.id),undefined);
 assert.ok(!(await server.db.call('projects')).some(p=>p.id==='local/race'));
 await assert.rejects(stat(join(directory,'files',createHash('sha256').update(run.id).digest('hex'))),{code:'ENOENT'});
});
test('an artifact file upload in progress during project deletion leaves no blob or file row',async t=>{
 const {directory,server,origin}=await listening(t);
 await server.tools.execute('project_create',{id:'local/race',name:'Race'});
 const created=await (await fetch(origin+'/api/artifacts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity:'local',project:'race',name:'pending',type:'dataset'})})).json();
 const upload=heldPut(origin+'/storage/artifacts/'+created.id+'/files/blob.bin');
 await settle();
 const deletion=server.tools.execute('project_delete',{id:'local/race',confirm:'Race'});
 await settle();
 upload.finish();
 assert.notEqual((await upload.response).status,200);
 assert.equal((await deletion).counts.artifactVersions,1);
 assert.equal((await server.db.call('artifact','list',{})).length,0);
 const rows=await server.db.call('artifact','files',{id:created.id}).catch(()=>[]);
 assert.equal(rows.length,0);
 await assert.rejects(stat(join(directory,'artifacts',created.id)),{code:'ENOENT'});
});
test('deleting a project removes its uploaded artifact bytes and keeps artifacts of projects that used them',async t=>{
 const {directory,server,origin}=await listening(t);
 const json=async(path,body)=>{const r=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const artifacts={};
 for(const project of ['owner','consumer']){
  await server.tools.execute('project_create',{id:'local/'+project,name:project});
  const run=await server.db.call('upsert',{entity:'local',project,name:'run'});
  await server.db.call('ingest',run.id,{files:{},complete:true});
  const artifact=await json('/api/artifacts',{entity:'local',project,name:project+'-data',type:'dataset'});
  const put=await fetch(origin+'/storage/artifacts/'+artifact.id+'/files/data.bin',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'bytes of '+project});
  assert.equal(put.status,200);
  await json('/api/artifacts/'+artifact.id+'/commit',{});
  artifacts[project]=artifact.id;
 }
 await server.db.call('artifact','use',{artifactID:artifacts.owner,entityName:'local',projectName:'consumer',runName:'run'});
 await server.db.call('artifact','use',{artifactID:artifacts.consumer,entityName:'local',projectName:'owner',runName:'run'});
 const info=await server.tools.execute('project_get',{id:'local/owner'});
 assert.equal(info.crossProjectUsers,1);assert.equal(info.storage.artifacts,'bytes of owner'.length);
 await server.tools.execute('project_delete',{id:'local/owner',confirm:'owner',expected:info.counts});
 await assert.rejects(stat(join(directory,'artifacts',artifacts.owner)),{code:'ENOENT'});
 await stat(join(directory,'artifacts',artifacts.consumer));
 const kept=await (await fetch(origin+'/api/artifacts/'+artifacts.consumer)).json();
 assert.equal(kept.artifact.id,artifacts.consumer);assert.equal(kept.consumers.length,0);
 const download=await fetch(origin+'/storage/artifacts/'+artifacts.consumer+'/files/data.bin');
 assert.equal(await download.text(),'bytes of consumer');
 const consumerRun=await server.db.call('run','local/consumer/run');
 assert.ok(consumerRun);
 assert.equal((await server.db.call('artifact','relations',{run:'local/consumer/run'})).inputs.length,0);
});

test('recreating a deleted project cannot reuse its cached chart data or run key',async t=>{
 const {store}=await fixture(t);
 const create=value=>{const r=store.upsert({entity:'synthetic',project:'recreate',name:'run'});store.ingest(r.id,{files:{'wandb-history.jsonl':{offset:0,content:[JSON.stringify({_step:0,value})]}},complete:true});return r.id;};
 const id=create(1),oldKey=store.history.runKey(id),request={runs:[id],metrics:['value'],settings:{resolution:'full'}};
 assert.deepEqual(store.chart(request).series[0].values.value,[[0,1]]);
 store.projectDelete({id:'synthetic/recreate',confirm:'recreate'});
 create(9);assert.notEqual(store.history.runKey(id),oldKey);assert.deepEqual(store.chart(request).series[0].values.value,[[0,9]]);
});
