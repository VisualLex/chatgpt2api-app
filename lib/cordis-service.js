/**
 * Resolve the DSH (Cordis) service base class without a bare
 * `@deepseek-ai/cordis` import.
 *
 * Why this exists: a profile installs this plugin with
 * `pnpm add link:<plugin directory>`, so the package lives outside the DSH
 * installation tree. A bare `@deepseek-ai/cordis` specifier is then resolved
 * from the plugin directory, where no such package exists, and the host logs
 *
 *   chatgpt2api-native (dsh-plugin-chatgpt2api):
 *   failed to import: ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'
 *
 * which drops the whole plugin entry (no sidebar panel, no Host service, no
 * backend). Nothing on the plugin side can install that package, because a
 * second copy of Cordis would also mean a second `Service` identity.
 *
 * Instead, resolve the module from the running DSH host entry point. Both the
 * host and this plugin then import the exact same file URL, so the ESM cache
 * answers with the already-loaded module and the plugin extends the very same
 * `Service` class. When no DSH installation is reachable (plain Node, unit
 * tests), a small compatible base class registers the service through the
 * public `ctx.reflect.provide` registry and Cordis' global symbols.
 */
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const PACKAGE='@deepseek-ai/cordis';
const TRACKER=Symbol.for('cordis.tracker');
const FILTER=Symbol.for('cordis.filter');
const ISOLATE=Symbol.for('cordis.isolate');

/** Entry points a running host may be launched from, most accurate first. */
function hostReferrers(){
  const referrers=[];
  const entry=process.argv[1];
  if(typeof entry==='string'&&entry.length>0)referrers.push(entry);
  try{referrers.push(fileURLToPath(import.meta.url))}catch{/* import.meta.url is always available in ESM */};
  return referrers;
}

/** Import the host's own Cordis instance, or undefined when it cannot be located. */
async function loadHostService(){
  for(const referrer of hostReferrers()){
    try{
      const resolved=createRequire(pathToFileURL(referrer)).resolve(PACKAGE);
      const module=await import(pathToFileURL(resolved).href);
      if(typeof module.Service==='function')return module.Service;
    }catch{/* try the next referrer */};
  }
  return undefined;
}

/**
 * Compatible stand-in for Cordis `Service`.
 * It reproduces what the real constructor does that matters here: publish the
 * instance in the current fiber through `ctx.reflect.provide`, and carry the
 * tracker metadata the registry uses for tracing and isolation filtering.
 */
class CompatService{
  constructor(ctx,name){
    if(typeof name!=='string'||name.length===0)throw Error('chatgpt2api: 服务名不能为空');
    this.ctx=ctx;
    this.name=name;
    Object.defineProperty(this,TRACKER,{value:{associate:name,property:'ctx'},configurable:true,enumerable:false,writable:true});
    const registry=ctx?.reflect;
    if(typeof registry?.provide!=='function')throw Error('chatgpt2api: 当前 DSH 宿主缺少 ctx.reflect.provide，无法注册 chatgpt2api 服务');
    registry.provide(name,this);
  }
  [FILTER](ctx){
    return ctx?.[ISOLATE]?.[this.name]===this.ctx?.[ISOLATE]?.[this.name];
  }
}

const hostService=await loadHostService();

/** `'host'` when the DSH Cordis instance was reused, `'compat'` for the fallback. */
export const SERVICE_SOURCE=hostService===undefined?'compat':'host';

export const Service=hostService??CompatService;
