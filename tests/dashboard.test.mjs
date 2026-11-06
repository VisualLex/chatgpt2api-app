import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Small React stand-in good enough for the panel: hooks keep per-mount cells,
// effects are recorded but not executed, and mount() starts a brand-new
// instance the way DSH does when the user leaves and re-enters the panel.
function loadPanel(globals={}){
  let cells=[];
  let refs=[];
  let cursor=0;
  let effects=[];
  const React={
    Fragment:'fragment',
    createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial){
      const i=cursor++;
      if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;
      return [cells[i],v=>{cells[i]=typeof v==='function'?v(cells[i]):v}];
    },
    useRef(value){
      const i=cursor++;
      if(!(i in refs))refs[i]={current:value};
      return refs[i];
    },
    useCallback(fn){return fn},
    useMemo(fn){return fn()},
    useEffect(fn,deps){effects.push({fn,deps})},
    useLayoutEffect(){},
  };
  let moduleExports=null;
  const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{URL,URLSearchParams,AbortController,setTimeout,clearTimeout,...globals,__ModuleLoader__:{load:({factory})=>{moduleExports=factory(id=>{if(id!=='react')throw Error('Missing '+id);return React})}}});
  const slots=[];
  moduleExports.apply({slots:{inject(_name,cb){return cb()},register(def,component){slots.push({def,component});return()=>{}}}});
  const root=slots.find(x=>x.def.name==='main').component;
  function render(){cursor=0;effects=[];return root()}
  function mount(){cells=[];refs=[];return render()}
  function flatten(node){
    if(node==null||node===false)return [];
    if(Array.isArray(node))return node.flatMap(flatten);
    if(typeof node==='string'||typeof node==='number')return [node];
    if(typeof node.type==='function')return flatten(node.type({...node.props,children:node.children}));
    return [node,...node.children.flatMap(flatten)];
  }
  function text(tree){return flatten(tree).map(x=>typeof x==='object'?'':x).join('')}
  function find(tree,predicate){return flatten(tree).find(x=>x&&typeof x==='object'&&predicate(x))}
  return {mount,render,flatten,text,find,effects:()=>effects,api:moduleExports};
}

function clickButton(ui, label, tree=ui.render()){
  const button=ui.find(tree,node=>node.type==='button'&&ui.flatten(node).includes(label));
  assert.ok(button,`missing button: ${label}`);
  button.props.onClick();
  return ui.render();
}
function selectImportMode(ui,mode){
  const button=ui.find(ui.render(),node=>node.type==='button'&&node.props.role==='tab'&&node.props.id==='c2a-import-tab-'+mode);
  assert.ok(button);button.props.onClick();return ui.render();
}
function dialog(ui,tree=ui.render()){
  return ui.find(tree,node=>node.type==='dialog');
}
function findButton(ui,label,tree=ui.render()){
  const button=ui.find(tree,node=>node.type==='button'&&ui.text(node)===label);
  assert.ok(button,`missing button: ${label}`);return button;
}
function setCheckbox(ui,label,checked=true){
  const checkbox=ui.find(ui.render(),node=>node.type==='input'&&node.props['aria-label']===label);
  assert.ok(checkbox,`missing checkbox: ${label}`);
  checkbox.props.onChange({target:{checked}});return ui.render();
}
function setPageSize(ui,size){
  const select=ui.find(ui.render(),node=>node.type==='select'&&node.props['aria-label']==='每页账号数');
  assert.ok(select);select.props.onChange({target:{value:String(size)}});return ui.render();
}
async function poolFixture(count,{confirm=()=>true,deleteBatch,readAccounts}={}){
  let items=Array.from({length:count},(_,i)=>({ref:String(i+1).padStart(64,'0'),email:`account${i+1}@example.test`,type:'free',status:'normal',quota:10}));
  const requests=[],confirmations=[];
  const ui=loadPanel({confirm:message=>{confirmations.push(message);return confirm(message)},fetch:async(_url,options)=>{
    const request=JSON.parse(options.body);requests.push(request);
    if(request.path==='/local/credential-vault')return Response.json({items:[]});
    if(request.path==='/local/proxy')return Response.json({url:'',configured:false});
    if(request.path!=='/api/accounts')throw Error('Unexpected request: '+request.path);
    if(request.method==='DELETE'){
      const override=await deleteBatch?.(request,requests.filter(r=>r.method==='DELETE').length);
      if(override)return override;
      const refs=new Set(request.body.tokens),before=items.length;
      items=items.filter(item=>!refs.has(item.ref));
      return Response.json({ok:true,removed:before-items.length});
    }
    const response=await readAccounts?.(items,requests.filter(r=>r.path==='/api/accounts'&&r.method==='GET').length);
    return response||Response.json({items});
  }});
  ui.mount();clickButton(ui,'号池管理');clickButton(ui,'刷新账号列表');
  await new Promise(resolve=>setImmediate(resolve));
  return {ui,requests,confirmations,replaceItems:next=>{items=next}};
}

const TASK_ID='10000000-0000-4000-8000-000000000001';
const INPUT_FILE_ID='20000000-0000-4000-8000-000000000001';
const OUTPUT_FILE_ID='30000000-0000-4000-8000-000000000001';
const PIXEL_PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const flushPanel=()=>new Promise(resolve=>setImmediate(resolve));
function taskPanel(handle){
  const requests=[];
  const ui=loadPanel({
    File,atob,
    crypto:{randomUUID:()=>TASK_ID},
    setInterval:()=>1,clearInterval:()=>{},
    fetch:async(_url,options)=>{
      const request=JSON.parse(options.body);requests.push(request);
      const response=await handle(request);
      if(response===undefined)throw Error('Unexpected task request: '+request.method+' '+request.path);
      return response instanceof Response?response:Response.json(response);
    }
  });
  ui.mount();return {ui,requests};
}
function taskRecord(overrides={}){
  return {id:TASK_ID,type:'image',summary:'水彩猫图片',status:'succeeded',params:{prompt:'一只水彩橘猫',model:'gpt-image-2',resolution:'2k'},progress:{},result:{files:[]},files:[],createdAt:'2026-11-06T01:00:00.000Z',startedAt:'2026-11-06T01:00:01.000Z',finishedAt:'2026-11-06T01:00:12.000Z',error:'',...overrides};
}
async function showTaskHistory(ui){
  clickButton(ui,'历史任务');await findButton(ui,'刷新任务').props.onClick();return ui.render();
}
function setTaskField(ui,label,value){
  const input=ui.find(ui.render(),node=>['select','input','textarea'].includes(node.type)&&node.props['aria-label']===label);
  assert.ok(input,`missing field: ${label}`);input.props.onChange({target:{value}});return ui.render();
}
async function runHistoryEffect(ui){
  const effect=ui.effects().find(entry=>entry.deps?.length>3&&entry.deps[0]==='history');
  assert.ok(effect,'history updates reload the matching task page');
  const cleanup=effect.fn();await flushPanel();cleanup?.();return ui.render();
}

