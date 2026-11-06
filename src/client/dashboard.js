/* DSH native panel for independent cross-platform local chatgpt2api service.
 * Admin requests go through DSH's same-origin authenticated Connection route;
 * no login prompt, admin credential, or upstream admin authorization in browser.
 */
function readDashboardTheme() {
  try {
    const saved = globalThis.localStorage?.getItem('chatgpt2api.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return 'dark';
}
function applyDashboardTheme(theme) {
  if (typeof document !== 'undefined') document.documentElement?.setAttribute('data-c2a-theme', theme);
}
function createChatGPT2APIDashboard(React, STYLES, options = {}) {
  const standalone = options.standalone === true;
  const text = (plugin, native) => standalone ? native : plugin;
  const h=React.createElement;
  const {useState,useEffect,useMemo,useRef,useCallback}=React;
  const useIsoLayoutEffect=typeof React.useLayoutEffect==='function'?React.useLayoutEffect:useEffect;
  const PANEL='chatgpt2api-dashboard';
  const DEFAULT_URL=options.baseUrl||'http://127.0.0.1:38650';
  const PAGES=[['overview','总览','▣'],['accounts','号池管理','◉'],['api','API 接入','⇄'],['image','图片生成','▧'],['history','历史任务','◷'],['advanced','高级导入','⚙'],['settings',text('插件设置','运行设置'),'≡']];
  const TASK_TYPES={image:'图片生成',gif:'GIF 动画',authorize:'账号授权',quota:'额度刷新',api_request:'API 请求'};
  const TASK_STATUSES={queued:'排队中',running:'进行中',succeeded:'成功',partial:'部分成功',failed:'失败',interrupted:'已中断 / 结果未知'};
  const taskFinished=task=>!['queued','running'].includes(task?.status);
  const taskKind=task=>task?.status==='succeeded'?'success':['failed','interrupted'].includes(task?.status)?'danger':task?.status==='partial'?'warning':'neutral';
  const requestId=()=>globalThis.crypto?.randomUUID?.()||`ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function taskDuration(task){const start=Date.parse(task?.startedAt||task?.createdAt),end=task?.finishedAt?Date.parse(task.finishedAt):Date.now();if(!Number.isFinite(start)||!Number.isFinite(end))return '—';const seconds=Math.max(0,Math.floor((end-start)/1000));return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`}
  function taskSummary(task){const r=task?.result||{},p=task?.progress||{};if(task?.type==='api_request')return (r.httpStatus?`HTTP ${r.httpStatus}`:TASK_STATUSES[task.status]||'等待结果')+(r.usage?.total_tokens!==undefined?` · ${r.usage.total_tokens} Token`:'');if(task?.type==='authorize')return r.total!==undefined?`成功 ${r.succeeded||0} · 失败 ${r.failed||0} · 跳过 ${(r.duplicates||0)+(r.enrolled?.skipped||0)}`+(r.invalid?` · 格式错误 ${r.invalid}`:''):'等待授权结果';if(task?.type==='quota')return `${r.processed??p.processed??0} / ${r.total??p.total??'—'} · 异常 ${r.errorCount??p.errorCount??0}`;return task?.status==='succeeded'?'生成完成':TASK_STATUSES[task?.status]||'等待结果'}
  const MAX_FILE_SIZE=12*1024*1024;
  function urlClean(value){
    try{const u=new URL(String(value).trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return null;return u.origin}catch{return null}
  }

  function shortError(e){return String(e?.message||e||'请求失败').slice(0,260)}
  const DEFAULT_PROMPT='一只橘猫坐在木质窗台上晒太阳，水彩插画风格，柔和光线';
  const ZERO_QUOTA_PROMPT='我已经导入了所有的账号，但是剩余额度一直是 0，让他检查了一下。请帮我排查 ChatGPT2API：确认登录和 Token 导入正常后，重点检查 chatgpt.com 的额度查询是否走了代理、全局 proxy 配置是否正确，并测试代理连通性与账号额度刷新进度。不要直接把数据库额度改成非零，也不要在聊天中暴露账号密码、2FA 密钥或 Token。';
  // Upstream refuses portrait / suggestive image prompts with a polite apology
  // in plain text (HTTP 400, code content_policy_violation). Showing that text
  // verbatim reads like a plugin bug, so name the cause and say what to change.
  const POLICY_ERROR=/违反|防护限制|内容政策|安全策略|敏感|不安全|挑逗|性暗示|violat|moderation|content[_ ]policy|safety/i;
  function imageFailureText(raw){
    const text=String(raw||'请求失败').slice(0,300);
    if(!POLICY_ERROR.test(text))return text;
    return '上游以内容安全策略拒绝了本次生图，这不是号池或网络故障。\n'+
      '请避免「写真 / 真人 / 性感 / 身体特写」等描述，改用插画、水彩、景物或虚构角色后重试。\n'+
      '（上游原文：'+text.slice(0,180)+'）';
  }
  function LogoMark({size=39}={}){
    return h('svg',{viewBox:'0 0 64 64',width:size,height:size,'aria-hidden':true,focusable:'false'},
      h('rect',{width:64,height:64,rx:16,fill:'#15232b'}),
      h('path',{d:'M8 12H34V24H20V40H8Z M56 52H30V40H44V24H56Z',fill:'#55d9b0'})
    );
  }
  function HeaderIcon(){return h(LogoMark,{size:20})}
  function Chip({kind='neutral',children}){return h('span',{className:'c2a-chip '+kind},children)}
  function Btn({children,onClick,primary=false,disabled=false,danger=false,cls='',className='',style,title}){
    const c='c2a-button'+(primary?' primary':'')+(danger?' danger':'')+((cls||className)?' '+(cls||className):'');
    return h('button',{type:'button',className:c,onClick,disabled,style,title},children);
  }
  function Card({title,actions,children,cls=''}){return h('section',{className:'c2a-card '+cls},actions?h('div',{className:'c2a-card-head'},h('h3',null,title),actions):h('h3',null,title),children)}
  function Modal({title,id,onClose,children,wide=false,note='关闭弹窗后保留当前草稿；后台任务会继续执行。'}){
    const ref=useRef(null);
    useIsoLayoutEffect(()=>{
      const dialog=ref.current;
      if(!dialog||typeof dialog.showModal!=='function')return;
      const previous=document.activeElement;
      dialog.showModal();
      dialog.querySelector('[data-dialog-focus]')?.focus();
      return()=>{
        if(dialog.open)dialog.close();
        if(previous?.isConnected)previous.focus();
      };
    },[]);
    return h('dialog',{ref,className:'c2a-modal'+(wide?' wide':''),role:'dialog','aria-modal':'true','aria-labelledby':id,
      onCancel:event=>{event.preventDefault();onClose()},
      onClick:event=>{if(event.target===event.currentTarget)onClose()}},
      h('div',{className:'c2a-modal-surface'},
        h('div',{className:'c2a-modal-head'},h('h2',{id},title),h('button',{type:'button',className:'c2a-modal-close',onClick:onClose,'aria-label':'关闭'+title},'×')),
        h('div',{className:'c2a-modal-body'},children),
        h('div',{className:'c2a-modal-foot'},h('span',null,note),h(Btn,{onClick:onClose},'关闭'))
      )
    );
  }
  function number(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString('zh-CN'):'—'}
  function maskToken(v){if(typeof v!=='string'||!v)return '—';return v.slice(0,5)+'••••'+v.slice(-4)}
  function accountToken(a){return String(a?.ref||'')}
  function copyToClipboard(text, onSuccess){
    if(!text)return;
    function fallback(){
      try{
        if(typeof document==='undefined')return;
        const ta=document.createElement('textarea');
        ta.value=text;
        ta.setAttribute('readonly','');
        ta.style.position='fixed';
        ta.style.top='-9999px';
        ta.style.left='-9999px';
        ta.style.opacity='0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0,99999);
        const ok=document.execCommand('copy');
        document.body.removeChild(ta);
        if(ok&&typeof onSuccess==='function')onSuccess();
      }catch(e){console.warn('复制降级失败',e)}
    }
    try{
      if(globalThis.navigator?.clipboard?.writeText){
        globalThis.navigator.clipboard.writeText(text).then(()=>{
          if(typeof onSuccess==='function')onSuccess();
        }).catch(()=>fallback());
        return;
      }
    }catch{}
    fallback();
  }
  const LOCAL_USER_KEYS_KEY='c2a_saved_user_keys_v1';
  function getLocalUserKeys(){
    try{
      const raw=globalThis.localStorage?.getItem(LOCAL_USER_KEYS_KEY);
      return raw?JSON.parse(raw):{};
    }catch{return {}}
  }
  function saveLocalUserKey(id,key,name){
    if(!id||!key)return;
    try{
      const cur=getLocalUserKeys();
      cur[String(id)]={key:String(key),name:String(name||''),time:Date.now()};
      globalThis.localStorage?.setItem(LOCAL_USER_KEYS_KEY,JSON.stringify(cur));
    }catch{}
  }
  function removeLocalUserKey(id){
    if(!id)return;
    try{
      const cur=getLocalUserKeys();
      delete cur[String(id)];
      globalThis.localStorage?.setItem(LOCAL_USER_KEYS_KEY,JSON.stringify(cur));
    }catch{}
  }
  function formatKeyDate(str){
    if(!str)return '—';
    try{
      const d=new Date(str);
      if(isNaN(d.getTime()))return String(str).slice(0,19).replace('T',' ');
      const p=n=>String(n).padStart(2,'0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }catch{return String(str).slice(0,19)}
  }
  function parseJsonResponse(resp,txt){
    let obj;try{obj=JSON.parse(txt)}catch{throw Error(`HTTP ${resp.status}: 返回内容不是 JSON`)}
    if(!resp.ok){const err=obj?.detail?.error||obj?.detail?.message||obj?.detail||obj?.error?.message||obj?.error||('HTTP '+resp.status);throw Error(typeof err==='string'?err:JSON.stringify(err))}
    return obj;
  }
  // DSH renders only the active 'main' entry: switching to another plugin
  // panel or to another session unmounts this component, and coming back
  // mounts a brand-new instance. Component-local state by definition starts
  // over, which reads exactly like a full page refresh (tab resets, drafts
  // vanish, requests restart, scroll jumps to top).
  //
  // The panel therefore keeps its whole view model outside the component:
  // active tab, drafts, file selections, fetched snapshots, busy flags,
  // long-running task results and the scroll offset per tab. Setters write
  // through synchronously, so a request that finishes while the panel is
  // unmounted still lands in the store instead of being dropped; mounted
  // instances subscribe for those external updates. Secrets stay in this
  // in-memory map only (never localStorage/sessionStorage) and disappear when
  // the web client itself reloads.
  const panelStore=new Map();
  const panelWatchers=new Set();
  const tabScroll=new Map();
  let accountListRevision=0;
  let historyListRevision=0;
  let historyDetailRevision=0;
  function storeSet(key,next){
    const prev=panelStore.get(key);
    const value=typeof next==='function'?next(prev):next;
    panelStore.set(key,value);
    for(const watch of panelWatchers)watch(key);
    return value;
  }
  function usePanelState(key,initial,revive){
    const [value,setValue]=useState(()=>{
      if(panelStore.has(key)){
        const cached=panelStore.get(key);
        const revived=typeof revive==='function'?revive(cached):cached;
        // Keep store and view identical: "loading" flags frozen by an unmount
        // must not resurrect through the subscription below.
        if(revived!==cached)panelStore.set(key,revived);
        return revived;
      }
      const fresh=typeof initial==='function'?initial():initial;
      panelStore.set(key,fresh);
      return fresh;
    });
    const mounted=useRef(true);
    useEffect(()=>{
      // React strict mode replays the effect: (re)mark the instance live and
      // pick up writes that happened before the subscription was attached.
      mounted.current=true;
      const watch=changed=>{if(changed===key&&mounted.current)setValue(panelStore.get(key))};
      panelWatchers.add(watch);
      setValue(panelStore.get(key));
      return()=>{mounted.current=false;panelWatchers.delete(watch)};
    },[key]);
    const set=useCallback(next=>{
      const nextValue=storeSet(key,next);
      if(mounted.current)setValue(nextValue);
      return nextValue;
    },[key]);
    return [value,set];
  }
  function Dashboard(){
    const [theme,setTheme]=useState(readDashboardTheme);
    useIsoLayoutEffect(()=>{if(standalone)applyDashboardTheme(theme)},[theme]);
    function toggleTheme(){
      const next=theme==='dark'?'light':'dark';
      setTheme(next);
      try{globalThis.localStorage?.setItem('chatgpt2api.theme',next)}catch{}
    }
    const [tab,setTab]=usePanelState('tab','overview');
    const [baseUrl,setBaseUrl]=usePanelState('baseUrl',DEFAULT_URL);
    const [health,setHealth]=usePanelState('health',{loading:true,data:null,error:''},x=>({...x,loading:false}));
    const [refreshTick,setRefreshTick]=useState(0);
    const [accountDialog,setAccountDialog]=useState('');
    const [importMode,setImportMode]=usePanelState('importMode','token');
    const [pool,setPool]=usePanelState('pool',{loading:false,loaded:false,items:[],error:'',message:''},x=>({...x,loading:false}));
    const [accountSelection,setAccountSelection]=usePanelState('accountSelection',[]);
    const [accountPage,setAccountPage]=usePanelState('accountPage',1);
    const [accountPageSize,setAccountPageSize]=usePanelState('accountPageSize',10);
    const [newToken,setNewToken]=usePanelState('newToken','');
    const [credentialText,setCredentialText]=usePanelState('credentialText','');
    const [credentialItems,setCredentialItems]=usePanelState('credentialItems',[]);
    const [credentialBusy,setCredentialBusy]=usePanelState('credentialBusy',false);
    const [credentialFeedback,setCredentialFeedback]=usePanelState('credentialFeedback',null);
    const [credentialError,setCredentialError]=usePanelState('credentialError','');
    const [doing,setDoing]=usePanelState('doing',false);
    const [proxyState,setProxyState]=usePanelState('proxyState',{url:'',draft:'',configured:false,hasCredentials:false,busy:false,error:'',message:'',test:null});
    const [prompt,setPrompt]=usePanelState('prompt',DEFAULT_PROMPT);
    const [imageModels,setImageModels]=usePanelState('imageModels',{items:[],loading:false,error:''});
    const [imagePrefs,setImagePrefs]=usePanelState('imagePrefs',{defaultModel:'gpt-image-2',defaultImageTier:'auto',loaded:false,saving:false,error:'',message:''});
    const [imageModel,setImageModel]=usePanelState('imageModel','gpt-image-2');
    const [imageTier,setImageTier]=usePanelState('imageTier','auto');
    const [animatedGif,setAnimatedGif]=usePanelState('animatedGif',false);
    const [gifFrameCount,setGifFrameCount]=usePanelState('gifFrameCount',9);
    const [gifFrameDuration,setGifFrameDuration]=usePanelState('gifFrameDuration',200);
    const [gifCapability,setGifCapability]=usePanelState('gifCapability',{enabled:false,loaded:false,supportedModels:[]});
    const [imageFiles,setImageFiles]=usePanelState('imageFiles',[]);
    const [imageResult,setImageResult]=usePanelState('imageResult',{loading:false,url:'',error:''});
    const [credentialTaskId,setCredentialTaskId]=usePanelState('credentialTaskId','');
    const [quotaTaskId,setQuotaTaskId]=usePanelState('quotaTaskId','');
    const [taskFilters,setTaskFilters]=usePanelState('taskFilters',{type:'',status:'',from:'',to:''});
    const [taskHistory,setTaskHistory]=usePanelState('taskHistory',{items:[],total:0,page:1,pageSize:10,pageCount:1,loading:false,error:'',message:''});
    const [overviewTasks,setOverviewTasks]=usePanelState('overviewTasks',{items:[],loaded:false,loading:true,error:'',activeCount:null,countError:''});
    const [historyDialogId,setHistoryDialogId]=useState('');
    const [historyDetail,setHistoryDetail]=useState({item:null,loading:false,error:''});
    const [taskFileUrls,setTaskFileUrls]=useState({});
    const [taskFileErrors,setTaskFileErrors]=useState({});
    const [historyBusy,setHistoryBusy]=useState('');
    const taskFileCache=useRef(new Map());
    const taskFilePending=useRef(new Map());
    const [missingReferenceFiles,setMissingReferenceFiles]=usePanelState('missingReferenceFiles',false);
    const [folderBusy,setFolderBusy]=usePanelState('folderBusy',false);
    const [folderNote,setFolderNote]=usePanelState('folderNote','');
    const [folderInfo,setFolderInfo]=usePanelState('folderInfo',{dir:'',count:0});
    const [frameIndex,setFrameIndex]=useState(0);
    const [userKeys,setUserKeys]=usePanelState('userKeys',[]);
    const [userKeysLoaded,setUserKeysLoaded]=usePanelState('userKeysLoaded',false);
    const [userKeyName,setUserKeyName]=usePanelState('userKeyName','本机应用');
    const [userKeyCustom,setUserKeyCustom]=usePanelState('userKeyCustom','');
    const [userKeyPlain,setUserKeyPlain]=usePanelState('userKeyPlain','');
    const [userKeyBusy,setUserKeyBusy]=usePanelState('userKeyBusy',false);
    const [userKeyError,setUserKeyError]=usePanelState('userKeyError','');
    const [copiedId,setCopiedId]=useState(null);
    const [revealedKeys,setRevealedKeys]=usePanelState('revealedKeys',{});
    const [importJson,setImportJson]=usePanelState('importJson','');
    const [importMessage,setImportMessage]=usePanelState('importMessage','');
    const [cpaDraft,setCpaDraft]=usePanelState('cpaDraft',{name:'',base_url:'',secret_key:''});
    const [cpaPools,setCpaPools]=usePanelState('cpaPools',[]);
    const [cpaPool,setCpaPool]=usePanelState('cpaPool','');
    const [cpaFiles,setCpaFiles]=usePanelState('cpaFiles',[]);
    const [cpaSelection,setCpaSelection]=usePanelState('cpaSelection',[]);
    const [subDraft,setSubDraft]=usePanelState('subDraft',{name:'',base_url:'',api_key:''});
    const [subServers,setSubServers]=usePanelState('subServers',[]);
    const [subServer,setSubServer]=usePanelState('subServer','');
    const [subAccounts,setSubAccounts]=usePanelState('subAccounts',[]);
    const [subSelection,setSubSelection]=usePanelState('subSelection',[]);
    const [advancedBusy,setAdvancedBusy]=usePanelState('advancedBusy',false);
    const [advancedError,setAdvancedError]=usePanelState('advancedError','');
    const [poolsLoaded,setPoolsLoaded]=usePanelState('poolsLoaded',false);
    const mainRef=useRef(null);
    const tabRef=useRef(tab);
    tabRef.current=tab;
    const endpoint=useMemo(()=>urlClean(baseUrl),[baseUrl]);
    const data=health.data,acc=data?.accounts||{};
    const online=!!data&&!health.error;
    const ready=online&&!!data?.healthy;
    const hasAccounts=Number(acc.total)>0;
    const firstUse=online&&Number(acc.total)===0;
    const serviceLabel=health.error?'服务连接异常':!online?'正在检查服务':firstUse?'等待导入账号':ready?'号池可用':'暂无可用账号';
    const serviceKind=health.error?'danger':ready?'success':'warning';
    const attentionCount=['limited','abnormal','disabled'].reduce((total,key)=>total+(Number(acc[key])||0),0);
    const apiBaseUrl=endpoint?endpoint+'/v1':'';
    const recentIssues=overviewTasks.items.filter(task=>['failed','partial','interrupted'].includes(task.status));
    const accountRefs=new Set(pool.items.map(accountToken).filter(Boolean));
    const selectedAccountRefs=accountSelection.filter(ref=>accountRefs.has(ref));
    const selectedAccountSet=new Set(selectedAccountRefs);
    const accountPageCount=Math.max(1,Math.ceil(pool.items.length/accountPageSize));
    const currentAccountPage=Math.min(accountPageCount,Math.max(1,accountPage));
    const accountPageStart=(currentAccountPage-1)*accountPageSize;
    const visibleAccounts=pool.items.slice(accountPageStart,accountPageStart+accountPageSize);
    const visibleAccountRefs=visibleAccounts.map(accountToken).filter(Boolean);
    const allPageAccountsSelected=visibleAccountRefs.length>0&&visibleAccountRefs.every(ref=>selectedAccountSet.has(ref));
    const somePageAccountsSelected=visibleAccountRefs.some(ref=>selectedAccountSet.has(ref));
    const accountPageNumbers=[...new Set([1,currentAccountPage-1,currentAccountPage,currentAccountPage+1,accountPageCount])].filter(page=>page>=1&&page<=accountPageCount).sort((a,b)=>a-b);
    function selectAccount(ref,checked){
      if(!ref)return;
      setAccountSelection(prev=>checked?[...new Set([...prev,ref])]:prev.filter(value=>value!==ref));
    }
    function selectAccountPage(checked){
      const pageRefs=new Set(visibleAccountRefs);
      setAccountSelection(prev=>checked?[...new Set([...prev,...pageRefs])]:prev.filter(ref=>!pageRefs.has(ref)));
    }
    function changeAccountPage(page){
      setAccountPage(page);
      mainRef.current?.querySelector('.c2a-account-tablewrap')?.scrollTo({top:0});
    }
    function changeTab(next){setAccountDialog('');closeHistoryDetail();setTab(next)}
    function openAccountDialog(next){setAccountDialog(next)}
    function closeAccountDialog(){setAccountDialog('')}
    function reload(){setHealth(x=>({...x,loading:true}));setRefreshTick(x=>x+1)}
    function refreshInBackground(){setRefreshTick(x=>x+1)}
    useEffect(()=>{
      // Keep the stylesheet for the whole client session: removing it on every
      // panel switch made the returning page paint unstyled for a frame, which
      // is most of what "the page reloaded" looked like.
      if(!STYLES)return;
      const id='c2a-native-dashboard-css';
      if(document.getElementById(id))return;
      const el=document.createElement('style');el.id=id;el.textContent=STYLES;document.head.appendChild(el);
    },[]);
    useIsoLayoutEffect(()=>{
      const el=mainRef.current;if(!el)return;
      const top=tabScroll.get(tab)||0;
      el.scrollTop=top;
      // Images restored from cache may finish decoding after layout and grow
      // the page; re-apply once so the returning view keeps its position.
      if(top&&typeof requestAnimationFrame==='function'){
        const raf=requestAnimationFrame(()=>{if(el.isConnected)el.scrollTop=top});
        return()=>cancelAnimationFrame(raf);
      }
    },[tab]);
    useEffect(()=>{void restoreActiveTasks()},[]);
    useEffect(()=>{
      if(tab==='image'&&!panelStore.get('imageTaskRestored')){panelStore.set('imageTaskRestored',true);void restoreLastImageTask()}
    },[tab]);
    useEffect(()=>{
      if(tab!=='overview')return;
      let live=true,timer;
      const poll=async()=>{
        const [recent,queued,running]=await Promise.allSettled([
          upstream('/local/tasks?pageSize=5',{timeoutMs:15000}),
          upstream('/local/tasks?status=queued&pageSize=1',{timeoutMs:15000}),
          upstream('/local/tasks?status=running&pageSize=1',{timeoutMs:15000})
        ]);
        if(!live)return;
        setOverviewTasks(previous=>({...previous,loading:false,
          ...(recent.status==='fulfilled'?{items:Array.isArray(recent.value.items)?recent.value.items.slice(0,5):[],loaded:true,error:''}:{error:shortError(recent.reason)}),
          ...(queued.status==='fulfilled'&&running.status==='fulfilled'
            ?{activeCount:(Number(queued.value.total)||0)+(Number(running.value.total)||0),countError:''}
            :{activeCount:null,countError:shortError(queued.status==='rejected'?queued.reason:running.reason)})
        }));
        timer=setTimeout(poll,5000);
      };
      void poll();return()=>{live=false;clearTimeout(timer)};
    },[tab,refreshTick]);
    useEffect(()=>{
      if(tab!=='history')return;
      let live=true,timer,first=true;
      const poll=async()=>{
        await Promise.all([loadTaskHistory({silent:!first}),historyDialogId?loadHistoryDetail(historyDialogId,{silent:true}):Promise.resolve()]);
        first=false;if(live)timer=setTimeout(poll,3000);
      };
      void poll();return()=>{live=false;clearTimeout(timer)};
    },[tab,taskFilters.type,taskFilters.status,taskFilters.from,taskFilters.to,taskHistory.page,taskHistory.pageSize,historyDialogId]);
    useEffect(()=>{
      const tracked=[imageResult.loading&&imageResult.taskId?['image',imageResult.taskId]:null,credentialTaskId?['authorize',credentialTaskId]:null,quotaTaskId?['quota',quotaTaskId]:null].filter(Boolean);
      if(!tracked.length)return;
      let live=true,timer;
      const poll=async()=>{
        await Promise.all(tracked.map(async([kind,id])=>{
          try{const response=await upstream('/local/tasks/'+encodeURIComponent(id),{timeoutMs:15000});if(live)await applyActiveTask(response.task,kind,()=>live)}
          catch(e){if(!live)return;const message='读取任务状态失败：'+shortError(e)+'。可在历史任务中重新查询。';if(kind==='image')setImageResult(x=>({...x,error:message}));else if(kind==='authorize')setCredentialError(message);else setPool(x=>({...x,error:message}))}
        }));
        if(live)timer=setTimeout(poll,2000);
      };
      void poll();return()=>{live=false;clearTimeout(timer)};
    },[imageResult.loading?imageResult.taskId:'',credentialTaskId,quotaTaskId]);
    async function submitTask(type,params){
      const response=await upstream('/local/tasks',{method:'POST',body:{type,params,requestId:requestId()},timeoutMs:45000});
      if(!response.task?.id)throw Error('任务提交未返回任务编号');
      return response.task;
    }
    async function loadTaskFile(file){
      if(taskFileCache.current.has(file.id))return taskFileCache.current.get(file.id);
      if(taskFilePending.current.has(file.id))return taskFilePending.current.get(file.id);
      const pending=(async()=>{
        const result=await upstream('/local/task-files/'+encodeURIComponent(file.id),{timeoutMs:30000});
        if(!/^image\/(png|jpeg|webp|gif)$/.test(result.mimeType)||!result.b64_json)throw Error('结果文件不可用');
        const url=`data:${result.mimeType};base64,${result.b64_json}`;
        taskFileCache.current.set(file.id,url);
        while(taskFileCache.current.size>8)taskFileCache.current.delete(taskFileCache.current.keys().next().value);
        return url;
      })();
      taskFilePending.current.set(file.id,pending);
      try{return await pending}finally{taskFilePending.current.delete(file.id)}
    }
    async function applyActiveTask(task,kind,isLive=()=>true){
      if(!task?.id)return;
      const ended=taskFinished(task);
      if(kind==='image'){
        if(panelStore.get('imageResult')?.taskId!==task.id)return;
        if(!ended){setImageResult(x=>({...x,status:task.status,error:''}));return}
        const file=task.result?.files?.[0]||task.files?.find(file=>file.role==='result');
        let url='',error=task.error||'';
        if(file)try{url=await loadTaskFile(file)}catch(e){error=shortError(e)}
        if(!isLive()||panelStore.get('imageResult')?.taskId!==task.id)return;
        setImageResult({loading:false,taskId:task.id,status:task.status,url,error:url?'':imageFailureText(error||'任务没有可用的结果文件'),format:file?.mimeType==='image/jpeg'?'jpg':file?.mimeType?.split('/')[1]||(task.type==='gif'?'gif':'png')});
        reload();
      }else if(kind==='authorize'){
        if(panelStore.get('credentialTaskId')!==task.id||!ended)return;
        setCredentialTaskId('');setCredentialFeedback(task.result||null);
        await Promise.all([listCredentials(),listAccounts()]);
        setCredentialError(previous=>[task.error,previous].filter(Boolean).join('；'));setCredentialBusy(false);
      }else if(kind==='quota'){
        if(panelStore.get('quotaTaskId')!==task.id)return;
        if(!ended){setPool(x=>({...x,message:`额度刷新${TASK_STATUSES[task.status]||''}：${task.progress?.processed||0}/${task.progress?.total||'?'}…`}));return}
        setQuotaTaskId('');await listAccounts();setDoing(false);
        setPool(x=>({...x,error:[task.error,x.error].filter(Boolean).join('；'),message:`额度刷新${TASK_STATUSES[task.status]||'已结束'}：处理 ${task.result?.processed??0}/${task.result?.total??'—'}，查询异常 ${task.result?.errorCount??0}。`}));
      }
    }
    async function restoreActiveTasks(){
      try{
        const responses=await Promise.all(['queued','running'].map(status=>upstream('/local/tasks?status='+status+'&pageSize=100',{timeoutMs:15000})));
        const items=responses.flatMap(response=>response.items||[]).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
        const image=items.find(task=>['image','gif'].includes(task.type));
        if(image&&!panelStore.get('imageResult')?.taskId&&!panelStore.get('imageResult')?.loading)setImageResult({loading:true,taskId:image.id,status:image.status,url:'',error:'',format:image.type==='gif'?'gif':'png'});
        const authorization=items.find(task=>task.type==='authorize');
        if(authorization&&!panelStore.get('credentialTaskId')){setCredentialTaskId(authorization.id);setCredentialBusy(true)}
        const quota=items.find(task=>task.type==='quota');
        if(quota&&!panelStore.get('quotaTaskId')){setQuotaTaskId(quota.id);setDoing(true)}
      }catch{/* Existing history remains queryable after the service reconnects. */}
    }
    async function restoreLastImageTask(){
      if(panelStore.get('imageResult')?.taskId||panelStore.get('imageResult')?.loading)return;
      try{
        const responses=await Promise.all(['image','gif'].map(type=>upstream('/local/tasks?type='+type+'&pageSize=1',{timeoutMs:15000})));
        const latest=responses.flatMap(response=>response.items||[]).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if(!latest||panelStore.get('imageResult')?.taskId||panelStore.get('imageResult')?.loading)return;
        const response=await upstream('/local/tasks/'+encodeURIComponent(latest.id));
        if(panelStore.get('imageResult')?.taskId||panelStore.get('imageResult')?.loading)return;
        setImageResult({loading:true,taskId:latest.id,status:latest.status,url:'',error:'',format:latest.type==='gif'?'gif':'png'});
        await applyActiveTask(response.task,'image');
      }catch{/* A new image can still be submitted when no previous result is available. */}
    }
    async function loadTaskHistory({silent=false}={}){
      const revision=++historyListRevision;
      if(!silent)setTaskHistory(x=>({...x,loading:true,error:''}));
      const filters={...taskFilters};
      if(filters.from)filters.from=new Date(filters.from+'T00:00:00').toISOString();
      if(filters.to)filters.to=new Date(filters.to+'T23:59:59.999').toISOString();
      const query=new URLSearchParams({...filters,page:String(taskHistory.page),pageSize:String(taskHistory.pageSize)});
      try{
        const response=await upstream('/local/tasks?'+query,{timeoutMs:15000});
        if(revision!==historyListRevision)return;
        setTaskHistory(x=>({...x,...response,items:Array.isArray(response.items)?response.items:[],loading:false,error:''}));
      }catch(e){if(revision===historyListRevision)setTaskHistory(x=>({...x,loading:false,error:shortError(e)}))}
    }
    function closeHistoryDetail(){historyDetailRevision++;setHistoryDialogId('');setTaskFileUrls({});setTaskFileErrors({});taskFileCache.current.clear()}
    function openHistoryDetail(id){setHistoryDialogId(id);setTaskFileUrls({});setTaskFileErrors({});void loadHistoryDetail(id)}
    async function loadHistoryDetail(id,{silent=false}={}){
      const revision=++historyDetailRevision;
      if(!silent)setHistoryDetail({item:null,loading:true,error:''});
      try{
        const response=await upstream('/local/tasks/'+encodeURIComponent(id),{timeoutMs:15000});
        if(revision!==historyDetailRevision)return;
        const task=response.task;
        setHistoryDetail({item:task,loading:false,error:''});
        const files=[...(task?.params?.referenceFiles||[]),...(task?.result?.files||[])];
        await Promise.all(files.slice(0,8).map(async file=>{
          try{const url=await loadTaskFile(file);if(revision===historyDetailRevision)setTaskFileUrls(x=>({...x,[file.id]:url}))}
          catch(e){if(revision===historyDetailRevision)setTaskFileErrors(x=>({...x,[file.id]:shortError(e)}))}
        }));
      }catch(e){if(revision===historyDetailRevision)setHistoryDetail(x=>({...x,loading:false,error:shortError(e)}))}
    }
    async function retryHistoryTask(task){
      if(!globalThis.confirm?.(task.type==='image'||task.type==='gif'?'确认创建新的生成任务？这会再次向上游发起请求。':'确认创建新任务并重试未成功的项目？'))return;
      setHistoryBusy(task.id);
      try{
        const response=await upstream('/local/tasks/'+encodeURIComponent(task.id)+'/retry',{method:'POST',body:{requestId:requestId()},timeoutMs:45000});
        const next=response.task;
        if(['image','gif'].includes(next.type))setImageResult({loading:true,taskId:next.id,status:next.status,url:'',error:'',format:next.type==='gif'?'gif':'png'});
        else if(next.type==='authorize'){setCredentialTaskId(next.id);setCredentialBusy(true)}
        else if(next.type==='quota'){setQuotaTaskId(next.id);setDoing(true)}
        await loadTaskHistory();openHistoryDetail(next.id);
      }catch(e){const error=shortError(e);setTaskHistory(x=>({...x,error}));setHistoryDetail(x=>({...x,error}))}finally{setHistoryBusy('')}
    }
    async function deleteHistoryTask(task){
      if(!globalThis.confirm?.('确认删除这条历史记录？已生成的图片文件会保留。'))return;
      setHistoryBusy(task.id);
      try{await upstream('/local/tasks/'+encodeURIComponent(task.id),{method:'DELETE'});if(historyDialogId===task.id)closeHistoryDetail();await loadTaskHistory()}
      catch(e){const error=shortError(e);setTaskHistory(x=>({...x,error}));if(historyDialogId===task.id)setHistoryDetail(x=>({...x,error}))}finally{setHistoryBusy('')}
    }
    async function reuseImageTask(task){
      setHistoryBusy(task.id);
      try{
        const params=task.params||{};
        const files=await Promise.all((params.referenceFiles||[]).map(async file=>{
          const result=await upstream('/local/task-files/'+encodeURIComponent(file.id),{timeoutMs:30000});
          const bytes=Uint8Array.from(atob(result.b64_json),character=>character.charCodeAt(0));
          return new File([bytes],'reference-'+file.id,{type:result.mimeType});
        }));
        const missing=Number(params.referenceCount||0)>files.length;
        panelStore.set('imagePrefsInitialized',true);
        panelStore.set('imageTaskRestored',true);
        setPrompt(params.prompt||'');setImageModel(params.model||'gpt-image-2');setImageTier(params.resolution||'auto');setAnimatedGif(task.type==='gif');setGifFrameCount(params.frame_count||9);setGifFrameDuration(params.frame_duration_ms||200);setImageFiles(files);setMissingReferenceFiles(missing);changeTab('image');
      }catch(e){setHistoryDetail(x=>({...x,error:'无法沿用参数：'+shortError(e)}))}finally{setHistoryBusy('')}
    }
    function viewTask(id){changeTab('history');openHistoryDetail(id)}
    function renderTaskFiles(files){
      return h('div',{className:'c2a-task-files'},...files.map(file=>h('div',{key:file.id,className:'c2a-task-file'},
        taskFileUrls[file.id]?h(React.Fragment,null,h('img',{src:taskFileUrls[file.id],alt:file.role==='input'?'任务参考图':'任务生成结果'}),h('a',{className:'c2a-download',href:taskFileUrls[file.id],download:`chatgpt2api-${file.id}.${file.mimeType==='image/jpeg'?'jpg':file.mimeType?.split('/')[1]||'png'}`},'下载'+(file.role==='input'?'参考图':'结果'))):h('div',{className:'c2a-task-file-placeholder',role:taskFileErrors[file.id]?'alert':'status'},taskFileErrors[file.id]||'正在读取图片…')
      )));
    }
    function renderHistoryDetail(){
      const task=historyDetail.item;
      return h(Modal,{title:'任务详情',id:'c2a-task-detail-title',onClose:closeHistoryDetail,wide:true,note:task?.type==='api_request'?'请求记录保存在本机；第三方客户端断开后，执行结果可能无法确认。':'任务保存在本机；关闭弹窗或网页后，后台任务会继续执行。'},
        historyDetail.loading?h('p',{role:'status'},'正在读取任务…'):null,
        historyDetail.error?h('div',{className:'c2a-alert',role:'alert'},historyDetail.error):null,
        task?h(React.Fragment,null,
          h('div',{className:'c2a-task-detail-title'},h('h3',null,TASK_TYPES[task.type]||task.type),h(Chip,{kind:taskKind(task)},TASK_STATUSES[task.status]||task.status)),
          h('p',{className:'c2a-task-id'},task.id),
          h('div',{className:'c2a-task-meta'},h('span',null,'创建：'+formatKeyDate(task.createdAt)),h('span',null,'开始：'+formatKeyDate(task.startedAt)),h('span',null,'结束：'+formatKeyDate(task.finishedAt)),h('span',null,'耗时：'+taskDuration(task))),
          task.parentTaskId?h('p',{className:'c2a-help'},'原任务：'+task.parentTaskId):null,
          task.error?h('div',{className:'c2a-alert',role:'alert'},task.error):null,
          task.type==='api_request'?h(React.Fragment,null,
            h('div',{className:'c2a-task-meta'},h('span',null,'接口：'+(task.params?.method||'POST')+' '+(task.params?.path||'—')),h('span',null,'模型：'+(task.params?.model||'—')),h('span',null,'流式响应：'+(typeof task.params?.stream==='boolean'?(task.params.stream?'是':'否'):'未记录')),h('span',null,'HTTP 状态：'+(task.result?.httpStatus||'—'))),
            h('h4',null,'请求文本摘要'),h('p',{className:'c2a-task-prompt'},task.params?.prompt||'未记录文本内容'),
            h('h4',null,'用量'),
            task.result?.usage?h('div',{className:'c2a-task-meta'},h('span',null,'输入：'+(task.result.usage.input_tokens??task.result.usage.prompt_tokens??'—')+' Token'),h('span',null,'输出：'+(task.result.usage.output_tokens??task.result.usage.completion_tokens??'—')+' Token'),h('span',null,'总计：'+(task.result.usage.total_tokens??'—')+' Token')):h('p',{className:'c2a-help'},'未记录到用量。'),
            task.result?.files?.length?h(React.Fragment,null,h('h4',null,'生成结果'),renderTaskFiles(task.result.files)):task.params?.path?.startsWith('/v1/images/')?h('p',{className:'c2a-help'},taskFinished(task)?'这条请求未保存图片结果。':'图片生成中，完成后可在此查看结果。'):null,
            task.result?.imageError?h('p',{className:'c2a-alert',role:'alert'},task.result.imageError):null,
            h('p',{className:'c2a-help'},'保存请求摘要、状态和已采集的图片结果；完整对话和原始响应不在此处保存。')
          ):['image','gif'].includes(task.type)?h(React.Fragment,null,
            h('div',{className:'c2a-task-meta'},h('span',null,'模型：'+(task.params?.model||'—')),h('span',null,'分辨率：'+(task.params?.resolution||task.params?.size||'自动')),task.type==='gif'?h('span',null,`动画：${task.params?.frame_count||9} 帧 · ${task.params?.frame_duration_ms||200} 毫秒/帧`):null),
            h('h4',null,'提示词'),h('p',{className:'c2a-task-prompt'},task.params?.prompt||'—'),
            task.params?.referenceFiles?.length?h(React.Fragment,null,h('h4',null,'参考图片'),renderTaskFiles(task.params.referenceFiles)):null,
            task.result?.files?.length?h(React.Fragment,null,h('h4',null,'生成结果'),renderTaskFiles(task.result.files)):h('p',{className:'c2a-help'},taskFinished(task)?'没有可用的生成结果。':'任务正在后台执行，可关闭本窗口稍后查看。')
          ):h(React.Fragment,null,
            h('p',{className:'c2a-info'},taskSummary(task)),
            task.type==='quota'&&Number(task.progress?.total)>0?h('progress',{className:'c2a-task-progress',max:task.progress.total,value:Math.min(task.progress.processed||0,task.progress.total),'aria-label':'账号额度刷新进度'}):null,
            task.result?.failures?.length?h('div',{className:'c2a-tablewrap'},h('table',{className:'c2a-table'},h('thead',null,h('tr',null,h('th',null,'账号'),h('th',null,'失败原因'))),h('tbody',null,...task.result.failures.map((failure,i)=>h('tr',{key:failure.id||i},h('td',null,failure.email||'—'),h('td',null,failure.error||'未返回具体原因')))))):null,
            task.result?.errors?.length?h('ul',{className:'c2a-help'},...task.result.errors.map((error,i)=>h('li',{key:i},`第 ${error.line} 行：${error.reason}`))):null
          ),
          h('div',{className:'c2a-formrow c2a-task-detail-actions'},
            ['image','gif'].includes(task.type)?h(Btn,{onClick:()=>reuseImageTask(task),disabled:!!historyBusy},'沿用参数'):task.type!=='api_request'?h(Btn,{onClick:()=>changeTab('accounts')},'查看号池'):null,
            task.type!=='api_request'&&['failed','partial','interrupted'].includes(task.status)&&(task.type!=='authorize'||task.result?.failures?.length||task.status==='interrupted')?h(Btn,{onClick:()=>retryHistoryTask(task),primary:true,disabled:!!historyBusy},task.type==='authorize'?'重试失败项':'创建重试任务'):null,
            h(Btn,{onClick:()=>loadHistoryDetail(task.id),disabled:historyDetail.loading},'刷新详情'),
            h(Btn,{onClick:()=>deleteHistoryTask(task),danger:true,disabled:!!historyBusy||!taskFinished(task)},'删除记录')
          )
        ):null
      );
    }
    useEffect(()=>{
      const el=mainRef.current;
      if(!el||typeof el.addEventListener!=='function')return;
      let raf=0;
      const onScroll=()=>{
        if(raf)return;
        const owner=tabRef.current,top=el.scrollTop;
        const remember=()=>{raf=0;tabScroll.set(owner,top)};
        raf=typeof requestAnimationFrame==='function'?requestAnimationFrame(remember):setTimeout(remember,80);
      };
      el.addEventListener('scroll',onScroll,{passive:true});
      return()=>{
        el.removeEventListener('scroll',onScroll);
        if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(raf);else clearTimeout(raf);
      };
    },[]);
    useEffect(()=>{
      let alive=true;
      const load=async()=>{
        try{
          const result=await upstream('/health?format=json',{timeoutMs:9000});
          if(alive){setHealth({loading:false,data:result,error:'',updatedAt:Date.now()});setBaseUrl(result?.baseUrl||DEFAULT_URL)}
        }catch(e){if(alive)setHealth(x=>({...x,loading:false,error:shortError(e)}))}
      };
      load();const timer=setInterval(load,15000);
      return()=>{alive=false;clearInterval(timer)};
    },[refreshTick]);
    async function upstream(path,{method='GET',body,timeoutMs=140000}={}){
      // The DSH Host authenticates this browser session and adds the backend's
      // private admin secret on the Host side. No password is ever requested.
      const controller=new AbortController(),t=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const res=await fetch('/api/chatgpt2api-native/manage',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({path,method,body}),signal:controller.signal
        });
        return parseJsonResponse(res,await res.text());
      }catch(e){if(controller.signal.aborted)throw Error('服务请求超时');throw e}finally{clearTimeout(t)}
    }
    useEffect(()=>{
      // Revalidate in the background when a snapshot already exists, so a
      // returning panel shows its previous content and then updates in place
      // instead of flashing "加载中…" like a fresh page load.
      if(tab==='accounts'){void listAccounts({silent:pool.loaded});void listCredentials();void loadProxy();}
      else if(tab==='settings')void loadProxy();
      else if(tab==='api')void loadUserKeys({silent:userKeysLoaded});
      else if(tab==='advanced')void refreshPools({silent:poolsLoaded});
      else if(tab==='image'){void loadImagesFolder();void loadImagePreferences();void loadImageModels();void loadGifCapability();}
    },[tab]);
    function copyWithFeedback(text, id){
      copyToClipboard(text, ()=>{
        setCopiedId(id);
        setTimeout(()=>setCopiedId(cur=>cur===id?null:cur), 2000);
      });
    }
    function toggleReveal(id){
      setRevealedKeys(prev=>({...prev,[id]:!prev[id]}));
    }
    function mergeUserKeysWithLocal(items){
      const local=getLocalUserKeys();
      const list=Array.isArray(items)?items:[];
      return list.map(item=>{
        const id=String(item.id||'');
        const k=String(item.key||local[id]?.key||'');
        if(item.key&&!local[id]?.key)saveLocalUserKey(id,item.key,item.name);
        return {...item,key:k};
      });
    }
    async function loadUserKeys({silent=false}={}){
      if(!silent)setUserKeyBusy(true);
      setUserKeyError('');
      try{
        const json=await upstream('/api/auth/users',{timeoutMs:15000});
        setUserKeys(mergeUserKeysWithLocal(json?.items));
        setUserKeysLoaded(true);
      }catch(e){setUserKeyError(shortError(e))}finally{if(!silent)setUserKeyBusy(false)}
    }
    function generateRandomApiKey(){
      const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let s='';
      if(globalThis.crypto?.getRandomValues){
        const b=new Uint8Array(28);
        globalThis.crypto.getRandomValues(b);
        for(let i=0;i<28;i++) s+=chars[b[i]%chars.length];
      }else{
        for(let i=0;i<28;i++) s+=chars[Math.floor(Math.random()*chars.length)];
      }
      return 'sk-'+s;
    }
    async function resetUserKey(id, customKey=null){
      let nextKey=(customKey?String(customKey).trim():'');
      if(!nextKey){
        nextKey=generateRandomApiKey();
      }
      setUserKeyBusy(true);setUserKeyError('');
      try{
        const json=await upstream('/api/auth/users/'+encodeURIComponent(String(id)),{
          method:'POST',
          body:{key:nextKey},
          timeoutMs:15000
        });
        saveLocalUserKey(id,nextKey);
        setUserKeyPlain(nextKey);
        const merged=mergeUserKeysWithLocal(json?.items);
        setUserKeys(merged);
        copyWithFeedback(nextKey,'new-key');
      }catch(e){
        setUserKeyError(shortError(e));
      }finally{
        setUserKeyBusy(false);
      }
    }
    async function promptCustomKey(item){
      const currentName=item?.name||'该密钥';
      const input=globalThis.prompt?.(`为「${currentName}」设置自定义 API Key（留空将自动生成随机 sk- 密钥）：`,'');
      if(input===null)return;
      await resetUserKey(item.id, input.trim()||null);
    }
    async function createUserKey(){
      const name=userKeyName.trim()||'本机应用';
      const customKey=userKeyCustom.trim();
      setUserKeyBusy(true);setUserKeyError('');setUserKeyPlain('');
      try{
        const json=await upstream('/api/auth/users',{method:'POST',body:{name},timeoutMs:15000});
        const rawItems=Array.isArray(json.items)?json.items:[];
        const newId=String(json.id||json.item?.id||rawItems.find(x=>x.name===name)?.id||'');
        let finalKey=String(json.key||'');
        if(customKey&&newId){
          const upd=await upstream('/api/auth/users/'+encodeURIComponent(newId),{
            method:'POST',
            body:{key:customKey},
            timeoutMs:15000
          });
          finalKey=customKey;
          saveLocalUserKey(newId,finalKey,name);
          setUserKeys(mergeUserKeysWithLocal(upd?.items));
        }else{
          if(newId&&finalKey){
            saveLocalUserKey(newId,finalKey,name);
          }
          setUserKeys(mergeUserKeysWithLocal(rawItems));
        }
        setUserKeyPlain(finalKey);
        setUserKeyCustom('');
        copyWithFeedback(finalKey,'new-key');
      }catch(e){setUserKeyError(shortError(e))}finally{setUserKeyBusy(false)}
    }
    async function revokeUserKey(id){
      if(!globalThis.confirm?.('确认吊销这个 API Key？使用它的第三方软件会立即无法调用。'))return;
      setUserKeyBusy(true);setUserKeyError('');
      try{
        const json=await upstream('/api/auth/users/'+encodeURIComponent(String(id)),{method:'DELETE',timeoutMs:15000});
        removeLocalUserKey(id);
        const merged=mergeUserKeysWithLocal(json?.items);
        setUserKeys(merged);
        if(userKeyPlain&&!merged.some(x=>x.key===userKeyPlain))setUserKeyPlain('');
      }catch(e){setUserKeyError(shortError(e))}finally{setUserKeyBusy(false)}
    }
    async function importAccountsJson(){
      let body;try{
        const x=JSON.parse(importJson);
        let items=Array.isArray(x)?x:(Array.isArray(x?.accounts)?x.accounts:Array.isArray(x?.items)?x.items:x&&typeof x==='object'?[x]:[]);
        if(!items.length||items.length>100||items.some(item=>!item||typeof item!=='object'||!String(item.access_token||item.accessToken||'').trim()))throw Error('JSON 应包含 1~100 条带 access_token 的账号对象');
        body={accounts:items};
      }catch(e){setAdvancedError('导入 JSON 无效：'+e.message);return}
      setAdvancedBusy(true);setAdvancedError('');setImportMessage('');
      try{const r=await upstream('/api/accounts',{method:'POST',body,timeoutMs:150000});setImportJson('');setImportMessage(`导入成功，新增 ${r?.added??'—'} 个，跳过 ${r?.skipped??'—'} 个。`);await listAccounts()}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function refreshPools({silent=false}={}){
      if(!silent)setAdvancedBusy(true);
      setAdvancedError('');
      try{const [a,b]=await Promise.all([upstream('/api/cpa/pools'),upstream('/api/sub2api/servers')]);setCpaPools(Array.isArray(a?.pools)?a.pools:[]);setSubServers(Array.isArray(b?.servers)?b.servers:[]);setPoolsLoaded(true)}
      catch(e){setAdvancedError(shortError(e))}finally{if(!silent)setAdvancedBusy(false)}
    }
    async function createCpaPool(){
      if(!cpaDraft.base_url||!cpaDraft.secret_key){setAdvancedError('请输入 CPA 服务器地址和密钥');return}
      setAdvancedBusy(true);setAdvancedError('');
      try{const r=await upstream('/api/cpa/pools',{method:'POST',body:cpaDraft});setCpaPools(Array.isArray(r?.pools)?r.pools:[]);setCpaDraft({name:'',base_url:'',secret_key:''});setImportMessage('CPA 连接已保存，请选择连接加载文件。')}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function loadCpaFiles(){if(!cpaPool)return;setAdvancedBusy(true);setAdvancedError('');setCpaFiles([]);setCpaSelection([]);
      try{const r=await upstream('/api/cpa/pools/'+encodeURIComponent(cpaPool)+'/files',{timeoutMs:30000});setCpaFiles(Array.isArray(r?.files)?r.files:[])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function importCpaFiles(){if(!cpaPool||!cpaSelection.length)return;setAdvancedBusy(true);setAdvancedError('');
      try{const r=await upstream('/api/cpa/pools/'+encodeURIComponent(cpaPool)+'/import',{method:'POST',body:{names:cpaSelection},timeoutMs:30000});setImportMessage('CPA 导入任务已提交；请在号池页刷新账号列表。');setCpaSelection([])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function createSubServer(){if(!subDraft.base_url||!subDraft.api_key){setAdvancedError('请输入 sub2api 地址和 API Key');return}
      setAdvancedBusy(true);setAdvancedError('');try{const r=await upstream('/api/sub2api/servers',{method:'POST',body:subDraft});setSubServers(Array.isArray(r?.servers)?r.servers:[]);setSubDraft({name:'',base_url:'',api_key:''});setImportMessage('sub2api 服务器连接已保存。')}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function loadSubAccounts(){if(!subServer)return;setAdvancedBusy(true);setAdvancedError('');setSubAccounts([]);setSubSelection([]);
      try{const r=await upstream('/api/sub2api/servers/'+encodeURIComponent(subServer)+'/accounts',{timeoutMs:30000});setSubAccounts(Array.isArray(r?.accounts)?r.accounts:[])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function importSubAccounts(){if(!subServer||!subSelection.length)return;setAdvancedBusy(true);setAdvancedError('');
      try{await upstream('/api/sub2api/servers/'+encodeURIComponent(subServer)+'/import',{method:'POST',body:{account_ids:subSelection},timeoutMs:30000});setImportMessage('sub2api 导入任务已提交；请在号池页刷新账号列表。');setSubSelection([])}
      catch(e){setAdvancedError(shortError(e))}finally{setAdvancedBusy(false)}
    }
    async function listAccounts({silent=false}={}){
      const revision=++accountListRevision;
      if(!silent)setPool(x=>({...x,loading:true,error:''}));
      try{
        const json=await upstream('/api/accounts',{timeoutMs:15000});
        if(revision!==accountListRevision)return;
        const items=Array.isArray(json.items)?json.items:[];
        const refs=new Set(items.map(accountToken).filter(Boolean));
        setPool(x=>({...x,loading:false,loaded:true,items,error:'',message:silent?x.message:'已更新账号列表'}));
        setAccountSelection(prev=>prev.filter(ref=>refs.has(ref)));
        setAccountPage(page=>Math.min(page,Math.max(1,Math.ceil(items.length/(panelStore.get('accountPageSize')||10)))));
        if(silent)refreshInBackground();else reload();
      }catch(e){if(revision===accountListRevision)setPool(x=>({...x,loading:false,error:shortError(e)}))}
    }
    async function listCredentials(){
      try{const r=await upstream('/local/credential-vault',{timeoutMs:15000});setCredentialItems(Array.isArray(r?.items)?r.items:[]);setCredentialError('')}
      catch(e){setCredentialError(shortError(e))}
    }
    async function importCredentialLines(){
      if(!credentialText.trim()){setCredentialError('请输入每行一条的账号文本');return}
      if(new TextEncoder().encode(credentialText).length>1024*1024){setCredentialError('单次导入最多 1MB');return}
      setCredentialBusy(true);setCredentialError('');setCredentialFeedback(null);
      try{
        const r=await upstream('/local/credential-vault',{method:'POST',body:{text:credentialText},timeoutMs:40000});
        setCredentialFeedback(r);setCredentialText('');await listCredentials();
      }catch(e){setCredentialError(shortError(e))}finally{setCredentialBusy(false)}
    }
    async function startAuthorization(params){
      if(panelStore.get('credentialBusy'))return;
      setCredentialBusy(true);setCredentialError('');setCredentialFeedback(null);
      try{const task=await submitTask('authorize',params);setCredentialTaskId(task.id);setCredentialText('');await listCredentials()}
      catch(e){setCredentialError(shortError(e));setCredentialBusy(false)}
    }
    async function importAndAuthenticate(){
      if(!credentialText.trim()){setCredentialError('请输入每行一条的账号文本');return}
      if(new TextEncoder().encode(credentialText).length>1024*1024){setCredentialError('单次导入最多 1MB');return}
      await startAuthorization({text:credentialText});
    }
    async function authenticateCredential(item){if(item?.id)await startAuthorization({id:item.id})}
    async function authenticateAllCredentials(){if(credentialItems.length)await startAuthorization({all:true})}
    async function deleteCredential(item){
      if(!item?.id)return;
      if(!globalThis.confirm?.(`确认删除 ${item?.email||'该账号'} 的本地加密暂存记录？`))return;
      setCredentialBusy(true);setCredentialError('');
      try{await upstream('/local/credential-vault/'+encodeURIComponent(item.id),{method:'DELETE',timeoutMs:15000});await listCredentials()}
      catch(e){setCredentialError(shortError(e))}finally{setCredentialBusy(false)}
    }
    async function loadCredentialFile(file){
      if(!file)return;
      if(file.size>1024*1024){setCredentialError('文本文件超过 1MB');return}
      try{setCredentialText(await file.text());setCredentialFeedback(null);setCredentialError('')}
      catch{setCredentialError('文本文件读取失败')}
    }
    async function loadProxy(){
      try{
        const result=await upstream('/local/proxy',{timeoutMs:15000});
        setProxyState(x=>({...x,url:result.url||'',draft:result.url||'',configured:!!result.configured,hasCredentials:!!result.hasCredentials,error:''}));
      }catch(e){setProxyState(x=>({...x,error:'读取代理配置失败：'+shortError(e)}))}
    }
    async function saveProxy(){
      setProxyState(x=>({...x,busy:true,error:'',message:'',test:null}));
      try{
        const result=await upstream('/local/proxy',{method:'POST',body:{url:proxyState.draft.trim()},timeoutMs:20000});
        setProxyState(x=>({...x,busy:false,url:result.url||'',draft:result.url||'',configured:!!result.configured,hasCredentials:false,message:'代理已保存。请点击“全部刷新额度”重新查询账号，代理需保持开启。'}));
      }catch(e){setProxyState(x=>({...x,busy:false,error:shortError(e)}))}
    }
    async function testProxy(){
      setProxyState(x=>({...x,busy:true,error:'',message:'',test:null}));
      try{
        const response=await upstream('/local/proxy/test',{method:'POST',body:{url:proxyState.draft.trim()},timeoutMs:35000});
        setProxyState(x=>({...x,busy:false,test:response?.result||null}));
      }catch(e){setProxyState(x=>({...x,busy:false,error:shortError(e)}))}
    }
    async function startQuotaTask(params={}){
      if(panelStore.get('doing'))return;
      setDoing(true);setPool(x=>({...x,error:'',message:'正在提交额度刷新任务…'}));
      try{const task=await submitTask('quota',params);setQuotaTaskId(task.id);setPool(x=>({...x,message:'额度刷新任务已提交，可在历史任务中查看进度。'}))}
      catch(e){setPool(x=>({...x,error:shortError(e)}));setDoing(false)}
    }
    async function refreshAllAccounts(){
      if(panelStore.get('doing'))return;
      const count=tab==='overview'?Number(acc.total)||0:pool.items.length;
      if(!count)return;
      if(typeof globalThis.confirm==='function'&&!globalThis.confirm(`确定刷新全部 ${count} 个账号的额度？这会向上游发起网络请求。`))return;
      await startQuotaTask();
    }
    async function addAccount(){
      const token=newToken.trim();if(!token){setPool(x=>({...x,error:'请填写你有权使用的账号 access_token'}));return}
      if(token.length>12000){setPool(x=>({...x,error:'账号凭据长度不合法'}));return}
      setDoing(true);setPool(x=>({...x,error:'',message:'正在导入并验证账号…'}));
      try{const r=await upstream('/api/accounts',{method:'POST',body:{tokens:[token]},timeoutMs:160000});setNewToken('');setPool(x=>({...x,message:`导入完成：新增 ${r?.added??'—'} 个；请刷新查看状态。`}));await listAccounts()}
      catch(e){setPool(x=>({...x,error:shortError(e)}))}finally{setDoing(false)}
    }
    async function deleteAccount(item){
      const t=accountToken(item);if(!t)return;
      const title=String(item?.email||'该账号');
      if(!globalThis.confirm?.(`确认移除 ${title}？这会从号池中删除该账号。`))return;
      await removeAccountRefs([t]);
    }
    async function deleteSelectedAccounts(){
      if(!selectedAccountRefs.length||panelStore.get('doing'))return;
      if(!globalThis.confirm?.(`确认从号池中删除已选的 ${selectedAccountRefs.length} 个账号？包含其他分页中勾选的账号。此操作无法撤销，请确认已备份需要保留的凭据。`))return;
      await removeAccountRefs(selectedAccountRefs,true);
    }
    async function removeAccountRefs(refs,batch=false){
      if(panelStore.get('doing'))return;
      accountListRevision++;
      setDoing(true);setPool(x=>({...x,error:'',message:batch?'正在批量删除已选账号…':'正在删除账号…'}));
      let removed=0,failure='';
      try{
        for(let offset=0;offset<refs.length;offset+=100){
          const group=refs.slice(offset,offset+100);
          const result=await upstream('/api/accounts',{method:'DELETE',body:{tokens:group},timeoutMs:30000});
          removed+=Math.min(group.length,Math.max(0,Number(result?.removed)||0));
          setPool(x=>({...x,message:`正在删除：已确认移除 ${removed}/${refs.length} 个账号…`}));
        }
      }catch(e){failure=shortError(e)}
      try{
        await listAccounts();
        setPool(x=>({...x,error:[failure,x.error].filter(Boolean).join('；'),message:`${batch?'批量删除':'删除'}${failure?'未完成':'完成'}：已确认删除 ${removed} 个账号。`+((failure||removed<refs.length)?'请核对列表，仍在号池中的已选账号会保留勾选。':'')}));
      }finally{setDoing(false)}
    }
    async function refreshAccount(item){const ref=accountToken(item);if(ref)await startQuotaTask({ref})}
    async function loadImageModels(){
      setImageModels(x=>({...x,loading:true,error:''}));
      try{
        const r=await upstream('/local/models',{timeoutMs:25000});
        const items=Array.isArray(r.models)?r.models:[];
        setImageModels({items,loading:false,error:items.length?'':'上游没有返回可用模型'});
      }catch(e){setImageModels(x=>({...x,loading:false,error:shortError(e)}))}
    }
    async function loadImagePreferences(){
      try{
        const r=await upstream('/local/image-preferences',{timeoutMs:10000});
        const defaultModel=String(r.defaultModel||'gpt-image-2');
        const defaultImageTier=String(r.defaultImageTier||'auto');
        setImagePrefs(x=>({...x,defaultModel,defaultImageTier,loaded:true,error:''}));
        // Only initialize the drafts from defaults once per page lifetime.
        if(!panelStore.get('imagePrefsInitialized')){
          setImageModel(defaultModel);setImageTier(defaultImageTier);
          panelStore.set('imagePrefsInitialized',true);
        }
      }catch(e){setImagePrefs(x=>({...x,error:'读取图片偏好失败：'+shortError(e)}))}
    }
    async function saveImagePreferences(){
      setImagePrefs(x=>({...x,saving:true,error:'',message:''}));
      try{
        const r=await upstream('/local/image-preferences',{method:'POST',body:{defaultModel:imageModel,defaultImageTier:imageTier},timeoutMs:10000});
        setImagePrefs(x=>({...x,defaultModel:r.defaultModel,defaultImageTier:r.defaultImageTier,saving:false,loaded:true,message:'默认模型和分辨率已保存'}));
      }catch(e){setImagePrefs(x=>({...x,saving:false,error:shortError(e)}))}
    }
    async function loadGifCapability(){
      try{
        const result=await upstream('/local/gif-capabilities',{timeoutMs:10000});
        setGifCapability({enabled:result.enabled===true,loaded:true,supportedModels:result.supportedModels||[]});
      }catch{setGifCapability({enabled:false,loaded:true})}
    }
    async function generate(){
      if(panelStore.get('imageResult')?.loading)return;
      const pr=prompt.trim();if(!pr){setImageResult({loading:false,url:'',error:'请输入提示词'});return}
      if(missingReferenceFiles){setImageResult({loading:false,url:'',error:'原任务的参考图片未完整保存，请重新选择参考图片后再生成。'});return}
      if(animatedGif&&imageFiles.length){setImageResult({loading:false,url:'',error:'原生 GIF 暂仅支持文生图，请移除参考图片'});return}
      if(animatedGif&&gifCapability.loaded&&!gifCapability.enabled){setImageResult({loading:false,url:'',error:text('当前号池 GIF 通道不可用，请重启 DSH 及托管后端','当前号池 GIF 通道不可用，请重启程序及托管后端')});return}
      if(animatedGif&&(!Number.isInteger(Number(gifFrameCount))||Number(gifFrameCount)<2||Number(gifFrameCount)>16)){setImageResult({loading:false,url:'',error:'GIF 帧数须为 2–16'});return}
      if(animatedGif&&(!Number.isInteger(Number(gifFrameDuration))||Number(gifFrameDuration)<20||Number(gifFrameDuration)>2000||Number(gifFrameDuration)%10)){setImageResult({loading:false,url:'',error:'每帧时长须为 20–2000 毫秒且为 10 毫秒整数倍'});return}
      if(imageFiles.length>4){setImageResult({loading:false,url:'',error:'最多选择 4 张参考图'});return}
      if(imageFiles.some(x=>x.size>MAX_FILE_SIZE)){setImageResult({loading:false,url:'',error:'每张参考图不得超过 12 MB'});return}
      setImageResult({loading:true,url:'',error:''});
      try{
        const images=await Promise.all(imageFiles.map(file=>new Promise((resolve,reject)=>{
          const reader=new FileReader();reader.onerror=()=>reject(Error('图片读取失败'));
          reader.onload=()=>{
            const result=String(reader.result||''),raw=result.split(',')[1]||'';
            if(!raw)return reject(Error('图片为空'));
            resolve({b64_json:raw,mime_type:file.type||'image/png'});
          };
          reader.readAsDataURL(file);
        })));
        const task=await submitTask(animatedGif?'gif':'image',{model:imageModel,prompt:pr,n:1,response_format:'b64_json',...(animatedGif?{size:'auto',output_format:'gif',frame_count:Number(gifFrameCount),frame_duration_ms:Number(gifFrameDuration)}:{resolution:imageTier}),...(images.length?{images}:{})});
        setImageResult({loading:true,taskId:task.id,status:task.status,url:'',error:'',format:animatedGif?'gif':'png'});
      }catch(e){setImageResult({loading:false,url:'',error:imageFailureText(shortError(e))})}
    }
    async function loadImagesFolder(){
      try{
        const r=await upstream('/local/open-images-dir',{method:'GET',timeoutMs:10000});
        setFolderInfo({dir:String(r?.dir||''),count:Number(r?.count||0)});
      }catch{/* Host older than this panel: the path stays hidden until a restart. */}
    }
    async function openImagesFolder(){
      setFolderBusy(true);setFolderNote('');
      try{
        const r=await upstream('/local/open-images-dir',{method:'POST',timeoutMs:15000});
        setFolderInfo({dir:String(r?.dir||''),count:Number(r?.count||0)});
        setFolderNote(r?.opened
          ?`已请求在文件管理器中打开（当前 ${Number(r?.count)||0} 张图片）。如果没看到窗口，可能被当前窗口挡住或在任务栏；也可以直接复制下面的地址打开。`
          :`无法自动打开：${r?.error||'系统没有可用的文件管理器'}。请复制下面的地址，在资源管理器/访达中粘贴打开。`);
      }catch(e){
        const raw=shortError(e);
        setFolderNote(/未授权|404/.test(raw)
          ?text('当前 DSH 仍在运行旧版插件 Host，重启 DSH 后即可显示目录地址。','管理接口版本不匹配，请重启程序后重试。')
          :'打开失败：'+raw);
      }finally{setFolderBusy(false)}
    }
    const overviewStats=[
      ['可用账号',online?number(acc.active):'—',online?' / '+number(acc.total):'',online?'可用 / 已导入账号':'等待服务连接'],
      ['剩余额度',online?number(acc.total_quota):'—','',quotaTaskId?pool.message:'来自最近一次账号额度查询'],
      ['进行中任务',overviewTasks.activeCount===null?'—':number(overviewTasks.activeCount),'',overviewTasks.countError?'任务计数暂不可用':'含排队与执行中的全部任务'],
      ['需关注账号',online?number(attentionCount):'—','','限流、异常及已禁用账号']
    ];
    return h('div',{className:'c2a-root','data-theme':theme},
      h('header',{className:'c2a-header'},
        h('div',{className:'c2a-brand'},h('span',{className:'c2a-logo'},h(LogoMark)),h('div',null,h('strong',null,'ChatGPT2API · 号池'),h('small',null,'跨平台 本地号池 · 通用 OpenAI 兼容接口'))),
        h('div',{className:'c2a-headright'},h(Chip,{kind:serviceKind},serviceLabel),h('span',{className:'c2a-version'},online?'v'+(data.version||'—'):text('插件 v0.6.2','独立运行')),
          h('button',{type:'button',className:'c2a-button c2a-theme-toggle',onClick:toggleTheme,'aria-label':theme==='dark'?'切换为浅色主题':'切换为暗色主题',title:theme==='dark'?'切换为浅色主题':'切换为暗色主题'},h('span',{'aria-hidden':true},theme==='dark'?'☀':'☾'),h('span',null,theme==='dark'?'浅色':'暗色')),
          h(Btn,{onClick:reload,disabled:health.loading},health.loading?'检测中…':'刷新'))
      ),
      h('nav',{className:'c2a-tabbar','aria-label':'号池功能'},...PAGES.map(([id,label,icon])=>h('button',{key:id,type:'button',className:'c2a-tab'+(tab===id?' selected':''),onClick:()=>changeTab(id)},h('span',{className:'c2a-tabicon'},icon),label))),
      h('main',{className:'c2a-main',ref:mainRef},
        tab==='overview'?h('div',{className:'c2a-overview'},
          h('div',{className:'c2a-overview-head'},
            h('div',null,h('h1',null,'运行总览'),h('p',null,health.error?health.error:firstUse?'完成账号和密钥配置，开始连接本机客户端。':online&&!ready?'后端已连接，请检查账号状态及可用额度。':'查看账号池、任务进度和本机 API 连接信息。')),
            h('div',{className:'c2a-overview-status'},h(Chip,{kind:serviceKind},serviceLabel),h('small',null,health.updatedAt?'最近检查 '+new Date(health.updatedAt).toLocaleTimeString('zh-CN',{hour12:false}):health.error?'尚无成功检查':'等待首次检查'),
              health.error?h(Btn,{onClick:()=>changeTab('settings')},'查看运行设置'):online&&hasAccounts&&!ready?h(Btn,{onClick:()=>changeTab('accounts')},'检查账号池'):null)
          ),
          firstUse?h('section',{className:'c2a-onboarding','aria-label':'首次使用引导'},
            h('div',null,h('h2',null,'开始使用本机号池'),h('p',null,'后端已连接，接下来完成这三步。')),
            h('ol',{className:'c2a-setup-steps'},
              ...[
                ['导入账号','添加你有权使用的账号。','导入账号',()=>{changeTab('accounts');openAccountDialog('import')}],
                ['检查额度','导入后查询账号可用额度。','检查额度',()=>{changeTab('accounts');openAccountDialog('proxy')}],
                ['创建密钥','为第三方客户端配置 API Key。','创建密钥',()=>changeTab('api')]
              ].map(([title,description,label,onClick],index)=>h('li',{key:title},h('span',{className:'c2a-step-number'},index+1),h('div',null,h('strong',null,title),h('small',null,description),h(Btn,{onClick,primary:index===0},label))))
            )
          ):null,
          h('section',{className:'c2a-overview-stats','aria-label':'号池关键数据'},...overviewStats.map(([name,value,suffix,note],index)=>h('article',{className:'c2a-overview-stat'+(index===3&&online&&attentionCount?' attention':''),key:name},
            h('div',{className:'c2a-stat-heading'},name,index===1?h(Btn,{cls:'c2a-quota-refresh',onClick:refreshAllAccounts,disabled:doing||!online||!hasAccounts,title:'刷新全部账号额度'},doing?'刷新中…':'刷新'):null),
            h('strong',null,value,suffix?h('small',null,suffix):null),h('p',null,note),
            index===1&&pool.error?h('p',{className:'c2a-quota-error',role:'alert'},pool.error):null
          ))),
          h('div',{className:'c2a-overview-grid'},
            h(Card,{title:'最近任务',cls:'c2a-recent-card',actions:h(Btn,{onClick:()=>{setTaskFilters({type:'',status:'',from:'',to:''});setTaskHistory(x=>({...x,page:1}));changeTab('history')}},'全部任务 →')},
              overviewTasks.error?h('div',{className:'c2a-overview-error',role:'alert'},h('p',null,(overviewTasks.loaded?'任务刷新失败，以下为上次结果：':'任务读取失败：')+overviewTasks.error),h(Btn,{onClick:refreshInBackground},'重试读取任务')):null,
              overviewTasks.countError?h('p',{className:'c2a-help',role:'status'},'进行中任务计数暂不可用：'+overviewTasks.countError):null,
              overviewTasks.loading&&!overviewTasks.loaded?h('div',{className:'c2a-overview-skeleton',role:'status'},'正在读取最近任务…'):null,
              overviewTasks.items.length?h('div',{className:'c2a-recent-list'},...overviewTasks.items.map(task=>h('button',{type:'button',className:'c2a-recent-task',key:task.id,onClick:()=>viewTask(task.id)},
                h('span',{className:'c2a-task-type','aria-hidden':true},({image:'▧',gif:'▧',api_request:'⇄',authorize:'◉',quota:'↻'})[task.type]||'◷'),
                h('div',{className:'c2a-recent-main'},h('strong',null,task.summary||TASK_TYPES[task.type]||'任务记录'),h('small',null,(TASK_TYPES[task.type]||task.type)+' · '+formatKeyDate(task.createdAt))),
                h('div',{className:'c2a-recent-meta'},h(Chip,{kind:taskKind(task)},TASK_STATUSES[task.status]||task.status),h('small',null,taskDuration(task))),
                h('span',{className:'c2a-recent-arrow','aria-hidden':true},'›')
              ))):overviewTasks.loaded&&!overviewTasks.error?h('div',{className:'c2a-overview-empty'},h('h4',null,'还没有任务记录'),h('p',null,'图片生成、账号授权、额度刷新及 API 请求会记录在这里。'),h(Btn,{onClick:()=>changeTab('image')},'前往图片生成')):null
            ),
            h('aside',{className:'c2a-overview-side'},
              h(Card,{title:'API 接入',cls:'c2a-connect-card'},
                h('p',{className:'c2a-help'},'将以下地址填入 Cherry Studio 等客户端。'),
                h('span',{className:'c2a-fieldlabel'},'OpenAI 兼容 Base URL'),
                h('div',{className:'c2a-endpoint-row'},h('code',null,apiBaseUrl||'地址待配置'),h(Btn,{disabled:!apiBaseUrl,cls:copiedId==='overview-url'?'copied':'',onClick:()=>copyWithFeedback(apiBaseUrl,'overview-url')},copiedId==='overview-url'?'✓ 已复制':'复制地址')),
                h('p',{className:'c2a-help'},'API Key 请在「API 接入」中创建和管理。'),
                h('div',{className:'c2a-connect-actions'},h(Btn,{onClick:()=>changeTab('api')},'管理 API Key'),h(Btn,{onClick:()=>changeTab('api')},'接入说明'))
              ),
              h(Card,{title:'待处理事项',cls:'c2a-attention-card'},
                h('div',{className:'c2a-attention-list'},
                  health.error?h('div',{className:'c2a-attention-item warning',role:'alert'},h('strong',null,'服务连接异常'),h('p',null,health.error),h(Btn,{onClick:()=>changeTab('settings')},'查看运行设置')):null,
                  firstUse?h('div',{className:'c2a-attention-item'},h('strong',null,'尚未导入账号'),h('p',null,'添加账号后可查询额度并使用接口。'),h(Btn,{onClick:()=>{changeTab('accounts');openAccountDialog('import')}},'添加账号')):null,
                  online&&hasAccounts&&!ready?h('div',{className:'c2a-attention-item warning'},h('strong',null,'暂无可用账号'),h('p',null,'后端已连接，请检查账号状态及可用额度。'),h(Btn,{onClick:()=>changeTab('accounts')},'检查账号池')):null,
                  online&&attentionCount>0?h('div',{className:'c2a-attention-item warning'},h('strong',null,number(attentionCount)+' 个账号需要关注'),h('p',null,`限流 ${number(acc.limited??0)} · 异常 ${number(acc.abnormal??0)} · 已禁用 ${number(acc.disabled??0)}`),h(Btn,{onClick:()=>changeTab('accounts')},'查看账号')):null,
                  online&&hasAccounts&&Number(acc.total_quota)===0?h('div',{className:'c2a-attention-item warning'},h('strong',null,'额度需要确认'),h('p',null,'查询结果为 0，请核对查询是否成功、代理连接和账号权限。'),h(Btn,{onClick:()=>{changeTab('accounts');openAccountDialog('proxy')}},'检查代理与额度')):null,
                  recentIssues.length?h('div',{className:'c2a-attention-item warning'},h('strong',null,'最近任务有待核对结果'),h('p',null,`最近 5 条记录中有 ${recentIssues.length} 条失败、部分成功或结果未知的任务。`),h(Btn,{onClick:()=>viewTask(recentIssues[0].id)},'查看任务详情')):null,
                  online&&ready&&!attentionCount&&Number(acc.total_quota)>0&&!recentIssues.length?h('div',{className:'c2a-all-clear'},h('strong',null,'账号池暂无异常'),h('p',null,'任务与额度以最近查询结果为准。')):null,
                  !online&&!health.error?h('div',{className:'c2a-all-clear',role:'status'},h('strong',null,'正在检查服务状态'),h('p',null,'连接后会显示账号池需要处理的事项。')):null
                )
              )
            )
          ),
          h('div',{className:'c2a-overview-foot'},h('span',null,online?`后端累计调用：成功 ${number(acc.total_success)} · 失败 ${number(acc.total_fail)}`:'后端调用统计暂不可用'),h('small',null,'服务状态每 15 秒检查 · 任务每 5 秒更新'))
        ):
        tab==='accounts'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},
            h('div',null,h('h2',null,'账号池管理'),h('p',null,'本机管理已启用 · 无需管理员密码 · 仅导入你有权使用的账号。')),
            h('div',{className:'c2a-account-tools'},
              h(Btn,{primary:true,onClick:()=>openAccountDialog('import')},'＋ 导入账号'),
              h(Btn,{onClick:()=>openAccountDialog('pending')},`待授权记录（${credentialItems.length}）`),
              h(Btn,{onClick:()=>openAccountDialog('proxy')},'⚙ 代理与额度'),
              h(Btn,{onClick:()=>{void listAccounts();void listCredentials()},disabled:pool.loading||doing},pool.loading?'加载中…':'刷新账号列表')
            )
          ),
          pool.loaded&&pool.items.length>0&&pool.items.every(a=>Number(a?.quota??a?.image_quota??0)===0)?
            h('div',{className:'c2a-quota-notice'},h('span',null,'当前所有账号的额度均显示为 0，请检查网络、代理及账号权限。'),h(Btn,{onClick:()=>openAccountDialog('proxy')},'检查代理与额度')):null,
          pool.error?h('div',{className:'c2a-alert',role:'alert'},pool.error):null,
          pool.message?h('div',{className:'c2a-info',role:'status'},pool.message):null,
          credentialBusy&&accountDialog!=='import'&&accountDialog!=='pending'?
            h('div',{className:'c2a-task-notice',role:'status'},h('span',null,'账号授权正在后台执行…'),h(Btn,{onClick:()=>openAccountDialog('pending')},'查看进度')):null,
            h(Card,{title:`可用 Token 号池（${pool.items.length}）`,actions:h('div',{className:'c2a-card-actions'},
              h(Btn,{onClick:deleteSelectedAccounts,danger:true,disabled:doing||pool.loading||!selectedAccountRefs.length},`批量删除（${selectedAccountRefs.length}）`),
              h(Btn,{onClick:refreshAllAccounts,disabled:doing||!pool.items.length},doing?'正在刷新…':'刷新全部额度'))},
              selectedAccountRefs.length?h('div',{className:'c2a-selection-bar'},h('span',{role:'status'},`已选 ${selectedAccountRefs.length} 个账号（跨页保留）`),h(Btn,{onClick:()=>setAccountSelection([]),disabled:doing||pool.loading},'清空选择')):null,
              pool.items.length?h('div',{className:'c2a-tablewrap c2a-account-tablewrap'},h('table',{className:'c2a-table'},h('thead',null,h('tr',null,
                h('th',{className:'c2a-checkcell'},h('input',{type:'checkbox',checked:allPageAccountsSelected,ref:node=>{if(node)node.indeterminate=!allPageAccountsSelected&&somePageAccountsSelected},'aria-checked':!allPageAccountsSelected&&somePageAccountsSelected?'mixed':allPageAccountsSelected,'aria-label':'选择本页全部账号',title:'仅选择或取消选择当前页',disabled:doing||pool.loading||!visibleAccountRefs.length,onChange:e=>selectAccountPage(e.target.checked)})),
                ...['账号','类型','状态','剩余额度','操作'].map(t=>h('th',{key:t},t)))),h('tbody',null,...visibleAccounts.map((a,i)=>h('tr',{key:accountToken(a)||i,className:selectedAccountSet.has(accountToken(a))?'c2a-row-selected':''},
                h('td',{className:'c2a-checkcell'},h('input',{type:'checkbox',checked:selectedAccountSet.has(accountToken(a)),'aria-label':`选择账号 ${a?.email||a?.name||('账号 '+(accountPageStart+i+1))}`,disabled:doing||pool.loading||!accountToken(a),onChange:e=>selectAccount(accountToken(a),e.target.checked)})),
                h('td',null,h('strong',null,String(a?.email||a?.name||('账号 '+(accountPageStart+i+1)))),h('small',null,maskToken(accountToken(a)))),
                h('td',null,String(a?.type||a?.plan||'—')),
                h('td',null,h(Chip,{kind:['normal','active','ok'].includes(String(a?.status||'').toLowerCase())?'success':'neutral'},String(a?.status||'—'))),
                h('td',null,number(a?.quota??a?.image_quota),Number(a?.quota??a?.image_quota??0)===0?h('small',null,a?.quota_check_failed?'最近查询失败':'请核对网络/额度'):null),
                h('td',null,h('div',{className:'c2a-rowactions'},h(Btn,{onClick:()=>refreshAccount(a),disabled:doing||pool.loading},'检测'),h(Btn,{onClick:()=>deleteAccount(a),danger:true,disabled:doing||pool.loading},'删除')))
              ))))):h('div',{className:'c2a-emptymini'},'暂无账号，或尚未刷新列表。'),
              h('div',{className:'c2a-pagination'},
                h('span',null,`共 ${pool.items.length} 个账号 · ${pool.items.length?accountPageStart+1:0}–${Math.min(accountPageStart+accountPageSize,pool.items.length)} 条`),
                h('div',{className:'c2a-pagination-controls'},
                  h('label',null,'每页 ',h('select',{value:accountPageSize,'aria-label':'每页账号数',disabled:doing||pool.loading,onChange:e=>{setAccountPageSize(Number(e.target.value));changeAccountPage(1)}},...[10,20,50,100].map(size=>h('option',{key:size,value:size},`${size} 条`)))),
                  h(Btn,{onClick:()=>changeAccountPage(currentAccountPage-1),disabled:doing||pool.loading||currentAccountPage<=1},'上一页'),
                  h('nav',{'aria-label':'号池分页'},...accountPageNumbers.map((page,i)=>h(React.Fragment,{key:page},
                    i>0&&page-accountPageNumbers[i-1]>1?h('span',{className:'c2a-page-ellipsis','aria-hidden':true},'…'):null,
                    h('button',{type:'button',className:'c2a-button'+(page===currentAccountPage?' primary':''),'aria-label':`第 ${page} 页`,'aria-current':page===currentAccountPage?'page':undefined,disabled:doing||pool.loading,onClick:()=>changeAccountPage(page)},String(page))
                  ))),
                  h(Btn,{onClick:()=>changeAccountPage(currentAccountPage+1),disabled:doing||pool.loading||currentAccountPage>=accountPageCount},'下一页')
                )
              )
            ),
          accountDialog==='import'?h(Modal,{title:'导入账号',id:'c2a-import-dialog-title',onClose:closeAccountDialog,wide:true},
            h('div',{className:'c2a-dialog-tabs',role:'tablist','aria-label':'账号导入方式'},
              ...[['token','Access Token'],['email','邮箱 / TXT 批量导入']].map(([id,label])=>h('button',{key:id,id:'c2a-import-tab-'+id,type:'button',role:'tab','aria-selected':importMode===id,'aria-controls':importMode===id?'c2a-import-panel-'+id:undefined,tabIndex:importMode===id?0:-1,
                onClick:()=>setImportMode(id),
                onKeyDown:event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'token':event.key==='End'?'email':importMode==='token'?'email':'token';setImportMode(next);event.currentTarget.parentElement.querySelector('#c2a-import-tab-'+next)?.focus()}},
                className:importMode===id?'selected':''},label))
            ),
            importMode==='token'?h('div',{role:'tabpanel',id:'c2a-import-panel-token','aria-labelledby':'c2a-import-tab-token'},
              h('h3',null,'导入一个账号'),
              h('div',{className:'c2a-formrow'},h('input',{type:'password',value:newToken,placeholder:'粘贴你有权使用的 access_token','aria-label':'账号 access_token','data-dialog-focus':true,autoComplete:'off',onChange:e=>setNewToken(e.target.value)}),h(Btn,{primary:true,onClick:addAccount,disabled:doing},doing?'处理中…':'导入并检测')),
              h('p',{className:'c2a-help'},'单账号导入后由上游服务完成有效性检查；CPA、sub2api 等复杂导入请使用「高级导入」页面。'),
              pool.error?h('div',{className:'c2a-alert',role:'alert'},pool.error):null,
              pool.message?h('div',{className:'c2a-info',role:'status'},pool.message):null
            ):h('div',{role:'tabpanel',id:'c2a-import-panel-email','aria-labelledby':'c2a-import-tab-email'},
              h('h3',null,'邮箱 / 密码 / 第三字段批量导入（每行一条）'),
              h('div',{className:'c2a-format-guide',style:{background:'var(--surface-muted)',border:'1px solid var(--line)',borderRadius:'10px',padding:'13px 16px',margin:'10px 0 14px',fontSize:'12px',lineHeight:'1.6'}},
                h('div',{style:{fontWeight:'700',color:'var(--text-strong)',marginBottom:'6px'}},
                  '📋 支持导入的账号格式规范（每行一条，分隔符支持 ---- 或 ---）：'
                ),
                h('div',{style:{display:'grid',gap:'8px',color:'var(--text-secondary)'}},
                  h('div',null,
                    h('span',{style:{background:'var(--accent-soft)',color:'var(--accent-ink)',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'格式 1 标准三字段'),
                    h('code',{style:{background:'var(--input-bg)',padding:'2px 5px',borderRadius:'4px',fontFamily:'monospace'}},'邮箱----密码----2FA密钥'),
                    h('span',{style:{color:'var(--muted)',marginLeft:'8px'}},'（自动通过 OAuth + TOTP 登录换取 Token 加入号池）')
                  ),
                  h('div',null,
                    h('span',{style:{background:'var(--accent-soft)',color:'var(--accent-ink)',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'格式 2 卡密带邮箱链接'),
                    h('code',{style:{background:'var(--input-bg)',padding:'2px 5px',borderRadius:'4px',fontFamily:'monospace'}},'邮箱----密码----2FA密钥----https://mail.xxx.store/...'),
                    h('span',{style:{color:'var(--muted)',marginLeft:'8px'}},'（第四字段为网页邮箱/接码链接，系统自动识别并使用前三项自动登录）')
                  ),
                  h('div',null,
                    h('span',{style:{background:'var(--accent-soft)',color:'var(--accent-ink)',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'格式 3 带已生成 Token'),
                    h('code',{style:{background:'var(--input-bg)',padding:'2px 5px',borderRadius:'4px',fontFamily:'monospace'}},'邮箱----密码----2FA密钥----eyJhbGci...'),
                    h('span',{style:{color:'var(--muted)',marginLeft:'8px'}},'（第四字段为有效 access_token 时优先直接复用入池，过期会自动重新登录）')
                  ),
                  h('div',null,
                    h('span',{style:{background:'var(--surface-muted)',color:'var(--text-secondary)',padding:'2px 6px',borderRadius:'4px',fontWeight:'600',marginRight:'8px'}},'文本文件导入'),
                    '点击下方「选择账号文本文件（.txt）」可直接选择包含上述格式的本地 txt 文件，自动加载入框。'
                  )
                )
              ),
              h('div',{style:{margin:'10px 0 8px'}},
                h('label',{style:{display:'block',fontWeight:'600',fontSize:'12px',color:'var(--text-secondary)',marginBottom:'5px'}},'📁 选择账号文本文件（.txt）：'),
                h('input',{type:'file',accept:'.txt,text/plain', 'aria-label':'导入账号文本文件',onChange:e=>{void loadCredentialFile(e.target.files?.[0]);e.target.value=''}})
              ),
              h('textarea',{className:'c2a-textarea',value:credentialText,onChange:e=>{setCredentialText(e.target.value);setCredentialFeedback(null)},placeholder:'first@example.com----your-password----2fa-secret\nsecond@example.com----your-password----2fa-secret',rows:5,spellCheck:false,autoComplete:'off','aria-label':'一行一条账号凭据文本','data-dialog-focus':true}),
              h('div',{className:'c2a-formrow'},
                h(Btn,{primary:true,onClick:importAndAuthenticate,disabled:credentialBusy||!credentialText.trim()},credentialBusy?'正在登录并换取 Token…':'导入并授权入池'),
                h(Btn,{onClick:importCredentialLines,disabled:credentialBusy||!credentialText.trim()},'仅加密暂存'),
                h(Btn,{onClick:()=>{setCredentialText('');setCredentialFeedback(null);setCredentialError('')}},'清空输入'),
                h(Btn,{onClick:()=>{void listCredentials();void listAccounts()},disabled:credentialBusy},'刷新列表')
              )
            ),
              credentialError?h('div',{className:'c2a-alert'},credentialError):null,
              credentialFeedback?h('div',{className:'c2a-info'},
                credentialFeedback.succeeded!==undefined?
                  (
                    credentialFeedback.total > 0 && credentialFeedback.succeeded === 0 && credentialFeedback.failed === 0 && ((credentialFeedback.poolSkipped||0) + (credentialFeedback.enrolled?.skipped||0) + (credentialFeedback.duplicates||0)) ?
                      `全部账号（共 ${credentialFeedback.total} 个）均已在号池中（状态正常）或已重复，已自动跳过，无需重复导入。`:
                      `完成：成功授权并入池 ${credentialFeedback.succeeded||0} 个账号（新增 ${credentialFeedback.enrolled?.added||0}，刷新 ${credentialFeedback.enrolled?.refreshed||0}${((credentialFeedback.poolSkipped||0)+(credentialFeedback.enrolled?.skipped||0)+(credentialFeedback.duplicates||0)) ? `，重复跳过 ${(credentialFeedback.poolSkipped||0)+(credentialFeedback.enrolled?.skipped||0)+(credentialFeedback.duplicates||0)}` : ''}）；失败 ${credentialFeedback.failed||0} 个。`
                  ):
                  `加密暂存 ${credentialFeedback.added||0} 条；重复跳过 ${credentialFeedback.skipped||0} 条；格式错误 ${credentialFeedback.invalid||0} 行。`,
                Array.isArray(credentialFeedback.errors)&&credentialFeedback.errors.length?h('ul',null,...credentialFeedback.errors.map((x,i)=>h('li',{key:i},`第 ${x.line} 行：${x.reason}`))):null,
                Array.isArray(credentialFeedback.failures)&&credentialFeedback.failures.length?h('ul',null,...credentialFeedback.failures.map((x,i)=>h('li',{key:i},`${x.email}：${x.error}`))):null
              ):null
          ):null,
          accountDialog==='pending'?h(Modal,{title:`待授权记录（${credentialItems.length}）`,id:'c2a-pending-dialog-title',onClose:closeAccountDialog,wide:true},
            h('p',{className:'c2a-help'},'此处显示本机加密暂存、尚未成功授权入池的账号，密码和 2FA 密钥不会回显。'),
            credentialBusy?h('p',{className:'c2a-task-notice',role:'status'},'正在登录并换取 Token，请稍候。关闭弹窗不影响任务执行。'):null,
              h('div',{className:'c2a-sectiontitle',style:{marginTop:'1rem'}},
                h('h4',null,`本地待授权记录（${credentialItems.length}）`),
                credentialItems.length?h(Btn,{disabled:credentialBusy,onClick:authenticateAllCredentials},credentialBusy?'处理中…':'全部授权入池'):null
              ),
              credentialItems.length?h('div',{className:'c2a-tablewrap'},h('table',{className:'c2a-table'},
                h('thead',null,h('tr',null,...['邮箱','状态','操作'].map(x=>h('th',{key:x},x)))),
                h('tbody',null,...credentialItems.slice(0,300).map(x=>h('tr',{key:x.id},
                  h('td',null,h('strong',null,String(x.email||'—')),x.lastError?h('small',{style:{display:'block',color:'var(--c2a-danger)'}},x.lastError):null),
                  h('td',null,h(Chip,{kind:x.state==='auth_failed'?'danger':'warning'},x.state==='auth_failed'?'授权失败':'待授权')),
                  h('td',null,h('div',{className:'c2a-rowactions'},
                    h(Btn,{disabled:credentialBusy,onClick:()=>authenticateCredential(x)},'授权入池'),
                    h(Btn,{danger:true,disabled:credentialBusy,onClick:()=>deleteCredential(x)},'删除')
                  ))
                ))))):h('p',{className:'c2a-help'},'没有待授权记录。成功授权的账号已进入「可用 Token 号池」。密码及第三字段不会在页面中回显。'),
              credentialError?h('div',{className:'c2a-alert'},credentialError):null,
              credentialFeedback?h('div',{className:'c2a-info'},
                credentialFeedback.succeeded!==undefined?
                  (
                    credentialFeedback.total > 0 && credentialFeedback.succeeded === 0 && credentialFeedback.failed === 0 && ((credentialFeedback.poolSkipped||0) + (credentialFeedback.enrolled?.skipped||0) + (credentialFeedback.duplicates||0)) ?
                      `全部账号（共 ${credentialFeedback.total} 个）均已在号池中（状态正常）或已重复，已自动跳过，无需重复导入。`:
                      `完成：成功授权并入池 ${credentialFeedback.succeeded||0} 个账号（新增 ${credentialFeedback.enrolled?.added||0}，刷新 ${credentialFeedback.enrolled?.refreshed||0}${((credentialFeedback.poolSkipped||0)+(credentialFeedback.enrolled?.skipped||0)+(credentialFeedback.duplicates||0)) ? `，重复跳过 ${(credentialFeedback.poolSkipped||0)+(credentialFeedback.enrolled?.skipped||0)+(credentialFeedback.duplicates||0)}` : ''}）；失败 ${credentialFeedback.failed||0} 个。`
                  ):
                  `加密暂存 ${credentialFeedback.added||0} 条；重复跳过 ${credentialFeedback.skipped||0} 条；格式错误 ${credentialFeedback.invalid||0} 行。`,
                Array.isArray(credentialFeedback.errors)&&credentialFeedback.errors.length?h('ul',null,...credentialFeedback.errors.map((x,i)=>h('li',{key:i},`第 ${x.line} 行：${x.reason}`))):null,
                Array.isArray(credentialFeedback.failures)&&credentialFeedback.failures.length?h('ul',null,...credentialFeedback.failures.map((x,i)=>h('li',{key:i},`${x.email}：${x.error}`))):null
              ):null
          ):null,
          accountDialog==='proxy'?h(Modal,{title:'代理与额度',id:'c2a-proxy-dialog-title',onClose:closeAccountDialog},
            h('p',{className:'c2a-help'},'如果导入成功却显示额度 0，优先确认 chatgpt.com 能通过代理访问；仅登录成功不等于额度查询成功。请填写你本机实际使用的代理地址，常见端口有 7890、7897、10809（不是统一固定值）。'),
            h('div',{className:'c2a-formrow'},
              h('input',{value:proxyState.draft,placeholder:'例如 http://127.0.0.1:7897','aria-label':'号池全局代理地址','data-dialog-focus':true,autoComplete:'off',onChange:e=>setProxyState(x=>({...x,draft:e.target.value,test:null}))}),
              h(Btn,{onClick:testProxy,disabled:proxyState.busy},proxyState.busy?'处理中…':'测试代理连通性'),
              h(Btn,{onClick:saveProxy,disabled:proxyState.busy,primary:true},'保存全局代理'),
              h(Btn,{onClick:loadProxy,disabled:proxyState.busy},'读取配置')
            ),
            h('p',{className:'c2a-help'},proxyState.hasCredentials?'当前代理含认证信息，界面不会显示；如需修改，请输入新的无账号密码代理地址。':proxyState.configured?'当前已配置全局代理。可先测试，再刷新额度。':'当前未配置全局代理；不需要代理的网络可保持为空。'),
            proxyState.test?h('p',{className:proxyState.test.ok?'c2a-info':'c2a-alert'},proxyState.test.ok?`代理测试通过：HTTP ${proxyState.test.status}，${proxyState.test.latency_ms} ms（仅代表网络连通，不保证额度）`:`代理测试未通过：${proxyState.test.error||'连接失败'}`):null,
            proxyState.error?h('p',{className:'c2a-alert'},proxyState.error):null,
            proxyState.message?h('p',{className:'c2a-info'},proxyState.message):null,
            h('div',{className:'c2a-formrow'},
              h(Btn,{onClick:refreshAllAccounts,disabled:doing||!pool.items.length},doing?'正在刷新…':'全部刷新额度'),
              h(Btn,{onClick:()=>copyWithFeedback(ZERO_QUOTA_PROMPT,'zero-quota'),disabled:doing},copiedId==='zero-quota'?'✓ 已复制':'复制排查说明')
            ),
            h('p',{className:'c2a-help'},'不会伪造或手工修改额度；刷新后仍为 0 时，请排查代理规则、账号权限及上游服务。代理软件必须持续运行。')
          ):null,
        ):
        tab==='api'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'通用 API 接入'),h('p',null,text('任何受支持的 DSH Host 插件和本机 OpenAI 兼容客户端都可以连接本服务；无需安装其他桥接工具。','本机 OpenAI 兼容客户端可以通过独立 API Key 连接本服务。')))),
          h(Card,{title:'第三方软件连接参数'},
            h('p',{className:'c2a-help'},'推荐只连接本机软件。远程机器需要自行配置认证、HTTPS 反向代理和访问限制。'),
            h('label',{className:'c2a-fieldlabel'},'OpenAI 兼容 API Base URL'),
            h('div',{style:{display:'flex',gap:'8px',alignItems:'center'}},
              h('pre',{className:'c2a-code',style:{flex:1,margin:0}},endpoint?endpoint+'/v1':'http://127.0.0.1:38650/v1'),
              h(Btn,{
                cls:copiedId==='base-url'?'copied':'',
                onClick:()=>copyWithFeedback(endpoint?endpoint+'/v1':'http://127.0.0.1:38650/v1','base-url')
              },copiedId==='base-url'?'✓ 已复制':'复制 URL')
            ),
            h('label',{className:'c2a-fieldlabel'},'认证方式'),
            h('pre',{className:'c2a-code'},'Authorization: Bearer <你创建的用户 API Key>'),
            h('label',{className:'c2a-fieldlabel'},'可用接口'),
            h('pre',{className:'c2a-code'},'GET /v1/models\nPOST /v1/chat/completions\nPOST /v1/responses\nPOST /v1/images/generations\nPOST /v1/images/edits'),
            h('p',{className:'c2a-help'},'可在 Cherry Studio 等软件中将接口地址设为上述 Base URL，填入下方创建的用户密钥；具体兼容性依模型与客户端而定。')
          ),
          h(Card,{title:'创建第三方调用 API Key'},
            h('div',{className:'c2a-formrow'},
              h('input',{value:userKeyName,'aria-label':'新 API Key 名称',onChange:e=>setUserKeyName(e.target.value),placeholder:'名称，例如：Cherry Studio'}),
              h('input',{value:userKeyCustom,'aria-label':'自定义密钥（可选）',onChange:e=>setUserKeyCustom(e.target.value),placeholder:'自定义密钥（可选，留空自动生成）'}),
              h(Btn,{primary:true,onClick:createUserKey,disabled:userKeyBusy},userKeyBusy?'处理中…':'生成用户密钥'),
              h(Btn,{onClick:loadUserKeys,disabled:userKeyBusy},'刷新密钥列表')
            ),
            userKeyError?h('div',{className:'c2a-alert'},userKeyError):null,
            userKeyPlain?h('div',{className:'c2a-newkey-card'},
              h('div',{className:'c2a-newkey-title'},
                h('span',{style:{fontSize:'16px'}},'🔑'),
                h('span',null,'新 API Key 生成成功！')
              ),
              h('p',{style:{margin:'0 0 6px 0',fontSize:'12px',color:'var(--text-secondary)'}},'已自动同步保存在本机密钥库，并在下方表格常驻展示。您可点击直接复制或全选文本：'),
              h('input',{
                type:'text',
                readOnly:true,
                value:userKeyPlain,
                className:'c2a-newkey-input',
                onClick:e=>e.target.select(),
                title:'点击可全选密钥'
              }),
              h('div',{className:'c2a-newkey-actions'},
                h(Btn,{
                  primary:copiedId!=='new-key',
                  cls:copiedId==='new-key'?'copied':'',
                  onClick:()=>copyWithFeedback(userKeyPlain,'new-key')
                },copiedId==='new-key'?'✓ 已复制到剪贴板':'复制完整密钥'),
                h(Btn,{
                  cls:copiedId==='new-key-bearer'?'copied':'',
                  onClick:()=>copyWithFeedback(`Bearer ${userKeyPlain}`,'new-key-bearer')
                },copiedId==='new-key-bearer'?'✓ 已复制 Bearer':'复制 Bearer 标头'),
                h(Btn,{onClick:()=>setUserKeyPlain('')},'关闭提示')
              )
            ):null,
            userKeys.length?h('div',{className:'c2a-tablewrap'},h('table',{className:'c2a-table'},
              h('thead',null,h('tr',null,...['名称','API Key (密钥)','创建时间','状态','操作'].map(x=>h('th',{key:x},x)))),
              h('tbody',null,...userKeys.map((x,i)=>{
                const id=String(x?.id||i);
                const keyStr=String(x?.key||'');
                const hasKey=Boolean(keyStr);
                const isRevealed=Boolean(revealedKeys[id]);
                const display=hasKey?(isRevealed?keyStr:(keyStr.length>12?keyStr.slice(0,6)+'••••••••'+keyStr.slice(-4):'••••••••')):'sk-•••••••• (历史哈希)';
                const isCopied=copiedId===id;
                return h('tr',{key:id},
                  h('td',null,
                    h('strong',null,String(x?.name||'用户密钥')),
                    x?.id?h('small',null,'ID: '+x.id):null
                  ),
                  h('td',null,
                    hasKey?h('div',{className:'c2a-key-cell'},
                      h('code',{className:'c2a-key-code',title:isRevealed?'点击隐藏':'点击显示完整明文'},display),
                      h(Btn,{
                        style:{padding:'3px 8px',fontSize:'11px'},
                        onClick:()=>toggleReveal(id)
                      },isRevealed?'隐藏':'显示'),
                      h(Btn,{
                        cls:isCopied?'copied':'',
                        style:{padding:'3px 8px',fontSize:'11px'},
                        onClick:()=>copyWithFeedback(keyStr,id)
                      },isCopied?'✓ 已复制':'复制'),
                      h(Btn,{
                        style:{padding:'3px 8px',fontSize:'11px'},
                        disabled:userKeyBusy,
                        onClick:()=>resetUserKey(id),
                        title:'重新生成随机密钥'
                      },'重置')
                    ):h('div',{className:'c2a-key-cell',style:{gap:'6px'}},
                      h('code',{className:'c2a-key-code',style:{color:'var(--warning)',background:'var(--warning-bg)'},title:'历史旧版本仅存储了不可逆哈希。点击右侧按钮立即生成新明文并复制！'},display),
                      h(Btn,{
                        primary:true,
                        cls:isCopied?'copied':'',
                        style:{padding:'3px 10px',fontSize:'11px',fontWeight:'600'},
                        disabled:userKeyBusy,
                        onClick:()=>resetUserKey(id),
                        title:'立即为此历史条目重新生成新密钥并直接复制'
                      },isCopied?'✓ 已复制新密钥':'🎲 重新生成并复制'),
                      h(Btn,{
                        style:{padding:'3px 8px',fontSize:'11px'},
                        disabled:userKeyBusy,
                        onClick:()=>promptCustomKey(x),
                        title:'手动设置自定义密钥或填回已知密钥'
                      },'✏️ 设置密钥')
                    )
                  ),
                  h('td',null,h('span',{style:{fontSize:'11px',color:'var(--muted)'}},formatKeyDate(x?.created_at))),
                  h('td',null,h(Chip,{kind:x?.enabled===false?'warning':'success'},x?.enabled===false?'已禁用':'可用')),
                  h('td',null,
                    h('div',{className:'c2a-rowactions'},
                      h(Btn,{danger:true,disabled:userKeyBusy,onClick:()=>revokeUserKey(x?.id)},'吊销')
                    )
                  )
                );
              }))
            )):h('p',{className:'c2a-help'},'尚未创建第三方 API Key。管理页面本身不需要密钥。')
          ),
          standalone?h(Card,{title:'独立接口服务'},h('p',{className:'c2a-help'},'在第三方客户端填入上方 Base URL 和用户 API Key。管理页面的登录口令仅用于本机会话，不能作为 API Key 使用。')):
          h(Card,{title:'DSH 插件内部服务'},h('pre',{className:'c2a-code'},'ctx.chatgpt2api.models()\nctx.chatgpt2api.chatCompletion({...})\nctx.chatgpt2api.createResponse({...})\nctx.chatgpt2api.generateImage({...})'),
            h('p',{className:'c2a-help'},'供其他 DSH Host 插件通过依赖注入调用；第三方客户端使用独立 API Key。'))
        ):
        tab==='image'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'图片生成'),h('p',null,text('调用当前插件托管的生图服务，一次生成一张图。','调用本机号池的生图服务，一次生成一张图。')))),
          h('div',{className:'c2a-columns'},
            h(Card,{title:'创建生图任务'},
              h('label',{className:'c2a-fieldlabel'},'提示词'),
              h('textarea',{className:'c2a-textarea',value:prompt,onChange:e=>setPrompt(e.target.value),rows:5,'aria-label':'提示词'}),
              h('p',{className:'c2a-help'},'提示：真实人物写真、性感或身体特写类描述容易被上游安全策略拒绝并返回 400；插画、水彩、景物或虚构角色更稳定。'),
              h('label',{className:'c2a-fieldlabel'},'生成模型'),
              h('div',{className:'c2a-formrow'},
                h('select',{className:'c2a-input',value:imageModel,'aria-label':'生成模型',onChange:e=>setImageModel(e.target.value)},
                  ...[...new Set([imageModel,...imageModels.items,...(animatedGif?['gpt-image-2.6','gpt-image-2.6-flare','gpt-image-2.6-sunburst']:[])])].filter(Boolean).map(x=>h('option',{key:x,value:x},x))),
                h(Btn,{onClick:loadImageModels,disabled:imageModels.loading},imageModels.loading?'刷新中…':'刷新模型')
              ),
              imageModels.error?h('p',{className:'c2a-help'},'模型列表：'+imageModels.error):null,
              h('label',{className:'c2a-fieldlabel'},'分辨率档位'),
              h('div',{className:'c2a-formrow'},
                h('select',{className:'c2a-input',value:imageTier,'aria-label':'分辨率档位',onChange:e=>setImageTier(e.target.value)},
                  ...[['auto','自动'],['1k','1K'],['2k','2K'],['4k','4K']].map(([value,label])=>h('option',{key:value,value},label))),
                h(Btn,{onClick:saveImagePreferences,disabled:imagePrefs.saving},imagePrefs.saving?'保存中…':'保存为默认')
              ),
              h('p',{className:'c2a-help'},'不保存图片比例。提示词中明确写出 16:9、9:16、1:1 等比例后，会结合当前档位生成目标尺寸；未指定比例时使用后端自动尺寸。上游模型可能不支持某些高分辨率组合。'),
              imagePrefs.error?h('p',{className:'c2a-alert'},imagePrefs.error):null,
              imagePrefs.message?h('p',{className:'c2a-info'},imagePrefs.message):null,
              h('label',{className:'c2a-fieldlabel'},'动图 GIF'),
              h('div',{className:'c2a-formrow'},
                h('label',null,h('input',{type:'checkbox',checked:animatedGif,'aria-label':'动图 GIF',onChange:e=>{const checked=e.target.checked;setAnimatedGif(checked);if(checked&&!['gpt-image-2.6','gpt-image-2.6-flare','gpt-image-2.6-sunburst'].includes(imageModel))setImageModel('gpt-image-2.6')}}),'生成 GIF 动画（号池）')
              ),
              animatedGif?h(React.Fragment,null,
                h('p',{className:'c2a-help'},gifCapability.enabled?'GIF 由现有 ChatGPT 号池账号通过生图会话生成；是否成功取决于上游账号、模型是否开放 GIF 能力。':text('号池 GIF 通道尚未就绪，请重启 DSH 并确认本地后端运行正常；不需要官方 API Key。','号池 GIF 通道尚未就绪，请重启程序并确认本地后端运行正常；不需要官方 API Key。')),
                h('div',{className:'c2a-formrow'},
                  h('label',{className:'c2a-fieldlabel'},'帧数（2–16）'),
                  h('input',{type:'number',min:2,max:16,step:1,value:gifFrameCount,'aria-label':'GIF 帧数',onChange:e=>setGifFrameCount(e.target.value)}),
                  h('label',{className:'c2a-fieldlabel'},'每帧时长（毫秒）'),
                  h('input',{type:'number',min:20,max:2000,step:10,value:gifFrameDuration,'aria-label':'GIF 每帧时长',onChange:e=>setGifFrameDuration(e.target.value)})
                )
              ):null,
              h('label',{className:'c2a-fieldlabel'},'参考图片（最多 4 张，可不选）'),
              h('input',{type:'file',accept:'image/png,image/jpeg,image/webp',multiple:true,'aria-label':'参考图片',onChange:e=>{setImageFiles(Array.from(e.target.files||[]).slice(0,5));setMissingReferenceFiles(false)}}),
              missingReferenceFiles?h('p',{className:'c2a-alert'},'原任务的参考图片未完整保存，请重新选择参考图片。'):null,
              h('p',{className:'c2a-help'},imageFiles.length?'已选择 '+imageFiles.length+' 张参考图；每张最大 12MB。':'不选择图片则走文生图；选择参考图则走图片编辑接口。'),
              h('div',{className:'c2a-formrow'},
                h(Btn,{primary:true,onClick:generate,disabled:imageResult.loading},imageResult.loading?(imageResult.status==='queued'?'任务排队中…':'正在生成…'):(animatedGif?'生成 GIF 动画':'生成一张图片')),
                h(Btn,{onClick:openImagesFolder,disabled:folderBusy,title:'在本机文件管理器中打开后端按日期保存历史图片的目录'},folderBusy?'正在打开…':'打开历史图片文件夹')
              ),
              folderNote?h('p',{className:'c2a-help'},folderNote):null,
              folderInfo.dir?h('div',{className:'c2a-formrow',style:{alignItems:'stretch'}},
                h('code',{className:'c2a-code',style:{flex:1,minWidth:0,margin:0,padding:'10px 12px',fontSize:'11px',whiteSpace:'pre-wrap',wordBreak:'break-all'}},folderInfo.dir),
                h(Btn,{cls:copiedId==='folder-path'?'copied':'',onClick:()=>copyWithFeedback(folderInfo.dir,'folder-path'),title:'复制完整文件夹地址'},copiedId==='folder-path'?'✓ 已复制':'复制地址')
              ):null,
              h('p',{className:'c2a-help'},'成功后图片会自动按 年/月/日 保存在本机后端数据目录；如果系统没有弹出文件管理器，直接复制上面的地址粘贴到资源管理器/访达即可。')
            ),
            h(Card,{title:'生成结果'},
              imageResult.taskId?h('div',{className:'c2a-task-result-note'},h(Chip,{kind:taskKind({status:imageResult.status})},TASK_STATUSES[imageResult.status]||'已提交'),h(Btn,{onClick:()=>viewTask(imageResult.taskId)},'查看任务'),h('span',null,'可关闭网页，稍后在历史任务中查看。')):null,
              imageResult.error?h('div',{className:'c2a-alert'},imageResult.error):null,
              imageResult.url?h('div',{className:'c2a-result'},h('img',{src:imageResult.url,alt:'生成结果'}),h('a',{className:'c2a-download',href:imageResult.url,download:'chatgpt2api-image.'+(['png','jpg','webp','gif'].includes(imageResult.format)?imageResult.format:'png')},'下载图片')):h('div',{className:'c2a-result-empty'},imageResult.loading?'正在等待后端生成结果…':'生成完成后图片显示在这里')
            )
          )
        ):
        tab==='history'?h('div',{className:'c2a-workspace c2a-task-history'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'历史任务'),h('p',null,'查看生成、账号授权、额度刷新任务和第三方 API 请求记录。')),h(Btn,{onClick:()=>loadTaskHistory(),disabled:taskHistory.loading},taskHistory.loading?'加载中…':'刷新任务')),
          h(Card,{title:'任务记录'},
            h('div',{className:'c2a-task-filters'},
              h('label',null,'任务类型',h('select',{'aria-label':'任务类型',value:taskFilters.type,onChange:e=>{setTaskFilters(x=>({...x,type:e.target.value}));setTaskHistory(x=>({...x,page:1}))}},h('option',{value:''},'全部类型'),...Object.entries(TASK_TYPES).map(([value,label])=>h('option',{key:value,value},label)))),
              h('label',null,'任务状态',h('select',{'aria-label':'任务状态',value:taskFilters.status,onChange:e=>{setTaskFilters(x=>({...x,status:e.target.value}));setTaskHistory(x=>({...x,page:1}))}},h('option',{value:''},'全部状态'),...Object.entries(TASK_STATUSES).map(([value,label])=>h('option',{key:value,value},label)))),
              h('label',null,'开始日期',h('input',{type:'date','aria-label':'任务开始日期',value:taskFilters.from,onChange:e=>{setTaskFilters(x=>({...x,from:e.target.value}));setTaskHistory(x=>({...x,page:1}))}})),
              h('label',null,'结束日期',h('input',{type:'date','aria-label':'任务结束日期',value:taskFilters.to,onChange:e=>{setTaskFilters(x=>({...x,to:e.target.value}));setTaskHistory(x=>({...x,page:1}))}})),
              h(Btn,{onClick:()=>{setTaskFilters({type:'',status:'',from:'',to:''});setTaskHistory(x=>({...x,page:1}))}},'重置筛选')
            ),
            taskHistory.error?h('div',{className:'c2a-alert',role:'alert'},taskHistory.error):null,
            taskHistory.items.length?h('div',{className:'c2a-tablewrap c2a-task-tablewrap'},h('table',{className:'c2a-table'},
              h('thead',null,h('tr',null,...['任务','状态','创建时间','耗时','结果','操作'].map(label=>h('th',{key:label},label)))),
              h('tbody',null,...taskHistory.items.map(task=>h('tr',{key:task.id},
                h('td',null,h('strong',null,TASK_TYPES[task.type]||task.type),h('span',{className:'c2a-task-summary',title:task.summary},task.summary||task.id)),
                h('td',null,h(Chip,{kind:taskKind(task)},TASK_STATUSES[task.status]||task.status)),
                h('td',null,formatKeyDate(task.createdAt)),h('td',null,taskDuration(task)),h('td',null,taskSummary(task)),
                h('td',null,h('div',{className:'c2a-rowactions'},h(Btn,{onClick:()=>openHistoryDetail(task.id)},'详情'),h(Btn,{onClick:()=>deleteHistoryTask(task),danger:true,disabled:!!historyBusy||!taskFinished(task)},'删除记录')))
              )))
            )):h('div',{className:'c2a-emptymini',role:'status'},taskHistory.loading?'正在读取任务…':'没有符合条件的任务；新提交的任务会记录在这里。'),
            h('div',{className:'c2a-pagination'},h('span',null,`共 ${taskHistory.total} 条任务 · 第 ${taskHistory.page} / ${taskHistory.pageCount} 页`),h('div',{className:'c2a-pagination-controls'},
              h('label',null,'每页 ',h('select',{'aria-label':'每页任务数',value:taskHistory.pageSize,onChange:e=>setTaskHistory(x=>({...x,page:1,pageSize:Number(e.target.value)}))},...[10,20,50].map(size=>h('option',{key:size,value:size},`${size} 条`)))),
              h(Btn,{disabled:taskHistory.loading||taskHistory.page<=1,onClick:()=>setTaskHistory(x=>({...x,page:x.page-1}))},'上一页'),
              h(Btn,{disabled:taskHistory.loading||taskHistory.page>=taskHistory.pageCount,onClick:()=>setTaskHistory(x=>({...x,page:x.page+1}))},'下一页')
            ))
          ),
          historyDialogId?renderHistoryDetail():null
        ):
        tab==='advanced'?h('div',{className:'c2a-workspace'},
          h('div',{className:'c2a-sectiontitle'},h('div',null,h('h2',null,'高级账号导入'),h('p',null,text('使用本插件原生界面管理账号来源；不依赖原项目 Next.js 网页或额外部署。','管理已授权的账号来源，可导入 JSON、CPA 或 sub2api 账号。'))),h(Btn,{onClick:refreshPools,disabled:advancedBusy},advancedBusy?'处理中…':'刷新连接')),
          h('div',{className:'c2a-info',style:{margin:'0 0 12px 0',display:'flex',justifyContent:'space-between',alignItems:'center',gap:'12px',flexWrap:'wrap'}},
            h('div',null,
              h('strong',null,'💡 想导入「邮箱---密码---2FA」文本或选择 .txt 文件？'),
              h('p',{style:{margin:'4px 0 0',color:'var(--info)',fontSize:'12px'}},'当前页面为 CPA / sub2api / JSON 格式的高级导入；常规账号批量导入及 TXT 文件选择请前往「号池管理 / 导入」页面。')
            ),
            h(Btn,{primary:true,onClick:()=>changeTab('accounts')},'前往账号导入（支持 TXT） →')
          ),
          advancedError?h('div',{className:'c2a-alert'},advancedError):null,
          importMessage?h('div',{className:'c2a-info'},importMessage):null,
          h(Card,{title:'导入 CPA / OAuth JSON 文件'},
            h('input',{type:'file',accept:'.json,application/json',onChange:async e=>{const f=e.target.files?.[0];if(f){if(f.size>2000000){setAdvancedError('文件超过 2 MB');return}try{setImportJson(await f.text());setAdvancedError('')}catch(err){setAdvancedError(shortError(err))}}}}),
            h('textarea',{className:'c2a-textarea',value:importJson,onChange:e=>setImportJson(e.target.value),rows:4,placeholder:'粘贴 {"accounts":[{"access_token":"...","refresh_token":"..."}]} 或含 access_token 的对象数组','aria-label':'账号 JSON'}),
            h('div',{className:'c2a-formrow'},h(Btn,{primary:true,onClick:importAccountsJson,disabled:advancedBusy||!importJson.trim()},'导入 JSON 账号')),
            h('p',{className:'c2a-help'},'仅从你有权使用的账号文件导入。账号信息提交至本机后端；导入成功后清空浏览器输入。')
          ),
          h(Card,{title:'CPA 服务器导入'},
            h('p',{className:'c2a-help'},'添加已授权的 CPA 连接，获取远程文件并选择导入。'),
            h('div',{className:'c2a-formrow'},
              h('input',{value:cpaDraft.name,placeholder:'连接名称',onChange:e=>setCpaDraft(v=>({...v,name:e.target.value}))}),
              h('input',{value:cpaDraft.base_url,placeholder:'CPA 服务器 https://...',onChange:e=>setCpaDraft(v=>({...v,base_url:e.target.value}))}),
              h('input',{type:'password',value:cpaDraft.secret_key,placeholder:'CPA Secret Key',onChange:e=>setCpaDraft(v=>({...v,secret_key:e.target.value}))}),
              h(Btn,{onClick:createCpaPool,disabled:advancedBusy},'保存连接')),
            h('div',{className:'c2a-formrow'},h('select',{value:cpaPool,onChange:e=>{setCpaPool(e.target.value);setCpaFiles([]);setCpaSelection([])}},h('option',{value:''},'选择 CPA 连接'),...cpaPools.map(x=>h('option',{key:x.id,value:x.id},x.name||x.base_url||x.id))),h(Btn,{onClick:loadCpaFiles,disabled:!cpaPool||advancedBusy},'获取远程文件')),
            h('div',{className:'c2a-formrow'},...cpaFiles.slice(0,100).map(x=>{const name=typeof x==='string'?x:String(x?.name||x?.filename||'');return name?h('label',{key:name},h('input',{type:'checkbox',checked:cpaSelection.includes(name),onChange:e=>setCpaSelection(v=>e.target.checked?[...new Set([...v,name])]:v.filter(a=>a!==name))}),name):null})),
            h(Btn,{onClick:importCpaFiles,primary:true,disabled:!cpaSelection.length||advancedBusy},'导入已选文件（'+cpaSelection.length+'）')
          ),
          h(Card,{title:'sub2api 账号导入'},
            h('p',{className:'c2a-help'},'输入你有权使用的 sub2api 服务地址与 API Key，再选择账号导入。'),
            h('div',{className:'c2a-formrow'},
              h('input',{value:subDraft.name,placeholder:'连接名称',onChange:e=>setSubDraft(v=>({...v,name:e.target.value}))}),
              h('input',{value:subDraft.base_url,placeholder:'sub2api 服务 https://...',onChange:e=>setSubDraft(v=>({...v,base_url:e.target.value}))}),
              h('input',{type:'password',value:subDraft.api_key,placeholder:'sub2api API Key',onChange:e=>setSubDraft(v=>({...v,api_key:e.target.value}))}),
              h(Btn,{onClick:createSubServer,disabled:advancedBusy},'保存连接')),
            h('div',{className:'c2a-formrow'},h('select',{value:subServer,onChange:e=>{setSubServer(e.target.value);setSubAccounts([]);setSubSelection([])}},h('option',{value:''},'选择 sub2api 连接'),...subServers.map(x=>h('option',{key:x.id,value:x.id},x.name||x.base_url||x.id))),h(Btn,{onClick:loadSubAccounts,disabled:!subServer||advancedBusy},'获取远程账号')),
            h('div',{className:'c2a-formrow'},...subAccounts.slice(0,100).map(x=>{const id=String(x?.id??x?.account_id??'');return id?h('label',{key:id},h('input',{type:'checkbox',checked:subSelection.includes(id),onChange:e=>setSubSelection(v=>e.target.checked?[...new Set([...v,id])]:v.filter(a=>a!==id))}),String(x?.email||x?.name||id)):null})),
            h(Btn,{onClick:importSubAccounts,primary:true,disabled:!subSelection.length||advancedBusy},'导入已选账号（'+subSelection.length+'）')
          )
        ):
        h('div',{className:'c2a-settings'},
          h(Card,{title:'跨平台 无 Docker 运行方式'},
            h('p',{className:'c2a-help'},'程序优先复用系统 Python 3.13，依赖安装在隔离环境；未检测到可用 Python 时自动下载托管环境。账号数据保留在本机数据目录。'),
            h('div',{className:'c2a-info'},'支持 Windows、macOS 或 Linux（x64/ARM64）。优先复用系统已有环境以节省下载流量与磁盘占用。不会自动获取账号或绕过任何上游额度限制。'),
            h('p',{className:'c2a-help'},text('管理页面无需额外密码。内部认证由 DSH Host 自动执行，第三方应用仍需独立用户 API Key。','管理页面通过启动终端的登录链接建立会话。第三方应用使用单独创建的用户 API Key。')),
            h('p',{className:'c2a-fieldlabel'},'查看 本机运行状态'),
            h('pre',{className:'c2a-code'},'node scripts/manage-backend.mjs status'),
            h('p',{className:'c2a-fieldlabel'},text('插件 Host 服务','程序启动与自检')),
            h('pre',{className:'c2a-code'},text('ctx.chatgpt2api.health()\nctx.chatgpt2api.models()\nctx.chatgpt2api.chatCompletion({...})\nctx.chatgpt2api.generateImage({...})','npm start\nnpm run check\nnpm run repair\nnpm run diagnose'))
          ),
          h(Card,{title:'额度为 0 时的排查提示'},
            h('p',{className:'c2a-help'},'如果账号已经导入，但剩余额度持续为 0，请去「号池管理」检查代理、运行测试并刷新全部账号的额度。'),
            h(Btn,{onClick:()=>{changeTab('accounts');openAccountDialog('proxy')}},'打开代理与额度'),
            h(Btn,{onClick:()=>changeTab('accounts')},'前往号池管理')
          ),
          h(Card,{title:'本机接口地址'},
            h('p',{className:'c2a-help'},text('服务默认绑定本机回环端口，仅供本机应用使用；修改实际端口请在插件 Host 配置中完成。','服务绑定本机回环端口；修改 API 端口可用 npm start -- --port 38660，修改管理页端口可用 --web-port 38661。')),
            h('pre',{className:'c2a-code'},endpoint?endpoint+'/v1':'http://127.0.0.1:38650/v1')
          ),
          h(Card,{title:'注意事项'},h('p',{className:'c2a-help'},'chatgpt2api 是对网站接口的逆向研究，可能失效或导致账号受限。仅使用你本人有权限使用的账号，并遵循上游项目和平台的规则。'))
        )
      ),
      h('footer',{className:'c2a-footer'},h('span',null,text('ChatGPT2API Native · 跨平台 x64 · DSH Host + OpenAI 兼容 HTTP API','ChatGPT2API · 独立运行 · OpenAI 兼容 HTTP API')),h('span',null,text('管理免密码 · 第三方 API Key 独立隔离','本机会话管理 · 第三方 API Key 独立隔离')))
    );
  }
  return {Dashboard,HeaderIcon,LogoMark,urlClean,PANEL,imageFailureText,DEFAULT_PROMPT};
}
