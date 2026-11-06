/** DSH Host plugin: an independent cross-platform local API and account pool service. */
// Resolved from the running host instead of a bare '@deepseek-ai/cordis'
// specifier, which a `link:`-installed plugin cannot satisfy (see the module).
import {Service,SERVICE_SOURCE} from './cordis-service.js';
import {createProvider} from './provider.js';
import {PlatformBackend,ensureManagedFiles,DEFAULT_PORT} from './platform-backend.js';
import {createAdminRoute, ImagePreferencesStore} from './admin-route.js';
import {resolveImageSize} from './image-options.js';

if(SERVICE_SOURCE==='compat')console.warn('[chatgpt2api-native] 未能定位 DSH 的 @deepseek-ai/cordis，已改用兼容服务基类');

export const name='chatgpt2api-native';
export const inject=[];

export class ChatGPT2APIService extends Service {
  constructor(ctx,config={}){
    super(ctx,'chatgpt2api');
    const keyEnv=String(config.apiKeyEnv||'DSH_CHATGPT2API_KEY');
    if(!/^[A-Z][A-Z0-9_]{1,79}$/.test(keyEnv))throw Error('apiKeyEnv 名称无效');
    const configuredKey=String(keyEnv==='DSH_CHATGPT2API_KEY'
      ?(process.env.CHATGPT2API_KEY||process.env[keyEnv]||'')
      :(process.env[keyEnv]||''));
    const external=String(process.env.CHATGPT2API_URL||process.env.DSH_CHATGPT2API_URL||config.externalBaseUrl||'').trim();
    this.manager=external?null:new PlatformBackend({port:process.env.CHATGPT2API_PORT||process.env.DSH_CHATGPT2API_PORT||config.port||DEFAULT_PORT,dataDir:config.dataDir,autoStart:config.autoStart!==false,apiKey:configuredKey});
    const key=this.manager?ensureManagedFiles(this.manager.paths,configuredKey):configuredKey;
    this._adminKey=key; // Internal only: never returned to browser or third parties.
    const url=external||(this.manager?.baseUrl||`http://127.0.0.1:${DEFAULT_PORT}`);
    this.provider=createProvider({baseUrl:url,apiKey:key,timeoutMs:config.timeoutMs||240000});
    if(this.manager){
      const setup=()=>{
        void this.manager.start().catch(e=>console.error('[chatgpt2api-native] 后端启动失败:',e.message));
        return ()=>{void this.manager.stop()};
      };
      if(typeof ctx.effect==='function')ctx.effect(setup,'chatgpt2api-native: backend lifecycle');else setup();
    }
  }
  get baseUrl(){return this.provider.baseUrl}
  get apiBaseUrl(){return this.baseUrl+'/v1'}
  health(){return this.provider.health()}
  poolSummary(){return this.provider.poolSummary()}
  models(){return this.provider.models()}
  generateImage(req){
    const preferences=new ImagePreferencesStore({root:this.manager?.paths?.root}).get();
    const input={...req,model:req?.model||preferences.defaultModel};
    const size=resolveImageSize(input,preferences);
    if(size)input.size=size;
    return this.provider.generateImage(input);
  }
  chatCompletion(req){return this.provider.chatCompletion(req)}
  createResponse(req){return this.provider.createResponse(req)}
  /** The public client URL is intentionally separated from credential retrieval. */
  connectionInfo(){return {baseUrl:this.baseUrl,apiBaseUrl:this.apiBaseUrl,authentication:'Bearer API key',localOnly:true,methods:['/v1/models','/v1/chat/completions','/v1/responses','/v1/images/generations','/v1/images/edits']}}
  managedStatus(){return this.manager?.status()||{managed:false,phase:'external',baseUrl:this.baseUrl}}
}

export function apply(ctx,config={}){
  ctx.plugin(ChatGPT2APIService,config);
  // Shared DSH Connection enforces authenticated owner session and same-origin
  // before the route is invoked. No admin password is entered in the UI.
  if(typeof ctx.inject==='function')ctx.inject(['connection','chatgpt2api'],scoped=>{
    scoped.effect(()=>scoped.connection.fetch.register(createAdminRoute(scoped.chatgpt2api)));
  });
}