function assertTheme(ui,theme,tree=ui.render()){
  const root=ui.find(tree,node=>node.props.className?.split(/\s+/).includes('c2a-root'));
  assert.ok(root,'dashboard root is present');
  assert.equal(root.props['data-theme'],theme);
  const target=theme==='dark'?'浅色':'暗色';
  const button=ui.find(tree,node=>node.type==='button'&&node.props['aria-label']===`切换为${target}主题`);
  assert.ok(button,'theme control names the mode it will switch to');
  return button;
}

function overviewFixture(handle=()=>undefined,health={healthy:true,baseUrl:'http://127.0.0.1:39000',accounts:{total:23,active:17,limited:2,abnormal:3,disabled:1,total_quota:312}},confirm){
  const requests=[],copied=[],timers=new Map();let timerId=0;
  const ui=loadPanel({
    confirm,
    setInterval:()=>1,clearInterval:()=>{},
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id},
    clearTimeout:id=>timers.delete(id),
    navigator:{clipboard:{writeText:async value=>{copied.push(value)}}},
    fetch:async(_url,options)=>{
      const request=JSON.parse(options.body);requests.push(request);
      const response=request.path==='/health?format=json'
        ?await (typeof health==='function'?health(request):health)
        :await handle(request);
      if(response!==undefined)return response instanceof Response?response:Response.json(response);
      if(request.path.startsWith('/local/tasks?'))return Response.json({items:[],total:0,page:1,pageSize:5,pageCount:1});
      throw Error('Unexpected overview request: '+request.path);
    },
  });
  ui.mount();
  return {ui,requests,copied,timers};
}
async function loadOverviewHealth(ui){
  ui.render();
  const effect=ui.effects().find(entry=>entry.deps?.length===1&&typeof entry.deps[0]==='number');
  assert.ok(effect,'health polling is registered');
  const cleanup=effect.fn();await flushPanel();cleanup?.();return ui.render();
}
async function runOverviewEffect(ui){
  ui.render();
  const effect=ui.effects().find(entry=>entry.deps?.length===2&&entry.deps[0]==='overview');
  assert.ok(effect,'the overview has its own task polling');
  const cleanup=effect.fn();await flushPanel();return cleanup;
}
function overviewMetric(ui,label,tree=ui.render()){
  const metric=ui.find(tree,node=>node.type==='article'&&node.props.className?.split(/\s+/).includes('c2a-overview-stat')&&ui.text(node).startsWith(label));
  assert.ok(metric,'missing overview metric: '+label);
  return ui.text(ui.find(metric,node=>node.type==='strong'));
}
function overviewServiceLabel(ui,tree=ui.render()){
  const head=ui.find(tree,node=>node.props.className==='c2a-overview-head');
  assert.ok(head,'the overview has a status header');
  const chip=ui.find(head,node=>node.props.className?.split(/\s+/).includes('c2a-chip'));
  assert.ok(chip,'the service status has its own chip');
  return ui.text(chip);
}

test('overview distinguishes service checks, missing accounts, unhealthy pools, and ready pools',async()=>{
  for(const [health,label,onboarding] of [
    [{healthy:false,accounts:{total:0,active:0}},'等待导入账号',true],
    [{healthy:false,accounts:{total:3,active:0}},'暂无可用账号',false],
    [{healthy:true,accounts:{total:3,active:3}},'号池可用',false],
  ]){
    const {ui}=overviewFixture(undefined,health);
    assert.equal(overviewServiceLabel(ui),'正在检查服务');
    const tree=await loadOverviewHealth(ui);
    assert.equal(overviewServiceLabel(ui,tree),label);
    const head=ui.find(tree,node=>node.props.className==='c2a-overview-head');
    const hasAction=label=>!!ui.find(head,node=>node.type==='button'&&ui.text(node)===label);
    assert.equal(hasAction('检查账号池'),!health.healthy&&health.accounts.total>0);
    assert.equal(hasAction('查看运行设置'),false);
    assert.equal(!!ui.find(tree,node=>node.props.className==='c2a-onboarding'),onboarding);
    assert.equal(ui.flatten(tree).filter(node=>node?.type==='article'&&node.props?.className?.split(/\s+/).includes('c2a-overview-stat')).length,4);
  }
  const {ui}=overviewFixture(undefined,()=>{throw Error('后端暂时不可达')});
  const tree=await loadOverviewHealth(ui);
  assert.equal(overviewServiceLabel(ui,tree),'服务连接异常');
  const head=ui.find(tree,node=>node.props.className==='c2a-overview-head');
  assert.ok(findButton(ui,'查看运行设置',head));
  assert.equal(ui.find(head,node=>node.type==='button'&&ui.text(node)==='检查账号池'),undefined);
});

test('refreshing a failed health check does not report an old healthy snapshot as available',async()=>{
  let unreachable=false;
  const {ui}=overviewFixture(undefined,()=>{
    if(unreachable)throw Error('后端连接已中断');
    return {healthy:true,accounts:{total:3,active:3,total_quota:10}};
  });
  assert.equal(overviewServiceLabel(ui,await loadOverviewHealth(ui)),'号池可用');
  unreachable=true;
  assert.equal(overviewServiceLabel(ui,await loadOverviewHealth(ui)),'服务连接异常');
  const retrying=clickButton(ui,'刷新');
  assert.ok(['服务连接异常','正在检查服务'].includes(overviewServiceLabel(ui,retrying)),'availability must wait for a successful new health check');
});

test('overview copies the configured API address and keeps key creation on the API page',async()=>{
  const {ui,copied,requests}=overviewFixture();
  await loadOverviewHealth(ui);
  assert.match(ui.text(ui.render()),/http:\/\/127\.0\.0\.1:39000\/v1/);
  clickButton(ui,'复制地址');await flushPanel();
  assert.deepEqual(copied,['http://127.0.0.1:39000/v1']);
  assert.match(ui.text(ui.render()),/已复制/);
  assert.equal(ui.find(ui.render(),node=>node.type==='input'&&node.props['aria-label']==='自定义密钥（可选）'),undefined);
  clickButton(ui,'管理 API Key');
  assert.match(ui.text(ui.render()),/创建第三方调用 API Key/);
  assert.equal(requests.filter(request=>request.method==='POST').length,0,'opening key management does not create a key');
});

