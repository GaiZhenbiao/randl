import {projectError} from './project-errors.js';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {ChatTurn} from './conversations.js';
import type {Tools} from './tools.js';
type Row=Record<string,any>;
type Context={session:string;turn:ChatTurn;emit:(event:Row)=>void;pause:()=>void;resume:()=>void;declined:Set<string>};
export class ProjectConfirmations {
  context?:Context;
  pending?:{call:string;token:string;project:Row;resolve:(decision:Row)=>void};
  constructor(readonly tools:Tools){}
  begin(context:Omit<Context,'declined'>){this.context={...context,declined:new Set()};}
  end(){this.pending?.resolve({declined:true,reason:'stopped'});this.pending=undefined;this.context=undefined;}
  async request(call:string,args:Row,signal?:AbortSignal) {
    const context=this.context;
    if(!context)throw projectError('projects.confirmation.noRequest');
    const project=await this.tools.execute('project_get',{id:args.id});
    if(project.runningRuns)throw projectError('projects.errors.runningRuns',{count:project.runningRuns});
    const declined=(reason:string)=>({declined:true,reason,project:{id:project.id,name:project.name},message:reason==='repeated'?'The user already declined deleting this project in this request. Nothing changed. Do not ask again unless the user requests it.':'The user declined deleting this project. Nothing changed. Do not ask again unless the user requests it.'});
    if(context.declined.has(args.id))return declined('repeated');
    if(signal?.aborted)return declined('stopped');
    const action=context.turn.actions.find(item=>item.id===call);
    if(action){action.status='awaiting';action.result={project:{id:project.id,name:project.name},summary:project};}
    const token=randomBytes(16).toString('hex');
    context.pause();
    let abort:()=>void=()=>{};
    try {
      const decision=await new Promise<Row>(resolve=>{
        this.pending={call,token,project,resolve};
        abort=()=>resolve({declined:true,reason:'stopped'});
        signal?.addEventListener('abort',abort,{once:true});
        context.emit({type:'confirmation',id:call,token,tool:'project_delete',project:{id:project.id,name:project.name},summary:project});
      });
      this.pending=undefined;
      if(decision.declined){context.declined.add(args.id);return declined(decision.reason);}
      return await this.tools.execute('project_delete',{id:project.id,confirm:project.name,expected:project.counts});
    } finally {
      signal?.removeEventListener('abort',abort);
      this.pending=undefined;
      context.resume();
    }
  }
  decide(input:Row) {
    const pending=this.pending,context=this.context;
    if(!pending || !context || input.call!==pending.call || input.session!==context.session)throw projectError('projects.confirmation.expired',{},409);
    const submitted=Buffer.from(String(input.token)),expected=Buffer.from(pending.token);
    if(submitted.length!==expected.length || !timingSafeEqual(submitted,expected))throw projectError('projects.confirmation.ownerOnly',{},403);
    if(input.decision==='confirm' && input.name!==pending.project.name)throw projectError('projects.errors.confirmName',{name:pending.project.name});
    if(!['confirm','decline'].includes(input.decision))throw projectError('projects.confirmation.invalidDecision');
    this.pending=undefined;
    pending.resolve(input.decision==='decline'?{declined:true,reason:input.reason==='cli-not-allowed'?'cli-not-allowed':'user'}:{confirmed:true});
    return {accepted:true};
  }
}
