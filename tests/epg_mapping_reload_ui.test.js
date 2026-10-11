import {expect,test,vi} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function browser(storage=new Map()) {
  const nodes=new Map();
  const context=vm.createContext({currentUser:{id:1,is_admin:true},sessionGeneration:0,epgMappingWatch:null,epgMappingMode:'provider',
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetchJSON:vi.fn(),setLoadingState:vi.fn(),setEpgMappingJobProgress:vi.fn(),showToast:vi.fn(),
    loadEpgMappingChannels:vi.fn(async()=>{}),isAllProviderMappingSelected:()=>true,confirm:()=>true,
    t:(key,args)=>key+(args?JSON.stringify(args):''),setTimeout:fn=>{fn();return 1;},
    document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{checked:false,value:'1'});return nodes.get(id);}}
  });
  vm.runInContext(source.match(/(?:async )?function (?:mappingJobStorageKey|watchEpgMappingJob|resumeEpgMappingJob|pollMappingJob|handleAutoMap)\([^\n]*\) \{[\s\S]*?\n\}/g)?.join('\n')||'',context);
  return {context,storage};
}

test('a reload resumes the accepted mapping job without submitting another mapping request',async()=>{
  const {context,storage}=browser();let resolveStatus;
  context.fetchJSON.mockResolvedValueOnce({job_id:'mapping-1'}).mockImplementation(()=>new Promise(resolve=>{resolveStatus=resolve;}));
  const started=context.handleAutoMap();
  await vi.waitFor(()=>expect(storage.get('epg-mapping-job:admin:1')).toBe('mapping-1'));
  const reloaded=browser(storage).context;
  expect(typeof reloaded.resumeEpgMappingJob).toBe('function');
  reloaded.fetchJSON.mockResolvedValueOnce({status:'running',progress:42}).mockResolvedValueOnce({status:'completed',progress:100,matched:7});
  await reloaded.resumeEpgMappingJob();
  expect(reloaded.fetchJSON.mock.calls.map(([url])=>url)).toEqual(['/api/mapping/jobs/mapping-1','/api/mapping/jobs/mapping-1']);
  expect(reloaded.setEpgMappingJobProgress).toHaveBeenCalledWith(42,true);
  expect(reloaded.showToast).toHaveBeenCalledWith('autoMapSuccess{"count":7}','success');
  expect(storage.size).toBe(0);
  resolveStatus({status:'completed',matched:7});await started;
});

test('stored mapping jobs are scoped to the login identity and failures remain visible',async()=>{
  const {context,storage}=browser(new Map([['epg-mapping-job:admin:1','admin-job']]));
  context.currentUser={id:1,is_admin:false};
  await context.resumeEpgMappingJob();expect(context.fetchJSON).not.toHaveBeenCalled();
  context.currentUser={id:1,is_admin:true};
  context.fetchJSON.mockResolvedValue({status:'failed',progress:40,error:'matching failed'});
  await context.resumeEpgMappingJob();
  expect(context.showToast).toHaveBeenCalledWith('errorPrefix matching failed','danger');expect(storage.size).toBe(0);
});

test('logout or user change prevents an old poll from repainting or clearing another job',async()=>{
  const {context,storage}=browser(new Map([['epg-mapping-job:admin:1','old-job']]));let finish;
  context.fetchJSON.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=context.resumeEpgMappingJob();
  context.sessionGeneration++;context.currentUser=null;finish({status:'completed',matched:9});await pending;
  expect(context.showToast).not.toHaveBeenCalled();expect(context.loadEpgMappingChannels).not.toHaveBeenCalled();
  expect(storage.get('epg-mapping-job:admin:1')).toBe('old-job');
});

test('a new login without a stored job clears the old mapping spinner',async()=>{
  const {context}=browser();context.epgMappingWatch={jobId:'old-job',generation:-1};
  await context.resumeEpgMappingJob();
  expect(context.epgMappingWatch).toBe(null);
  expect(context.setLoadingState).toHaveBeenCalledWith(expect.anything(),false);
  expect(context.setEpgMappingJobProgress).toHaveBeenCalledWith(0,false);
});

test('storage failures do not retain another login spinner or clear a current watcher',async()=>{
  const {context}=browser();context.sessionStorage.getItem=()=>{throw new Error('disabled');};
  context.epgMappingWatch={jobId:'old-job',generation:-1};
  await context.resumeEpgMappingJob();expect(context.epgMappingWatch).toBe(null);
  const active={jobId:'current-job',generation:0};context.epgMappingWatch=active;
  await context.resumeEpgMappingJob();expect(context.epgMappingWatch).toBe(active);
});