test('first-use steps open account import, quota checks, and API setup without submitting work',async()=>{
  const {ui,requests}=overviewFixture(undefined,{healthy:false,accounts:{total:0,active:0}});
  await loadOverviewHealth(ui);
  const step=label=>{
    const onboarding=ui.find(ui.render(),node=>node.props.className==='c2a-onboarding');
    assert.ok(onboarding);findButton(ui,label,onboarding).props.onClick();return ui.render();
  };
  let tree=step('导入账号');
  assert.match(ui.text(dialog(ui,tree)),/导入账号/);
  assert.ok(ui.find(dialog(ui,tree),node=>node.type==='input'&&node.props['aria-label']==='账号 access_token'));
  clickButton(ui,'总览');tree=step('检查额度');
  assert.match(ui.text(dialog(ui,tree)),/代理与额度/);
  assert.equal(findButton(ui,'全部刷新额度',dialog(ui,tree)).props.disabled,true,'an empty pool cannot start a quota refresh');
  clickButton(ui,'总览');tree=step('创建密钥');
  assert.equal(dialog(ui,tree),undefined);
  assert.match(ui.text(tree),/创建第三方调用 API Key/);
  assert.equal(requests.filter(request=>request.method!=='GET').length,0,'setup links only navigate until the user submits a form');
});

test('overview uses server task totals and opens a recent task without submitting another task',async()=>{
  const jobs=Array.from({length:5},(_,i)=>taskRecord({id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,summary:'最近图片 '+(i+1)}));
  const {ui,requests}=overviewFixture(request=>{
    const url=new URL(request.path,'http://localhost');
    if(url.pathname==='/local/tasks'&&url.searchParams.get('status'))return {items:[jobs[0]],total:url.searchParams.get('status')==='queued'?123:17};
    if(url.pathname==='/local/tasks')return {items:jobs,total:800,page:1,pageSize:5,pageCount:160};
    if(request.path==='/local/tasks/'+jobs[0].id)return {task:jobs[0]};
  });
  await loadOverviewHealth(ui);const cleanup=await runOverviewEffect(ui);cleanup?.();
  const tree=ui.render();
  assert.equal(overviewMetric(ui,'进行中任务',tree),'140');
  assert.equal(overviewMetric(ui,'需关注账号',tree),'6');
  const rows=ui.flatten(tree).filter(node=>node?.type==='button'&&node.props?.className==='c2a-recent-task');
  assert.equal(rows.length,5);
  assert.match(ui.text(rows[0]),/最近图片 1/);
  rows[0].props.onClick();await flushPanel();
  assert.match(ui.text(dialog(ui)),/任务详情/);
  assert.match(ui.text(dialog(ui)),/一只水彩橘猫/);
  assert.ok(requests.some(request=>request.path==='/local/tasks/'+jobs[0].id));
  assert.equal(requests.filter(request=>request.method==='POST').length,0);
});

test('overview task requests stay independent of history filters and preserve them on return',async()=>{
  const {ui,requests}=overviewFixture();
  clickButton(ui,'历史任务');setTaskField(ui,'任务类型','api_request');setTaskField(ui,'任务状态','failed');
  await runHistoryEffect(ui);
  clickButton(ui,'总览');requests.length=0;
  const cleanup=await runOverviewEffect(ui);cleanup?.();
  assert.equal(requests.length,3);
  for(const request of requests){
    const url=new URL(request.path,'http://localhost');
    assert.equal(url.pathname,'/local/tasks');
    assert.equal(url.searchParams.has('type'),false);
    assert.equal(url.searchParams.has('from'),false);
    assert.equal(url.searchParams.has('to'),false);
    if(url.searchParams.has('status'))assert.ok(['queued','running'].includes(url.searchParams.get('status')));
    else assert.equal(url.searchParams.get('pageSize'),'5');
  }
  clickButton(ui,'历史任务');
  const tree=ui.render();
  assert.equal(ui.find(tree,node=>node.type==='select'&&node.props['aria-label']==='任务类型').props.value,'api_request');
  assert.equal(ui.find(tree,node=>node.type==='select'&&node.props['aria-label']==='任务状态').props.value,'failed');
});

test('overview retains recent results on refresh errors and marks unavailable counts as unknown',async()=>{
  let failed=false;
  const {ui}=overviewFixture(request=>{
    if(failed)throw Error('任务服务暂不可达');
    const url=new URL(request.path,'http://localhost');
    return url.searchParams.has('status')?{items:[],total:9}:{items:[taskRecord({summary:'已保存的最近任务'})],total:1};
  });
  let cleanup=await runOverviewEffect(ui);cleanup?.();
  assert.equal(overviewMetric(ui,'进行中任务'),'18');
  failed=true;cleanup=await runOverviewEffect(ui);cleanup?.();
  const tree=ui.render();
  assert.match(ui.text(tree),/已保存的最近任务/);
  assert.match(ui.text(tree),/任务服务暂不可达/);
  assert.ok(ui.find(tree,node=>node.props.role==='alert'));
  assert.equal(overviewMetric(ui,'进行中任务',tree),'—','a failed count query is not displayed as zero or as a current old count');
});

test('a partial overview query failure does not discard independently available task data',async()=>{
  for(const failedPart of ['recent','queued']){
    const {ui}=overviewFixture(request=>{
      const status=new URL(request.path,'http://localhost').searchParams.get('status');
      if((failedPart==='recent'&&!status)||status===failedPart)throw Error('部分任务查询失败');
      return status?{items:[],total:6}:{items:[taskRecord({summary:'独立可用的最近任务'})],total:1};
    });
    const cleanup=await runOverviewEffect(ui);cleanup?.();
    const tree=ui.render();
    assert.match(ui.text(tree),/部分任务查询失败/);
    if(failedPart==='recent'){
      assert.equal(overviewMetric(ui,'进行中任务',tree),'12');
      assert.doesNotMatch(ui.text(tree),/还没有任务记录/,'a failed recent query is not an empty task history');
    }else{
      assert.equal(overviewMetric(ui,'进行中任务',tree),'—');
      assert.match(ui.text(tree),/独立可用的最近任务/);
    }
  }
});

test('a late overview response cannot replace a newer snapshot after polling cleanup',async()=>{
  let releaseOld,first=true;
  const {ui}=overviewFixture(request=>{
    const url=new URL(request.path,'http://localhost');
    if(url.searchParams.has('status'))return {items:[],total:0};
    if(first){first=false;return new Promise(resolve=>{releaseOld=()=>resolve({items:[taskRecord({summary:'迟到的旧任务'})],total:1})})}
    return {items:[taskRecord({summary:'新的任务快照'})],total:1};
  });
  const stopOld=await runOverviewEffect(ui);stopOld?.();
  const stopNew=await runOverviewEffect(ui);stopNew?.();
  releaseOld();await flushPanel();
  const tree=ui.render();
  assert.match(ui.text(tree),/新的任务快照/);
  assert.doesNotMatch(ui.text(tree),/迟到的旧任务/);
});

