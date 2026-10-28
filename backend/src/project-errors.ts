export const projectErrors:Record<string,string>={
  'projects.errors.invalidId':'Project ID must be entity/project.',
  'projects.errors.nameRequired':'Enter a project name.',
  'projects.errors.nameTooLong':'Project names can contain at most 200 characters.',
  'projects.errors.descriptionTooLong':'Descriptions can contain at most 5,000 characters.',
  'projects.errors.alreadyExists':'A project with ID {id} already exists.',
  'projects.errors.notFound':'Project not found',
  'projects.errors.emptyUpdate':'Choose a project field to update.',
  'projects.errors.confirmName':"Type the project's current name, {name}, exactly to confirm.",
  'projects.errors.runningRuns':'Stop or wait for {count} running runs before deleting this project.',
  'projects.errors.changed':'The project changed after you reviewed it. Review the new counts and confirm again.',
  'projects.confirmation.expired':'This confirmation is no longer pending.',
  'projects.confirmation.ownerOnly':'Only the tab that sent this request can confirm it.',
  'projects.confirmation.invalidDecision':'Choose confirm or decline.',
  'projects.confirmation.noRequest':'No active request is waiting for confirmation.',
};
export function projectError(code:string,params:Record<string,string|number>={},statusCode=400){
  const message=(projectErrors[code]||code).replace(/\{(\w+)\}/g,(token,key)=>String(params[key]??token));
  return Object.assign(Error(message),{code,params,statusCode});
}
