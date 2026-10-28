export function loggedCommand(environment: Record<string, any>) {
  const program=environment.program;
  if(typeof program!=='string'||program.startsWith('<')||typeof environment.executable!=='string')return '';
  const quote=(value:string)=>/^[A-Za-z0-9_./:=+-]+$/.test(value)?value:"'"+value.replaceAll("'","'\\''")+"'";
  return [environment.executable,...(program.startsWith('-m ')?['-m',program.slice(3)]:[program]),...(Array.isArray(environment.args)?environment.args:[])].map(value=>quote(String(value))).join(' ');
}