test('overview quota refresh submits the existing task before visiting accounts and updates after completion',async()=>{
  const confirmations=[];let quota=312;
  const {ui,requests}=overviewFixture(request=>{
    if(request.path==='/local/tasks'&&request.method==='POST')return {task:taskRecord({type:'quota',status:'queued'})};
    if(request.path==='/local/tasks/'+TASK_ID){quota=420;return {task:taskRecord({type:'quota',result:{processed:23,total:23,errorCount:0}})}}
    if(request.path==='/api/accounts')return {items:[{ref:'account-ref',quota:420}]};
  },()=>({healthy:true,accounts:{total:23,active:23,total_quota:quota}}),message=>{confirmations.push(message);return true});
  await loadOverviewHealth(ui);
  const card=ui.find(ui.render(),node=>node.type==='article'&&ui.text(node).startsWith('剩余额度'));
  const refresh=findButton(ui,'刷新',card);
  assert.equal(refresh.props.disabled,false);
  assert.equal(requests.some(request=>request.path==='/api/accounts'),false,'the homepage does not need to load account credentials');
  const first=refresh.props.onClick(),second=refresh.props.onClick();
  await Promise.all([first,second]);
  const submitted=requests.filter(request=>request.path==='/local/tasks'&&request.method==='POST');
  assert.equal(submitted.length,1,'repeated clicks cannot submit duplicate quota work');
  assert.equal(submitted[0].body.type,'quota');
  assert.deepEqual(submitted[0].body.params,{});
  assert.equal(confirmations.length,1);
  assert.match(confirmations[0],/全部 23 个账号/);
  assert.equal(findButton(ui,'刷新中…').props.disabled,true);
  const polling=ui.effects().find(entry=>entry.deps?.length===3&&entry.deps[2]===TASK_ID);
  assert.ok(polling,'quota refresh uses the existing background task tracker');
  const cleanup=polling.fn();await flushPanel();cleanup?.();
  await loadOverviewHealth(ui);
  assert.equal(overviewMetric(ui,'剩余额度'),'420');
  assert.equal(ui.find(ui.render(),node=>node.type==='button'&&node.props.className?.includes('c2a-quota-refresh')).props.disabled,false);
});

test('overview quota refresh handles cancellation and submission errors without leaving a busy button',async()=>{
  for(const confirmed of [false,true]){
    const {ui,requests}=overviewFixture(request=>{
      if(request.path==='/local/tasks'&&request.method==='POST')throw Error('额度刷新提交失败');
    },undefined,()=>confirmed);
    await loadOverviewHealth(ui);
    const refresh=ui.find(ui.render(),node=>node.type==='button'&&node.props.className?.includes('c2a-quota-refresh'));
    await refresh.props.onClick();
    const tree=ui.render();
    assert.equal(ui.find(tree,node=>node.type==='button'&&node.props.className?.includes('c2a-quota-refresh')).props.disabled,false);
    assert.equal(requests.filter(request=>request.method==='POST').length,confirmed?1:0);
    if(confirmed)assert.match(ui.text(ui.find(tree,node=>node.props.className==='c2a-quota-error'&&node.props.role==='alert')),/额度刷新提交失败/);
  }
  const {ui}=overviewFixture(undefined,{healthy:false,accounts:{total:0,active:0}});
  const refresh=()=>ui.find(ui.render(),node=>node.type==='button'&&node.props.className?.includes('c2a-quota-refresh'));
  assert.equal(refresh().props.disabled,true,'refresh waits for the backend status');
  await loadOverviewHealth(ui);
  assert.equal(refresh().props.disabled,true,'an empty account pool cannot be refreshed');
});

test('theme defaults to dark, switches persistently, and survives a panel remount',()=>{
  const preferences=new Map(),writes=[];
  const ui=loadPanel({localStorage:{
    getItem:key=>preferences.get(key)??null,
    setItem:(key,value)=>{preferences.set(key,value);writes.push([key,value])},
  }});
  assertTheme(ui,'dark',ui.mount()).props.onClick();
  assertTheme(ui,'light');
  assert.equal(preferences.get('chatgpt2api.theme'),'light');
  assert.deepEqual(writes.at(-1),['chatgpt2api.theme','light']);
  assertTheme(ui,'light',ui.mount()).props.onClick();
  assertTheme(ui,'dark');
  assert.equal(preferences.get('chatgpt2api.theme'),'dark');
});

test('saved light theme is restored and unrecognized preferences fall back to dark',()=>{
  for(const [stored,expected] of [['light','light'],['dark','dark'],['terminal','dark']]){
    const ui=loadPanel({localStorage:{getItem:key=>key==='chatgpt2api.theme'?stored:null,setItem(){}}});
    assertTheme(ui,expected,ui.mount());
  }
});

test('theme can still be switched when browser preference storage is unavailable',()=>{
  const ui=loadPanel({localStorage:{
    getItem(){throw new Error('storage access denied')},
    setItem(){throw new Error('storage quota exceeded')},
  }});
  assertTheme(ui,'dark',ui.mount()).props.onClick();
  assertTheme(ui,'light').props.onClick();
  assertTheme(ui,'dark');
});

test('image generation submits a durable task and returns while the task is still queued',async()=>{
  const {ui,requests}=taskPanel(request=>request.path==='/local/tasks'&&request.method==='POST'?{task:taskRecord({status:'queued',startedAt:null,finishedAt:null,result:null})}:undefined);
  clickButton(ui,'图片生成');setTaskField(ui,'提示词','一幅安静的山水画');
  await findButton(ui,'生成一张图片').props.onClick();
  assert.equal(requests.length,1,'submitting does not wait for or poll image completion');
  const request=requests[0];
  assert.equal(request.path,'/local/tasks');assert.equal(request.method,'POST');
  assert.equal(request.body.type,'image');assert.equal(request.body.requestId,TASK_ID);
  assert.equal(request.body.params.prompt,'一幅安静的山水画');
  const tree=ui.render();
  assert.ok(findButton(ui,'任务排队中…'));
  assert.match(ui.text(tree),/可关闭网页/);
  assert.ok(findButton(ui,'查看任务'));
});

