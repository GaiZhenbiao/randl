import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectConfirmations} from '../backend/dist/agent-confirmations.js';
function fixture(){
 const response='Review deletion.',events=[],calls=[],turn={response,actions:[{id:'call',name:'project_delete',args:{id:'local/project'},status:'working',at:response.length}]};
 let pauses=0,resumes=0;
 const manager=new ProjectConfirmations({execute:async(name,args)=>{
  calls.push({name,args});
  if(name==='project_get')return {id:args.id,name:'Display',runningRuns:0,counts:{runs:1,deletedRuns:0,artifactVersions:0,views:1}};
  return {deleted:true};
 }});
 manager.begin({session:'owner',turn,emit:e=>events.push(e),pause:()=>pauses++,resume:()=>resumes++});
 return {manager,events,calls,turn,get timers(){return {pauses,resumes};}};
}
const ready=()=>new Promise(resolve=>setImmediate(resolve));
test('Pi delete waits for an owner token and typed displayed name then submits fixed reviewed counts',async()=>{
 const f=fixture(),request=f.manager.request('call',{id:'local/project'});
 await ready();const event=f.events[0];
 assert.equal(f.calls.length,1);assert.equal(f.turn.actions[0].status,'awaiting');
 assert.equal(f.turn.actions[0].at,f.turn.response.length);
 assert.ok(!JSON.stringify(f.turn).includes(event.token));
 assert.throws(()=>f.manager.decide({session:'owner',call:'call',token:'wrong',decision:'confirm',name:'Display'}),{statusCode:403});
 assert.throws(()=>f.manager.decide({session:'owner',call:'call',token:event.token,decision:'confirm',name:'different'}),{statusCode:400});
 assert.ok(f.manager.pending);
 f.manager.decide({session:'owner',call:'call',token:event.token,decision:'confirm',name:'Display'});
 assert.deepEqual(await request,{deleted:true});
 assert.equal(f.turn.actions[0].at,f.turn.response.length);
 assert.deepEqual(f.calls[1],{name:'project_delete',args:{id:'local/project',confirm:'Display',expected:{runs:1,deletedRuns:0,artifactVersions:0,views:1}}});
 assert.deepEqual(f.timers,{pauses:1,resumes:1});
 assert.throws(()=>f.manager.decide({session:'owner',call:'call',token:event.token,decision:'confirm',name:'Display'}),{statusCode:409});
});
test('declines and aborts never execute deletion and repeated requests do not produce another card',async()=>{
 const f=fixture(),request=f.manager.request('call',{id:'local/project'});
 await ready();const event=f.events[0];
 f.manager.decide({session:'owner',call:'call',token:event.token,decision:'decline'});
 assert.equal((await request).reason,'user');
 assert.equal((await f.manager.request('repeat',{id:'local/project'})).reason,'repeated');
 assert.equal(f.events.length,1);assert.equal(f.calls.filter(c=>c.name==='project_delete').length,0);
 const g=fixture(),controller=new AbortController(),pending=g.manager.request('call',{id:'local/project'},controller.signal);
 await ready();controller.abort();
 assert.equal((await pending).reason,'stopped');
 assert.equal(g.calls.filter(c=>c.name==='project_delete').length,0);
 assert.deepEqual(g.timers,{pauses:1,resumes:1});
});

import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createServer} from '../backend/dist/server.js';
const exec=promisify(execFile);
test('randl agent confirms only the project named by --confirm-delete-project and the token stays private',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'randl-cli-confirm-')),requests=[];
 const provider=createHTTPServer(async(request,response)=>{
  let body='';for await(const chunk of request)body+=chunk;
  const parsed=JSON.parse(body);requests.push(body);
  const last=parsed.messages.findLastIndex(m=>m.role==='user'),result=parsed.messages.slice(last).find(m=>m.role==='tool');
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta,finish=null)=>response.write(`data: ${JSON.stringify({id:'f',object:'chat.completion.chunk',created:1,model:'cli',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
  chunk({role:'assistant'});
  if(!result){chunk({tool_calls:[{index:0,id:'delete-'+last,type:'function',function:{name:'project_delete',arguments:JSON.stringify({id:'local/target'})}}]});chunk({},'tool_calls');}
  else{chunk({content:JSON.parse(result.content).declined?'Declined.':'Deleted.'});chunk({},'stop');}
  response.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const runtime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false,allowModelNetwork:false});
 runtime.registerProvider('cli-fixture',{name:'CLI provider',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:'openai-completions',apiKey:'local-fixture',models:[{id:'cli',name:'CLI fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
 const server=await createServer(join(directory,'data'));
 server.agent.runtimeFactory=async()=>runtime;
 await server.app.listen({port:0,host:'127.0.0.1'});
 t.after(async()=>{await server.app.close();await new Promise(resolve=>provider.close(resolve));await rm(directory,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.app.server.address().port;
 await server.db.call('settingSet','agent-model',{provider:'cli-fixture',id:'cli'});
 await server.tools.execute('project_create',{id:'local/target',name:'Target study'});
 const cli=(...args)=>exec(process.execPath,['backend/dist/cli.js','--url',base,'agent','Delete local/target.','--session','cli-confirm',...args],{timeout:60000});
 const declined=await cli('--confirm-delete-project','local/other');
 assert.match(declined.stderr,/Declined deleting project Target study \(local\/target\)\. To allow it, rerun with --confirm-delete-project local\/target\./);
 assert.match(declined.stdout,/Declined\./);
 assert.ok((await server.db.call('projects')).some(p=>p.id==='local/target'));
 const conversation=await (await fetch(base+'/api/conversations/cli-confirm')).json();
 const action=conversation.turns.at(-1).actions[0];
 assert.equal(action.status,'declined');assert.equal(action.result.reason,'cli-not-allowed');
 const confirmed=await cli('--confirm-delete-project','local/target');
 assert.match(confirmed.stderr,/Confirmed deleting project Target study \(local\/target\)\./);
 assert.match(confirmed.stdout,/Deleted\./);
 assert.ok(!(await server.db.call('projects')).some(p=>p.id==='local/target'));
 const stored=JSON.stringify(await (await fetch(base+'/api/conversations/cli-confirm')).json())+JSON.stringify(await server.db.call('auditList'))+requests.join('');
 assert.ok(!/"token"/.test(stored),'a confirmation token was persisted or sent to the model');
});
