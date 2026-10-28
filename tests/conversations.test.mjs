import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Store} from '../backend/dist/database.js';
test('conversation history persists, pages, reports changed turns, and replaces a branch',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'randl-conversations-'));let store=new Store(directory);
 try{
  store.chatEnsure({id:'c',title:'A conversation',project:'test/project'});store.chatCheckpoint({id:'c',entries:[{type:'session',id:'header'},{type:'model_change',id:'start'}]});const first=store.chatAppend({id:'c',prompt:'First'});first.response='Reply';first.status='completed';store.chatUpdate(first);const revision=store.chatGet({id:'c'}).conversation.revision;
  store.chatCheckpoint({id:'c',entries:[{type:'session',id:'header'},{type:'model_change',id:'start'},{type:'message',id:'after-first'}]});
  const second=store.chatAppend({id:'c',prompt:'Second'});second.status='failed';second.error='Request failed';store.chatUpdate(second);
  store.chatCheckpoint({id:'c',entries:[{type:'session',id:'header'},{type:'model_change',id:'start'},{type:'message',id:'after-first'},{type:'message',id:'after-second'}]});
  assert.deepEqual(store.chatGet({id:'c',since:revision}).turns.map(t=>t.prompt),['Second']);assert.deepEqual(store.chatGet({id:'c',before:second.seq}).turns.map(t=>t.prompt),['First']);
  store.chatRename({id:'c',title:'Renamed'});store.db.close();store=new Store(directory);
  assert.equal(store.chatList({search:'renamed'})[0].id,'c');assert.equal(store.chatGet({id:'c'}).turns[0].response,'Reply');
  assert.equal(store.chatReplace({id:'c',turn:second.id}),'Second');assert.equal(store.chatGet({id:'c'}).turns.length,1);assert.equal(store.chatEntries('c').at(-1).id,'after-first');
  store.chatDelete('c');assert.deepEqual(store.chatList(),[]);assert.equal(store.db.prepare('SELECT count(*) AS n FROM conversation_turns').get().n,0);
 }finally{store.db.close();await rm(directory,{recursive:true,force:true});}
});

test('tool positions survive SQLite reopen and branch replacement alongside legacy actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-conversation-order-'));
  let store = new Store(directory);
  try {
    store.chatEnsure({ id: 'ordered' });
    const first = store.chatAppend({ id: 'ordered', prompt: 'Inspect' });
    first.response = 'Inspecting 🧪.\n\nDone.';
    first.actions = [
      { id: 'legacy', name: 'workspace_snapshot', args: {}, status: 'completed' },
      {
        id: 'inspect',
        name: 'workspace_snapshot',
        args: {},
        status: 'completed',
        at: first.response.indexOf('Done.'),
      },
    ];
    first.status = 'completed';
    store.chatUpdate(first);
    const second = store.chatAppend({ id: 'ordered', prompt: 'Later' });
    second.response = 'Later reply';
    second.actions = [
      {
        id: 'later',
        name: 'workspace_snapshot',
        args: {},
        status: 'failed',
        at: 0,
        error: 'Fixture failure',
      },
    ];
    store.chatUpdate(second);
    store.db.close();
    store = new Store(directory);
    assert.deepEqual(
      store
        .chatGet({ id: 'ordered' })
        .turns.map(({ response, actions }) => ({ response, actions })),
      [first, second].map(({ response, actions }) => ({ response, actions })),
    );
    store.chatReplace({ id: 'ordered', turn: second.id });
    const turns = store.chatGet({ id: 'ordered' }).turns;
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].actions, first.actions);
    assert.deepEqual(store.chatAppend({ id: 'ordered', prompt: 'Replacement' }).actions, []);
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