test('history filters and pagination load the selected server-side task page',async()=>{
  const jobs=Array.from({length:12},(_,i)=>taskRecord({id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,summary:'历史图片 '+(i+1)}));
  const {ui,requests}=taskPanel(request=>{
    const url=new URL(request.path,'http://localhost');
    if(url.pathname!=='/local/tasks'||request.method!=='GET')return undefined;
    const page=Number(url.searchParams.get('page')||1),pageSize=Number(url.searchParams.get('pageSize')||10);
    return {items:jobs.slice((page-1)*pageSize,page*pageSize),total:jobs.length,page,pageSize,pageCount:Math.ceil(jobs.length/pageSize)};
  });
  let tree=await showTaskHistory(ui);
  assert.match(ui.text(tree),/共 12 条任务 · 第 1 \/ 2 页/);
  assert.equal(findButton(ui,'上一页').props.disabled,true);
  clickButton(ui,'下一页');await runHistoryEffect(ui);
  assert.equal(new URL(requests.at(-1).path,'http://localhost').searchParams.get('page'),'2');
  assert.match(ui.text(ui.render()),/历史图片 12/);
  assert.equal(findButton(ui,'下一页').props.disabled,true);
  setTaskField(ui,'任务类型','image');setTaskField(ui,'任务状态','failed');
  await runHistoryEffect(ui);
  const filtered=new URL(requests.at(-1).path,'http://localhost');
  assert.equal(filtered.searchParams.get('type'),'image');
  assert.equal(filtered.searchParams.get('status'),'failed');
  assert.equal(filtered.searchParams.get('page'),'1','changing filters returns to the first page');
  setTaskField(ui,'任务开始日期','2026-11-06');setTaskField(ui,'任务结束日期','2026-11-07');
  await runHistoryEffect(ui);
  const dated=new URL(requests.at(-1).path,'http://localhost');
  assert.equal(dated.searchParams.get('from'),new Date('2026-11-06T00:00:00').toISOString());
  assert.equal(dated.searchParams.get('to'),new Date('2026-11-07T23:59:59.999').toISOString());
});

test('missing generated files leave task details and parameters available',async()=>{
  const task=taskRecord({result:{files:[{id:OUTPUT_FILE_ID,mimeType:'image/png',size:64,role:'result'}]}});
  const {ui}=taskPanel(request=>{
    if(request.path.startsWith('/local/tasks?'))return {items:[task],total:1,page:1,pageSize:10,pageCount:1};
    if(request.path==='/local/tasks/'+task.id)return {task};
    if(request.path==='/local/task-files/'+OUTPUT_FILE_ID)return Response.json({error:'结果文件不存在'},{status:404});
  });
  await showTaskHistory(ui);clickButton(ui,'详情');await flushPanel();
  const detail=dialog(ui);
  assert.ok(detail);assert.match(ui.text(detail),/任务详情/);
  assert.match(ui.text(detail),/一只水彩橘猫/);
  assert.match(ui.text(detail),/结果文件不存在/);
  assert.ok(ui.find(detail,node=>node.props.role==='alert'));
  assert.ok(findButton(ui,'沿用参数',detail));
});

test('API request history can be filtered and shows request metadata and usage',async()=>{
  const task=taskRecord({type:'api_request',summary:'POST /v1/chat/completions',params:{method:'POST',path:'/v1/chat/completions',model:'gpt-5',stream:true,prompt:'介绍一下水彩画'},result:{httpStatus:200,responseBytes:2048,usage:{prompt_tokens:8,completion_tokens:0,total_tokens:8}}});
  const {ui,requests}=taskPanel(request=>{
    if(request.path.startsWith('/local/tasks?'))return {items:[task],total:1,page:1,pageSize:10,pageCount:1};
    if(request.path==='/local/tasks/'+task.id)return {task};
  });
  const tree=await showTaskHistory(ui);
  assert.match(ui.text(tree),/API 请求/);
  assert.match(ui.text(tree),/HTTP 200 · 8 Token/);
  setTaskField(ui,'任务类型','api_request');await runHistoryEffect(ui);
  assert.equal(new URL(requests.at(-1).path,'http://localhost').searchParams.get('type'),'api_request');
  clickButton(ui,'详情');await flushPanel();
  const detail=dialog(ui),content=ui.text(detail);
  assert.match(content,/接口：POST \/v1\/chat\/completions/);
  assert.match(content,/模型：gpt-5/);
  assert.match(content,/流式响应：是/);
  assert.match(content,/HTTP 状态：200/);
  assert.match(content,/介绍一下水彩画/);
  assert.match(content,/输入：8 Token/);
  assert.match(content,/输出：0 Token/);
  assert.match(content,/总计：8 Token/);
  assert.equal(findButton(ui,'删除记录',detail).props.disabled,false);
  for(const label of ['沿用参数','查看号池','创建重试任务'])assert.equal(ui.find(detail,node=>node.type==='button'&&ui.text(node)===label),undefined);
  assert.equal(requests.filter(request=>request.method!=='GET').length,0);
});

test('failed and interrupted API requests show status without offering to replay them',async()=>{
  for(const status of ['failed','interrupted','running']){
    const task=taskRecord({type:'api_request',status,params:{method:'POST',path:'/v1/responses',model:'gpt-5',stream:false},result:status==='failed'?{httpStatus:429}:null,finishedAt:status==='running'?null:'2026-11-06T01:00:12.000Z',error:status==='failed'?'API 请求失败（HTTP 429）':''});
    const {ui}=taskPanel(request=>{
      if(request.path.startsWith('/local/tasks?'))return {items:[task],total:1,page:1,pageSize:10,pageCount:1};
      if(request.path==='/local/tasks/'+task.id)return {task};
    });
    await showTaskHistory(ui);clickButton(ui,'详情');await flushPanel();
    const detail=dialog(ui),content=ui.text(detail);
    assert.match(content,/流式响应：否/);
    assert.match(content,/未记录文本内容/);
    assert.match(content,/未记录到用量/);
    assert.match(content,/第三方客户端断开后，执行结果可能无法确认/);
    assert.doesNotMatch(content,/后台任务会继续执行/);
    assert.equal(findButton(ui,'删除记录',detail).props.disabled,status==='running');
    for(const label of ['沿用参数','查看号池','创建重试任务'])assert.equal(ui.find(detail,node=>node.type==='button'&&ui.text(node)===label),undefined);
  }
});

test('image API history details preview and download the saved result',async()=>{
  const file={id:OUTPUT_FILE_ID,mimeType:'image/png',size:64,role:'result'};
  const task=taskRecord({type:'api_request',params:{method:'POST',path:'/v1/images/generations',model:'gpt-image-2',prompt:'一只水彩橘猫'},files:[file],result:{httpStatus:200,files:[file]}});
  const {ui}=taskPanel(request=>{
    if(request.path.startsWith('/local/tasks?'))return {items:[task],total:1,page:1,pageSize:10,pageCount:1};
    if(request.path==='/local/tasks/'+task.id)return {task};
    if(request.path==='/local/task-files/'+OUTPUT_FILE_ID)return {id:OUTPUT_FILE_ID,mimeType:'image/png',b64_json:PIXEL_PNG};
  });
  await showTaskHistory(ui);clickButton(ui,'详情');await flushPanel();
  const detail=dialog(ui);
  assert.match(ui.text(detail),/生成结果/);
  assert.ok(ui.find(detail,node=>node.type==='img'&&node.props.alt==='任务生成结果'));
  assert.ok(ui.find(detail,node=>node.type==='a'&&ui.text(node)==='下载结果'&&node.props.download));
  assert.doesNotMatch(ui.text(detail),/图片结果不在此处保存/);
});

