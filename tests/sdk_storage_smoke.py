"""Seal, finish and resume real SDK history, comparing exports with local SDK records."""
import json,os,tempfile,urllib.request,urllib.parse,struct
from pathlib import Path
import wandb
from wandb.proto import wandb_internal_pb2
base=os.environ['RANDL_URL'];key=os.environ.get('RANDL_API_KEY') or '0'*40
os.environ.update(WANDB_BASE_URL=base,WANDB_API_KEY=key,WANDB_SILENT='true')
def call(path,body=None):
    req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    return urllib.request.urlopen(req,timeout=60).read()
with tempfile.TemporaryDirectory(prefix='storage-sdk-') as directory:
    records=[];local=[]
    for start,count in [(0,3000),(3000,500)]:
        run=wandb.init(entity='synthetic',project='storage-seal',id='sealed',resume='must' if start else 'allow',dir=directory,settings=wandb.Settings(x_stats_sampling_interval=1))
        for step in range(start,start+count):run.log({f'metric/{j}':step/7+j for j in range(50)})
        path=Path(run.dir).parent/('run-'+run.id+'.wandb');run.finish()
        # SDK 0.30 writes a LevelDB-framed .wandb transaction log, not a JSONL file.
        data=path.read_bytes();assert data[:4]==b':W&B';offset=7;parts=[]
        while offset<len(data):
            if 32768-offset%32768<7:offset+=32768-offset%32768;continue
            _,length,kind=struct.unpack_from('<IHB',data,offset);offset+=7
            assert kind in (1,2,3,4)
            part=data[offset:offset+length];assert len(part)==length;offset+=length
            if kind in (1,2):parts=[]
            parts.append(part)
            if kind in (1,4):
                record=wandb_internal_pb2.Record();record.ParseFromString(b''.join(parts))
                if record.HasField('history'):local.append({item.key or '.'.join(item.nested_key):json.loads(item.value_json) for item in record.history.item})
    exported=call('/api/run-export?'+urllib.parse.urlencode({'run':'synthetic/storage-seal/sealed','format':'jsonl'})).decode()
    rows=[json.loads(line) for line in exported.splitlines() if line]
    assert len(rows)==3500,len(rows)
    assert [row['_step'] for row in rows]==list(range(3500))
    assert len(local)==3500,len(local)
    for actual,expected in zip(rows,local):
        assert actual==expected, (set(actual)^set(expected))
    chart=json.loads(call('/api/chart',{'runs':['synthetic/storage-seal/sealed'],'metrics':['metric/0'],'settings':{'resolution':'full'}}))
    assert len(chart['series'][0]['values']['metric/0'])==3500
    print(json.dumps({'sdk':wandb.__version__,'records':3500,'local_sdk_record_equality':True,'resume':True,'full_chart_points':3500}))
