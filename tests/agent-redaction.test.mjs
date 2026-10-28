import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '../backend/dist/agent.js';
test('empty and short credentials never corrupt unrelated validation messages',async()=>{
 const credentials=new Map();let rejectLogin=false;
 const runtime={getProvider:id=>id==='known'?{auth:{apiKey:{login:()=>{}}}}:undefined,login:async(id,method,ui)=>{const key=await ui.prompt({type:'secret'});if(rejectLogin)throw Error('Provider rejected '+key);credentials.set(id,key);},logout:async id=>credentials.delete(id),getModel:()=>({provider:'known',id:'fixture'}),getAuth:async()=>({auth:{apiKey:credentials.get('known')}}),completeSimple:async()=>({stopReason:'error',errorMessage:'Expired test credential'})};
 const agent=new Agent({},'/tmp/randl-redaction-test',undefined,async()=>runtime);
 await assert.rejects(agent.credential('known','   '),{message:'Enter an API key'});
 await assert.rejects(agent.credential('missing','test'),{message:'Unknown model provider'});
 await agent.credential('known','e');
 await assert.rejects(agent.testConnection('known','fixture'),{message:'Model provider request failed.'});
 await agent.credential('known');
 await assert.rejects(agent.credential('missing','test'),{message:'Unknown model provider'});
 rejectLogin=true;
 await assert.rejects(agent.credential('known','synthetic-long-secret'),{message:'Provider rejected [redacted]'});
 await assert.rejects(agent.credential('missing','test'),{message:'Unknown model provider'});
});