test('reuse restores image parameters and reference files without generating another task',async()=>{
  const reference={id:INPUT_FILE_ID,mimeType:'image/png',size:64,role:'input'};
  const task=taskRecord({params:{prompt:'参考图里的猫改成水彩风',model:'gpt-image-2',resolution:'2k',referenceFiles:[reference]}});
  const {ui,requests}=taskPanel(request=>{
    if(request.path.startsWith('/local/tasks?'))return {items:[task],total:1,page:1,pageSize:10,pageCount:1};
    if(request.path==='/local/tasks/'+task.id)return {task};
    if(request.path==='/local/task-files/'+INPUT_FILE_ID)return {id:INPUT_FILE_ID,mimeType:'image/png',b64_json:PIXEL_PNG};
  });
  await showTaskHistory(ui);clickButton(ui,'详情');await flushPanel();
  await findButton(ui,'沿用参数',dialog(ui)).props.onClick();
  const tree=ui.render();
  assert.equal(dialog(ui,tree),undefined);
  assert.equal(ui.find(tree,node=>node.type==='textarea'&&node.props['aria-label']==='提示词').props.value,task.params.prompt);
  assert.equal(ui.find(tree,node=>node.type==='select'&&node.props['aria-label']==='生成模型').props.value,'gpt-image-2');
  assert.equal(ui.find(tree,node=>node.type==='select'&&node.props['aria-label']==='分辨率档位').props.value,'2k');
  assert.match(ui.text(tree),/已选择 1 张参考图/);
  assert.equal(requests.filter(request=>request.method==='POST').length,0,'reusing only fills the form until the user submits it');
});

test('first image-page preferences do not overwrite parameters restored from history',async()=>{
  const task=taskRecord({params:{prompt:'保留历史模型和4K档位',model:'gpt-image-2.6',resolution:'4k'}});
  const {ui,requests}=taskPanel(request=>{
    if(request.path.startsWith('/local/tasks?'))return {items:[task],total:1,page:1,pageSize:10,pageCount:1};
    if(request.path==='/local/tasks/'+task.id)return {task};
    if(request.path==='/local/image-preferences')return {defaultModel:'gpt-image-2',defaultImageTier:'auto'};
    if(request.path==='/local/models')return {models:['gpt-image-2','gpt-image-2.6']};
    if(request.path==='/local/gif-capabilities')return {enabled:true};
    if(request.path==='/local/open-images-dir')return {dir:'/tmp/task-preview-images',count:0};
  });
  await showTaskHistory(ui);clickButton(ui,'详情');await flushPanel();
  await findButton(ui,'沿用参数',dialog(ui)).props.onClick();
  ui.render();
  const imagePageEffect=ui.effects().findLast(effect=>effect.deps?.length===1&&effect.deps[0]==='image');
  assert.ok(imagePageEffect);imagePageEffect.fn();await flushPanel();
  assert.ok(requests.some(request=>request.path==='/local/image-preferences'),'the first image page reads defaults');
  const tree=ui.render();
  assert.equal(ui.find(tree,node=>node.type==='textarea'&&node.props['aria-label']==='提示词').props.value,task.params.prompt);
  assert.equal(ui.find(tree,node=>node.type==='select'&&node.props['aria-label']==='生成模型').props.value,'gpt-image-2.6');
  assert.equal(ui.find(tree,node=>node.type==='select'&&node.props['aria-label']==='分辨率档位').props.value,'4k');
});

test('a late previous-task recovery cannot replace a new image submission in progress',async t=>{
  const previous=taskRecord(),next=taskRecord({id:'10000000-0000-4000-8000-000000000002',status:'queued',startedAt:null,finishedAt:null,result:null});
  let releaseRecovery,releaseSubmission,submission;
  const {ui,requests}=taskPanel(request=>{
    if(request.path.startsWith('/local/tasks?type=image'))return new Promise(resolve=>{releaseRecovery=()=>resolve({items:[previous]})});
    if(request.path.startsWith('/local/tasks?type=gif'))return {items:[]};
    if(request.path==='/local/tasks'&&request.method==='POST')return new Promise(resolve=>{releaseSubmission=()=>resolve({task:next})});
    if(request.path==='/local/tasks/'+previous.id)return {task:previous};
  });
  t.after(async()=>{releaseRecovery?.();releaseSubmission?.();await submission});
  clickButton(ui,'图片生成');
  const recoveryEffect=ui.effects().find(effect=>effect.deps?.length===1&&effect.deps[0]==='image');
  assert.ok(recoveryEffect);recoveryEffect.fn();
  const generate=findButton(ui,'生成一张图片').props.onClick;
  submission=generate();await flushPanel();
  assert.equal(requests.filter(request=>request.method==='POST').length,1);
  releaseRecovery();await flushPanel();
  const tree=ui.render();
  assert.equal(findButton(ui,'正在生成…',tree).props.disabled,true,'the new request remains busy while its response is pending');
  assert.equal(requests.filter(request=>request.path==='/local/tasks/'+previous.id).length,0,'stale recovery does not load the old result');
  await generate();
  assert.equal(requests.filter(request=>request.method==='POST').length,1,'a second click cannot create another task while submitting');
  releaseSubmission();await submission;
  assert.ok(findButton(ui,'任务排队中…'));
});

test('incomplete historical reference images block generation until the user chooses replacements',async()=>{
  const task=taskRecord({status:'failed',error:'参考图片保存失败',params:{prompt:'必须使用原参考图',model:'gpt-image-2',resolution:'2k',referenceCount:2,referenceFiles:[]},result:null});
  const {ui,requests}=taskPanel(request=>{
    if(request.path.startsWith('/local/tasks?'))return {items:[task],total:1,page:1,pageSize:10,pageCount:1};
    if(request.path==='/local/tasks/'+task.id)return {task};
  });
  await showTaskHistory(ui);clickButton(ui,'详情');await flushPanel();
  await findButton(ui,'沿用参数',dialog(ui)).props.onClick();
  assert.match(ui.text(ui.render()),/参考图片未完整保存，请重新选择参考图片/);
  await findButton(ui,'生成一张图片').props.onClick();
  assert.equal(requests.filter(request=>request.method==='POST').length,0,'incomplete image edits never fall back to text-only generation');
  assert.match(ui.text(ui.render()),/重新选择参考图片后再生成/);
});

