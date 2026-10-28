import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {managementError} from './management-errors.js';
const notFound=()=>managementError('CONVERSATION_NOT_FOUND','Conversation not found',{},404);
// `at` is the response length when the tool started, so text and tool calls keep their order.
export type ChatAction={id:string;name:string;args:Record<string,unknown>;status:'working'|'awaiting'|'declined'|'completed'|'failed';at?:number;result?:unknown;error?:string};
export type ChatTurn={id:string;conversation:string;seq:number;prompt:string;response:string;actions:ChatAction[];status:'working'|'completed'|'failed'|'stopped';error:string;errorCode:string;parentEntry:string|null;revision:number;created:number};
export class Conversations{
 constructor(readonly db:Database.Database){db.exec(`
 CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL DEFAULT '',project TEXT NOT NULL DEFAULT '',created REAL NOT NULL,updated REAL NOT NULL,revision INTEGER NOT NULL DEFAULT 0,entries TEXT NOT NULL DEFAULT '[]');
 CREATE TABLE IF NOT EXISTS conversation_turns(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,seq INTEGER NOT NULL,prompt TEXT NOT NULL,response TEXT NOT NULL DEFAULT '',actions TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'working',error TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',parent_entry TEXT,revision INTEGER NOT NULL,created REAL NOT NULL);
 CREATE INDEX IF NOT EXISTS conversation_order ON conversation_turns(conversation,seq);
 CREATE INDEX IF NOT EXISTS conversation_changes ON conversation_turns(conversation,revision);
 `);}
 private metadata(id:string){const row=this.db.prepare('SELECT id,title,project,created,updated,revision FROM conversations WHERE id=?').get(id) as Record<string,any>|undefined;if(!row)throw notFound();return row;}
 list({search='',offset=0}:{search?:string;offset?:number}={}){return this.db.prepare('SELECT id,title,project,created,updated,revision FROM conversations WHERE instr(lower(title),lower(?))>0 ORDER BY updated DESC,id LIMIT 50 OFFSET ?').all(search,offset);}
 get({id,before,since}:{id:string;before?:number;since?:number}){
  const conversation=this.metadata(id),rows=this.db.prepare(`SELECT * FROM conversation_turns WHERE conversation=? ${before===undefined?'':'AND seq<?'} ${since===undefined?'':'AND revision>?'} ORDER BY seq DESC LIMIT 50`).all(id,...(before===undefined?[]:[before]),...(since===undefined?[]:[since])) as (Omit<ChatTurn,'actions'|'parentEntry'|'errorCode'>&{actions:string;parent_entry:string|null;error_code:string})[];
  const turns=rows.reverse().map(({parent_entry,error_code,actions,...row})=>({...row,errorCode:error_code,parentEntry:parent_entry,actions:JSON.parse(actions)}));
  return {conversation,turns,hasEarlier:!!turns.length&&!!this.db.prepare('SELECT 1 FROM conversation_turns WHERE conversation=? AND seq<? LIMIT 1').get(id,turns[0].seq)};
 }
 ensure({id,title='',project=''}:{id:string;title?:string;project?:string}){const now=Date.now();this.db.prepare('INSERT OR IGNORE INTO conversations(id,title,project,created,updated) VALUES(?,?,?,?,?)').run(id,title,project,now,now);return this.metadata(id);}
 rename({id,title}:{id:string;title:string}){this.metadata(id);this.db.prepare('UPDATE conversations SET title=?,updated=? WHERE id=?').run(title.trim(),Date.now(),id);return this.metadata(id);}
 entries(id:string){const row=this.db.prepare('SELECT entries FROM conversations WHERE id=?').get(id) as {entries:string}|undefined;return row?JSON.parse(row.entries):[];}
 checkpoint({id,entries}:{id:string;entries:unknown[]}){this.db.prepare('UPDATE conversations SET entries=? WHERE id=?').run(JSON.stringify(entries),id);}
 append({id,prompt}:{id:string;prompt:string}){
  return this.db.transaction(()=>{const conversation=this.metadata(id),revision=conversation.revision+1,seq=(this.db.prepare('SELECT coalesce(max(seq),-1)+1 AS seq FROM conversation_turns WHERE conversation=?').get(id) as {seq:number}).seq;
   const parentEntry=this.entries(id).findLast((entry:any)=>entry.type!=='session'&&entry.id)?.id||null;
   const turn:ChatTurn={id:randomUUID(),conversation:id,seq,prompt,response:'',actions:[],status:'working',error:'',errorCode:'',parentEntry,revision,created:Date.now()};
   this.db.prepare('INSERT INTO conversation_turns(id,conversation,seq,prompt,parent_entry,revision,created) VALUES(?,?,?,?,?,?,?)').run(turn.id,id,seq,prompt,parentEntry,revision,turn.created);
   this.db.prepare('UPDATE conversations SET revision=?,updated=? WHERE id=?').run(revision,turn.created,id);return turn;
  })();
 }
 update(turn:ChatTurn){return this.db.transaction(()=>{const revision=this.metadata(turn.conversation).revision+1;this.db.prepare('UPDATE conversation_turns SET response=?,actions=?,status=?,error=?,error_code=?,parent_entry=?,revision=? WHERE id=? AND conversation=?').run(turn.response,JSON.stringify(turn.actions),turn.status,turn.error,turn.errorCode,turn.parentEntry,revision,turn.id,turn.conversation);this.db.prepare('UPDATE conversations SET revision=?,updated=? WHERE id=?').run(revision,Date.now(),turn.conversation);return revision;})();}
 replace({id,turn}:{id:string;turn:string}){
  return this.db.transaction(()=>{const original=this.db.prepare('SELECT seq,parent_entry,prompt FROM conversation_turns WHERE conversation=? AND id=?').get(id,turn) as {seq:number;parent_entry:string|null;prompt:string}|undefined;if(!original)throw notFound();
   const entries=this.entries(id),index=entries.findIndex((entry:any)=>entry.id===original.parent_entry);if(original.parent_entry&&index<0)throw managementError('AGENT_CONTEXT_UNAVAILABLE','The saved request context is unavailable. Start a new conversation.');const restored=index>=0?entries.slice(0,index+1):entries.filter((entry:any)=>entry.type==='session');
   this.db.prepare('DELETE FROM conversation_turns WHERE conversation=? AND seq>=?').run(id,original.seq);this.db.prepare('UPDATE conversations SET entries=?,revision=revision+1,updated=? WHERE id=?').run(JSON.stringify(restored),Date.now(),id);return original.prompt;
  })();
 }
 delete(id:string){return this.db.transaction(()=>{this.metadata(id);this.db.prepare('DELETE FROM conversation_turns WHERE conversation=?').run(id);this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);return {deleted:true};})();}
}
