"""A logging process survives a server outage; its exported steps remain exact."""
import os,time,json,urllib.request,urllib.parse
import wandb
base=os.environ['RANDL_URL'];os.environ.update(WANDB_BASE_URL=base,WANDB_API_KEY=os.environ.get('RANDL_API_KEY') or '0'*40,WANDB_SILENT='true')
count=int(os.environ.get('RANDL_STORAGE_RESTART_ROWS','1200'))
with wandb.init(entity='synthetic',project='storage-restart',id='logging',resume='allow') as run:
    for i in range(count):
        run.log({'value':i,'square':i*i})
        time.sleep(.1)
request=urllib.request.Request(base+'/api/run-export?'+urllib.parse.urlencode({'run':'synthetic/storage-restart/logging'}),headers={'Authorization':'Bearer '+os.environ['WANDB_API_KEY']})
rows=[json.loads(line) for line in urllib.request.urlopen(request,timeout=30).read().decode().splitlines()]
assert len(rows)==count,len(rows)
assert [r['_step'] for r in rows]==list(range(count))
assert [r['value'] for r in rows]==list(range(count))
print(json.dumps({'records':count,'restart_no_missing_or_duplicate_rows':True}),flush=True)