test('queued and running history tasks cannot be deleted from the list or details',async()=>{
  const jobs=[taskRecord({summary:'尚未执行',status:'queued',startedAt:null,finishedAt:null}),taskRecord({id:'10000000-0000-4000-8000-000000000002',summary:'执行中任务',status:'running',finishedAt:null})];
  const {ui,requests}=taskPanel(request=>request.path.startsWith('/local/tasks?')?{items:jobs,total:2,page:1,pageSize:10,pageCount:1}:request.path==='/local/tasks/'+TASK_ID?{task:jobs[0]}:undefined);
  const tree=await showTaskHistory(ui);
  for(const job of jobs){
    const row=ui.find(tree,node=>node.type==='tr'&&ui.text(node).includes(job.summary));
    assert.ok(row);assert.equal(findButton(ui,'删除记录',row).props.disabled,true);
  }
  const firstRow=ui.find(tree,node=>node.type==='tr'&&ui.text(node).includes(jobs[0].summary));
  findButton(ui,'详情',firstRow).props.onClick();await flushPanel();
  assert.equal(findButton(ui,'删除记录',dialog(ui)).props.disabled,true);
  assert.equal(requests.filter(request=>request.method==='DELETE').length,0);
});

test('account pagination reaches beyond 300 rows and changing page size resets the page',async()=>{
  const {ui}=await poolFixture(305);
  let tree=ui.render();
  assert.match(ui.text(tree),/共 305 个账号 · 1–10 条/);
  assert.equal(ui.flatten(tree).filter(node=>node?.type==='tbody')[0].children.length,10);
  assert.equal(findButton(ui,'上一页').props.disabled,true);
  tree=clickButton(ui,'31');
  assert.match(ui.text(tree),/account305@example.test/);
  assert.doesNotMatch(ui.text(tree),/account1@example.test/);
  assert.match(ui.text(tree),/301–305 条/);
  assert.equal(findButton(ui,'下一页').props.disabled,true);
  tree=setPageSize(ui,20);
  assert.match(ui.text(tree),/1–20 条/);
  assert.equal(ui.flatten(tree).filter(node=>node?.type==='tbody')[0].children.length,20);
});

test('selection spans pages and page select-all only affects the visible page',async()=>{
  const {ui}=await poolFixture(25);
  setCheckbox(ui,'选择账号 account1@example.test');
  let header=ui.find(ui.render(),node=>node.type==='input'&&node.props['aria-label']==='选择本页全部账号');
  assert.equal(header.props['aria-checked'],'mixed');
  clickButton(ui,'下一页');setCheckbox(ui,'选择本页全部账号');
  assert.ok(findButton(ui,'批量删除（11）'));
  setCheckbox(ui,'选择本页全部账号',false);
  assert.ok(findButton(ui,'批量删除（1）'));
  clickButton(ui,'上一页');
  assert.equal(ui.find(ui.render(),node=>node.type==='input'&&node.props['aria-label']==='选择账号 account1@example.test').props.checked,true);
  clickButton(ui,'清空选择');
  assert.equal(findButton(ui,'批量删除（0）').props.disabled,true);
});

test('cancelled batch deletion leaves accounts and selections unchanged',async()=>{
  const {ui,requests,confirmations}=await poolFixture(12,{confirm:()=>false});
  setCheckbox(ui,'选择本页全部账号');
  await findButton(ui,'批量删除（10）').props.onClick();
  assert.equal(requests.filter(r=>r.method==='DELETE').length,0);
  assert.match(confirmations[0],/10 个账号/);
  assert.ok(findButton(ui,'批量删除（10）'));
});

test('batch deletion removes selected references and clamps an emptied last page',async()=>{
  const {ui,requests}=await poolFixture(12);
  clickButton(ui,'下一页');setCheckbox(ui,'选择本页全部账号');
  const deletion=findButton(ui,'批量删除（2）').props.onClick();
  assert.equal(findButton(ui,'批量删除（2）').props.disabled,true);
  assert.equal(findButton(ui,'上一页').props.disabled,true);
  await deletion;
  assert.equal(requests.filter(r=>r.method==='DELETE').length,1);
  assert.deepEqual(requests.find(r=>r.method==='DELETE').body.tokens,[String(11).padStart(64,'0'),String(12).padStart(64,'0')]);
  const tree=ui.render();
  assert.match(ui.text(tree),/可用 Token 号池（10）/);
  assert.match(ui.text(tree),/批量删除完成：已确认删除 2 个账号/);
  assert.match(ui.text(tree),/1–10 条/);
  assert.equal(findButton(ui,'批量删除（0）').props.disabled,true);
});

test('a later batch failure reconciles confirmed removals and preserves remaining selections',async()=>{
  const {ui,requests}=await poolFixture(205,{deleteBatch:(_request,batch)=>batch===2?Response.json({error:'第二批删除失败'},{status:502}):undefined});
  setPageSize(ui,100);setCheckbox(ui,'选择本页全部账号');
  clickButton(ui,'下一页');setCheckbox(ui,'选择本页全部账号');
  clickButton(ui,'下一页');setCheckbox(ui,'选择本页全部账号');
  await findButton(ui,'批量删除（205）').props.onClick();
  const deletes=requests.filter(r=>r.method==='DELETE');
  assert.equal(deletes.length,2,'no further batches are sent after a failure');
  assert.ok(deletes.every(r=>r.body.tokens.length<=100));
  assert.match(ui.text(ui.render()),/可用 Token 号池（105）/);
  assert.match(ui.text(ui.render()),/批量删除未完成：已确认删除 100 个账号/);
  assert.match(ui.text(ui.render()),/第二批删除失败/);
  assert.ok(findButton(ui,'批量删除（105）'));
  assert.match(ui.text(ui.render()),/101–105 条/);
});

test('a stale background snapshot cannot restore deleted accounts or undo page reconciliation',async()=>{
  let releaseOldRead;
  const {ui}=await poolFixture(12,{readAccounts:(items,read)=>read===2?new Promise(resolve=>{const response=Response.json({items});releaseOldRead=()=>resolve(response)}):undefined});
  clickButton(ui,'下一页');setCheckbox(ui,'选择本页全部账号');
  // Returning to a loaded account page starts a silent revalidation while
  // leaving the existing table and actions available.
  const pageEffect=ui.effects().findLast(effect=>effect.deps?.length===1&&effect.deps[0]==='accounts');
  assert.ok(pageEffect);pageEffect.fn();
  assert.equal(findButton(ui,'批量删除（2）').props.disabled,false);
  await findButton(ui,'批量删除（2）').props.onClick();
  assert.match(ui.text(ui.render()),/可用 Token 号池（10）/);
  releaseOldRead();await new Promise(resolve=>setImmediate(resolve));
  const tree=ui.render();
  assert.match(ui.text(tree),/可用 Token 号池（10）/);
  assert.match(ui.text(tree),/1–10 条/);
  assert.equal(findButton(ui,'批量删除（0）').props.disabled,true);
});

