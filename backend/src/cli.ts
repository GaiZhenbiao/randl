#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join, dirname, basename } from 'node:path';
import { promises as fs, openAsBlob, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { contained } from './plugins.js';
const usage = `randl — rewards and losses\n\nrandl serve [--port 8742] [--data-dir .data] [--pi-agent-dir DIR] [--frontend-dir DIR] [--host 127.0.0.1] [--run-timeout 600] [--public-url https://randl.example.com] [--entity local]\n  --entity (or RANDL_ENTITY) is the W&B entity the SDK uses when wandb.init() names none.\nrandl status\nrandl runs [--project entity/project]\nrandl runs show --id entity/project/run\nrandl runs delete|restore|stop|add-tags|remove-tags --ids run1,run2 [--tags tag1,tag2]\nrandl projects list|show|create|rename|describe|archive|restore|delete --id entity/project [--name Name] [--description TEXT | --description-file PATH|-] [--confirm Name]\nrandl views list|get|create|rename|delete [--id ID] [--name Name] [--project entity/project]\nrandl panels add|update|remove --view ID [--id PANEL_ID] [--plugin line] [--metric loss] [--metrics loss,reward] [--expressions JSON]\n  --expressions takes a JSON array of computed metrics, e.g. '[{"name":"Rate","expression":"\${hits} / \${total}"}]'; [] or null on update removes them.\nrandl select --view ID [--visible run1,run2 | --visible-file PATH] [--solo run1,run2 | --solo-file PATH]\n  Files contain a JSON array of run IDs; use - to read one array from standard input. Up to 100,000 unique IDs per selection.\nrandl plugins list|install|update|enable|disable|remove [--source PATH_OR_GITHUB_URL] [--id ID]\nrandl artifacts list|show|log|download|alias [--id ID] [--path PATH] [--name NAME] [--project entity/project] [--type dataset] [--alias latest] [--output DIR]\nrandl tools\nrandl tool NAME --json '{"arguments":"value"}'\nrandl agent 'Manage my workspace' [--session ID] [--confirm-delete-project entity/project]\n\nGlobal: --url http://127.0.0.1:8742. Outputs JSON. Plugin enable runs trusted frontend code.\n`;
export async function main(argv = process.argv.slice(2)) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      port: { type: 'string' },
      host: { type: 'string' },
      'public-url': { type: 'string' },
      'data-dir': { type: 'string' },
      'pi-agent-dir':{type:'string'},
      'frontend-dir': { type: 'string' },
      'run-timeout': {type:'string'},
      entity: { type: 'string' },
      url: { type: 'string' },
      project: { type: 'string' },
      description: {type:'string'},
      'description-file': {type:'string'},
      confirm: {type:'string'},
      'confirm-delete-project': {type:'string',multiple:true},
      name: { type: 'string' },
      id: { type: 'string' },
      view: { type: 'string' },
      plugin: { type: 'string' },
      metric: { type: 'string' },
      metrics: { type: 'string' },
      expressions: { type: 'string' },
      visible: { type: 'string' },
      solo: { type: 'string' },
      'visible-file': { type: 'string' },
      'solo-file': { type: 'string' },
      ids: { type: 'string' },
      tags: { type: 'string' },
      source: { type: 'string' },
      json: { type: 'string' },
      session: { type: 'string' },
      path: { type: 'string' },
      type: { type: 'string' },
      alias: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (v.help || !p.length) {
    console.log(usage);
    return;
  }
  const base = v.url || process.env.RANDL_URL || 'http://127.0.0.1:8742';
  const request = async (path: string, body?: any, method?: string) => {
    const r = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(process.env.RANDL_API_KEY
          ? { Authorization: 'Bearer ' + process.env.RANDL_API_KEY }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = (await r.json()) as any;
    if (!r.ok) throw Error(result.error || JSON.stringify(result));
    return result;
  };
  const tool = (name: string, args: any) => request('/api/tools/' + name, args);
  const required = (key: keyof typeof v) => {
    const value = v[key];
    if (typeof value !== 'string' || !value) throw Error('--' + key + ' is required');
    return value;
  };
  const csv = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : []);
  const output = (value: any) => console.log(JSON.stringify(value, null, 2));
  const [command, action] = p;
  if (
    command === 'runs' &&
    ['delete', 'restore', 'stop', 'add-tags', 'remove-tags'].includes(action)
  ) {
    output(
      await tool('runs_update', {
        ids: csv(required('ids')),
        action,
        ...(v.tags ? { tags: csv(v.tags) } : {}),
      }),
    );
    return;
  }
  if (command === 'serve') {
    const { createServer } = await import('./server.js');
    const port = Number(v.port || 8742);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
    const { app } = await createServer(resolve(v['data-dir'] || '.data'), {
      port,
      piAgentDir:v['pi-agent-dir'],
      frontend: v['frontend-dir'],
      runTimeoutSeconds:v['run-timeout']===undefined?undefined:Number(v['run-timeout']),
      entity: v.entity || process.env.RANDL_ENTITY,
      host: v.host || '127.0.0.1',
      publicUrl: v['public-url'] || process.env.RANDL_PUBLIC_URL,
      apiKey: process.env.RANDL_API_KEY,
    });
    try {
      await app.listen({ host: v.host || '127.0.0.1', port });
    } catch (error) {
      await app.close();
      throw error;
    }
    console.log(`randl listening at http://127.0.0.1:${port}`);
    const close = async () => {
      await app.close();
      process.exit(0);
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
    return;
  }
  if (command === 'status') return output(await request('/api/health'));
  if(command==='runs'&&action==='show')return output(await tool('run_get',{id:required('id')}));
  if (command === 'runs')
    return output(await tool('runs_list', v.project ? { project: v.project } : {}));
  if (command === 'tools') return output(await request('/api/tools'));
  if (command === 'tool') return output(await tool(action, JSON.parse(v.json || '{}')));
  if (command === 'projects') {
    if (action === 'list') return output(await request('/api/projects'));
    const id=required('id');
    if(action==='show')return output(await tool('project_get',{id}));
    if(action==='create')return output(await tool('project_create',{id,name:required('name'),...(v.description!==undefined?{description:v.description}:{})}));
    if(action==='rename')return output(await tool('project_update',{id,name:required('name')}));
    if(action==='describe'){
      if(v.description!==undefined&&v['description-file']!==undefined)throw Error('Use either --description or --description-file');
      let description=v.description;
      if(v['description-file']==='-'){description='';for await(const chunk of process.stdin)description+=chunk.toString();}
      else if(v['description-file'])description=await fs.readFile(v['description-file'],'utf8');
      if(description===undefined)throw Error('--description or --description-file is required');
      return output(await tool('project_update',{id,description}));
    }
    if(action==='archive'||action==='restore')return output(await tool('project_update',{id,archived:action==='archive'}));
    if(action==='delete')return output(await tool('project_delete',{id,confirm:required('confirm')}));
    throw Error('Unknown project action');
  }
  if (command === 'views') {
    if (action === 'list') return output(await request('/api/views'));
    if (action === 'get') return output(await tool('view_get', { id: required('id') }));
    if (action === 'create')
      return output(
        await tool('view_create', { name: required('name'), project: v.project || '' }),
      );
    if (action === 'rename')
      return output(await tool('view_rename', { id: required('id'), name: required('name') }));
    if (action === 'delete')
      return output(
        await request('/api/views/' + encodeURIComponent(required('id')), undefined, 'DELETE'),
      );
    throw Error('Unknown view action');
  }
  if (command === 'panels') {
    const args: any = { view: required('view') };
    if (action !== 'add') args.id = required('id');
    for (const k of ['plugin', 'metric', 'name'] as const)
      if (v[k]) args[k === 'name' ? 'title' : k] = v[k];
    if (v.metrics) args.metrics = csv(v.metrics);
    if (v.expressions !== undefined) args.expressions = JSON.parse(v.expressions);
    if (action === 'add') args.plugin ||= 'line';
    if (!['add', 'update', 'remove'].includes(action)) throw Error('Unknown panel action');
    return output(await tool('panel_' + action, args));
  }
  if (command === 'select') {
    const args: any = { view: required('view') };
    if (v['visible-file'] === '-' && v['solo-file'] === '-')
      throw Error('Use standard input for one selection at a time.');
    for (const field of ['visible', 'solo'] as const) {
      const file = v[`${field}-file`];
      if (v[field] !== undefined && file !== undefined)
        throw Error(`Use either --${field} or --${field}-file.`);
      if (file !== undefined) {
        const source = `--${field}-file ${file === '-' ? '(standard input)' : file}`;
        let text: string;
        if (file === '-') {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          text = Buffer.concat(chunks).toString('utf8');
        } else
          text = await fs.readFile(file, 'utf8').catch((error) => {
            throw Error(
              error.code === 'ENOENT' ? `${source}: file not found` : `${source}: ${error.message}`,
            );
          });
        let ids: unknown;
        try {
          ids = JSON.parse(text);
        } catch (error) {
          throw Error(`${source}: expected a JSON array of run IDs (${(error as Error).message})`);
        }
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
          throw Error(`${source}: expected a JSON array of run IDs`);
        args[field] = ids;
      } else if (v[field] !== undefined) args[field] = csv(v[field]);
    }
    return output(await tool('runs_select', args));
  }
  if (command === 'plugins') {
    if (action === 'list') return output(await request('/api/plugins'));
    if (action === 'install')
      return output(await request('/api/plugins/install', { source: required('source') }));
    if (!['update', 'enable', 'disable', 'remove'].includes(action))
      throw Error('Unknown plugin action');
    return output(
      await request('/api/plugins/' + encodeURIComponent(required('id')) + '/' + action, {}),
    );
  }
  if (command === 'artifacts') {
    if (action === 'list') return output(await request('/api/artifacts'));
    if (action === 'show')
      return output(await request('/api/artifacts/' + encodeURIComponent(required('id'))));
    if (action === 'alias')
      return output(
        await request('/api/artifacts/' + encodeURIComponent(required('id')) + '/aliases', {
          aliases: csv(required('alias')),
        }),
      );
    if (action === 'log') {
      const project = required('project').split('/');
      if (project.length !== 2) throw Error('Project must be entity/project');
      const source = resolve(required('path'));
      const artifact = await request('/api/artifacts', {
        entity: project[0],
        project: project[1],
        name: required('name'),
        type: v.type || 'dataset',
      });
      const files: { path: string; name: string }[] = [];
      async function walk(path: string, prefix = '') {
        for (const entry of await fs.readdir(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw Error('Symlinks are not supported');
          if (entry.isDirectory()) await walk(join(path, entry.name), prefix + entry.name + '/');
          else if (entry.isFile())
            files.push({ path: join(path, entry.name), name: prefix + entry.name });
        }
      }
      if ((await fs.stat(source)).isDirectory()) await walk(source);
      else files.push({ path: source, name: basename(source) });
      for (const file of files) {
        const response = await fetch(
          base + `/storage/artifacts/${artifact.id}/files/${encodeURIComponent(file.name)}`,
          {
            method: 'PUT',
            headers: {
              'content-type': 'application/octet-stream',
              ...(process.env.RANDL_API_KEY
                ? { Authorization: 'Bearer ' + process.env.RANDL_API_KEY }
                : {}),
            },
            body: await openAsBlob(file.path),
          },
        );
        if (!response.ok) throw Error(await response.text());
      }
      const result = await request('/api/artifacts/' + artifact.id + '/commit', {});
      if (v.alias)
        await request('/api/artifacts/' + artifact.id + '/aliases', { aliases: csv(v.alias) });
      return output(result);
    }
    if (action === 'download') {
      const id = required('id'),
        target = resolve(required('output'));
      const { files } = await request('/api/artifacts/' + encodeURIComponent(id));
      for (const file of files) {
        const destination = resolve(target, file.name);
        if (!contained(target, destination)) throw Error('Unsafe artifact file path');
        await fs.mkdir(dirname(destination), { recursive: true });
        const response = await fetch(
          base + `/storage/artifacts/${id}/files/${encodeURIComponent(file.name)}`,
          {
            headers: process.env.RANDL_API_KEY
              ? { Authorization: 'Bearer ' + process.env.RANDL_API_KEY }
              : {},
          },
        );
        if (!response.ok) throw Error('Download failed');
        await pipeline(
          Readable.fromWeb(response.body as any),
          createWriteStream(destination, { flags: 'wx' }),
        );
      }
      return output({ directory: target, files: files.length });
    }
    throw Error('Unknown artifact action');
  }
  if (command === 'agent') {
    const message = p.slice(1).join(' ');
    if (!message) throw Error('Supply an agent prompt');
    const r = await fetch(base + '/api/agent/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.RANDL_API_KEY
          ? { Authorization: 'Bearer ' + process.env.RANDL_API_KEY }
          : {}),
      },
      body: JSON.stringify({ session: v.session || 'cli', message }),
    });
    if (!r.ok) throw Error(await r.text());
    const reader = r.body!.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if(event.type==='confirmation') {
          const allowed=(v['confirm-delete-project']||[]).includes(event.project.id);
          await request('/api/agent/confirm',{session:v.session||'cli',call:event.id,token:event.token,decision:allowed?'confirm':'decline',...(allowed?{name:event.project.name}:{reason:'cli-not-allowed'})});
          process.stderr.write(allowed?'Confirmed deleting project '+event.project.name+' ('+event.project.id+').\n':'Declined deleting project '+event.project.name+' ('+event.project.id+'). To allow it, rerun with --confirm-delete-project '+event.project.id+'.\n');
        }
        else if (event.type === 'text') process.stdout.write(event.text);
        else if (event.type === 'error') throw Error(event.text);
        else if (event.type === 'tool_start') process.stderr.write(`\n[${event.name}]\n`);
      }
    }
    process.stdout.write('\n');
    return;
  }
  throw Error('Unknown command; use randl --help');
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