test('native workbench keeps the Token pool visible and opens imports on demand',()=>{
  const ui=loadPanel();
  const overview=ui.mount();
  assert.match(ui.text(overview),/ChatGPT2API/);
  assert.doesNotMatch(ui.text(overview),/低成本号池扩容建议|priceai/);
  const pool=clickButton(ui,'号池管理');
  assert.match(ui.text(pool),/无需管理员密码/);
  assert.match(ui.text(pool),/可用 Token 号池（0）/);
  assert.match(ui.text(pool),/待授权记录/);
  assert.equal(dialog(ui,pool),undefined);
  const cards=ui.flatten(pool).filter(node=>node?.type==='section'&&node.props?.className?.includes('c2a-card'));
  assert.equal(cards.length,1,'the account pool is the only permanent card');
  assert.doesNotMatch(ui.text(pool),/导入一个账号|第三字段批量导入|DeepSeek/i);
  const token=clickButton(ui,'＋ 导入账号');
  assert.ok(dialog(ui,token));
  assert.match(ui.text(token),/导入一个账号/);
  const email=selectImportMode(ui,'email');
  assert.match(ui.text(email),/邮箱 \/ 密码 \/ 第三字段批量导入/);
  assert.doesNotMatch(ui.text(email),/priceai|DeepSeek/i);
  const api=clickButton(ui,'API 接入');
  assert.equal(dialog(ui,api),undefined,'changing the main page closes the dialog');
  assert.match(ui.text(api),/通用 API 接入|OpenAI 兼容 API Base URL|复制 URL/);
  const image=clickButton(ui,'图片生成');
  assert.match(ui.text(image),/创建生图任务/);
  assert.match(ui.text(image),/参考图片/);
  assert.match(ui.text(image),/打开历史图片文件夹/);
});

test('Token pool header offers the same quota refresh action as the proxy dialog',()=>{
  const ui=loadPanel();ui.mount();clickButton(ui,'号池管理');
  const tree=clickButton(ui,'⚙ 代理与额度');
  const header=ui.find(tree,node=>node.type==='div'&&node.props.className==='c2a-card-head');
  assert.ok(header,'the pool card has a title and action header');
  assert.match(ui.text(header),/可用 Token 号池（0）/);
  const shortcut=ui.find(header,node=>node.type==='button'&&ui.text(node)==='刷新全部额度');
  const original=ui.find(dialog(ui,tree),node=>node.type==='button'&&ui.text(node)==='全部刷新额度');
  assert.ok(shortcut,'the refresh shortcut is inside the pool card header');
  assert.ok(original);
  assert.equal(shortcut.props.onClick,original.props.onClick);
  assert.equal(shortcut.props.disabled,true,'an empty pool cannot be refreshed');
  assert.equal(shortcut.props.disabled,original.props.disabled);
});

test('closing, reopening and switching pages retains import drafts without reopening dialogs',()=>{
  const ui=loadPanel();ui.mount();clickButton(ui,'号池管理');
  clickButton(ui,'＋ 导入账号');selectImportMode(ui,'email');
  const draft='someone@example.com----pa55----2FASECRET';
  const textarea=ui.find(ui.render(),node=>node.type==='textarea'&&node.props['aria-label']==='一行一条账号凭据文本');
  textarea.props.onChange({target:{value:draft}});
  clickButton(ui,'关闭');
  assert.equal(dialog(ui),undefined);
  clickButton(ui,'＋ 导入账号');
  assert.equal(ui.find(ui.render(),node=>node.type==='textarea').props.value,draft);
  clickButton(ui,'API 接入');
  const back=ui.mount();
  const selected=ui.find(back,node=>node.type==='button'&&node.props?.className?.includes('c2a-tab selected'));
  assert.ok(ui.flatten(selected).includes('API 接入'));
  clickButton(ui,'号池管理');
  assert.equal(dialog(ui),undefined);
  clickButton(ui,'＋ 导入账号');
  const restored=ui.render();
  assert.equal(ui.find(restored,node=>node.type==='textarea').props.value,draft);
  assert.doesNotMatch(ui.text(restored),/加载中…/);
});

test('pending records have a dedicated dialog instead of a permanent import card',()=>{
  const ui=loadPanel();ui.mount();clickButton(ui,'号池管理');
  const pending=clickButton(ui,'待授权记录（0）');
  assert.equal(dialog(ui,pending).props['aria-labelledby'],'c2a-pending-dialog-title');
  assert.match(ui.text(pending),/没有待授权记录/);
  assert.doesNotMatch(ui.text(pending),/一行一条账号凭据文本|导入并授权入池/);
});

test('account dialogs provide accessible labels and support cancel and backdrop dismissal',()=>{
  const ui=loadPanel();ui.mount();clickButton(ui,'号池管理');
  clickButton(ui,'＋ 导入账号');
  let modal=dialog(ui);
  assert.equal(modal.props.role,'dialog');
  assert.equal(modal.props['aria-modal'],'true');
  const title=ui.find(ui.render(),node=>node.props.id===modal.props['aria-labelledby']);
  assert.ok(title);
  let prevented=false;
  modal.props.onCancel({preventDefault(){prevented=true}});
  assert.equal(prevented,true);
  assert.equal(dialog(ui),undefined);
  clickButton(ui,'＋ 导入账号');modal=dialog(ui);
  modal.props.onClick({target:{},currentTarget:{}});
  assert.ok(dialog(ui),'clicks on dialog content keep it open');
  const backdrop={};modal.props.onClick({target:backdrop,currentTarget:backdrop});
  assert.equal(dialog(ui),undefined);
});

test('image failures explain upstream content policy instead of echoing the apology',()=>{
  const {api}=loadPanel();
  const {imageFailureText,DEFAULT_PROMPT}=api.__test;
  const policy=imageFailureText('非常抱歉，生成的图片可能违反了关于轻度性暗示或挑逗性主题的防护限制。如果你认为此判断有误，请重试或修改提示语。');
  assert.match(policy,/内容安全策略/);assert.match(policy,/改用插画/);assert.match(policy,/上游原文/);
  assert.equal(imageFailureText('连接超时（240 秒）'),'连接超时（240 秒）');
  assert.doesNotMatch(DEFAULT_PROMPT,/写真|真人|性感/);
});


test('proxy and quota controls remain available in a dialog with generic guidance',()=>{
  const ui=loadPanel();ui.mount();clickButton(ui,'号池管理');
  assert.equal(ui.find(ui.render(),node=>node.props['aria-label']==='号池全局代理地址'),undefined);
  const proxy=clickButton(ui,'⚙ 代理与额度');
  assert.equal(dialog(ui,proxy).props['aria-labelledby'],'c2a-proxy-dialog-title');
  const labels=ui.text(proxy);
  for(const label of ['测试代理连通性','保存全局代理','全部刷新额度','复制排查说明'])assert.ok(labels.includes(label));
  assert.doesNotMatch(labels,/DeepSeek/i);
  const source=fs.readFileSync(new URL('../src/client/dashboard.js',import.meta.url),'utf8');
  assert.match(source,/pool\.items\.every\(/);
  assert.doesNotMatch(source,/DeepSeek|deepseek|priceai/);
});
