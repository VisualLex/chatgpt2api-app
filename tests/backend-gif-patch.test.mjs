import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {installPoolGifBackendPatch,upgradePoolGifConversation} from '../lib/backend-gif-patch.js';
import {extractZipSafe} from '../lib/archive.js';
import {SOURCE_COMMIT} from '../lib/platform-backend.js';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dsh-c2a-gif-'));

// Minimal reproduction of the v2 patch that shipped in the earlier build: the
// GIF check raises for the first still frame instead of skipping it.
const V2_FILE=[
  '# DSH_POOL_GIF_PATCH pool-gif-v2',
  'def format_image_result(items, prompt, response_format, output_format=None):',
  '    data = []',
  '    for item in items:',
  '        b64_json = str(item.get("b64_json") or "").strip()',
  '        revised_prompt = str(item.get("revised_prompt") or prompt).strip() or prompt',
  '        if output_format == "gif" and not base64.b64decode(b64_json).startswith((b"GIF87a", b"GIF89a")):',
  '            raise ImageGenerationError("upstream did not return an animated GIF", status_code=502)',
  '        if response_format == "b64_json":',
  '            data.append({"b64_json": b64_json})',
  '    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}',
  '    if message and not data:',
  '        result["message"] = message',
  '    return result',
  ''
].join('\n');

test('the v2 GIF check is upgraded to skip still frames and fail only when nothing animates',()=>{
  const upgraded=upgradePoolGifConversation(V2_FILE);
  assert.ok(upgraded);
  assert.match(upgraded,/^# DSH_POOL_GIF_PATCH pool-gif-v3\n/);
  assert.doesNotMatch(upgraded,/raise ImageGenerationError\("upstream did not return an animated GIF", status_code=502\)\n        if response_format/);
  assert.match(upgraded,/GIF89a"\)\):\n            continue\n/);
  assert.match(upgraded,/if output_format == "gif" and not data:\n        raise ImageGenerationError\("upstream did not return an animated GIF", status_code=502\)\n    result:/);
  // Non-v2 input is never rewritten.
  assert.equal(upgradePoolGifConversation('# DSH_POOL_GIF_PATCH pool-gif-v3\n'),null);
  assert.equal(upgradePoolGifConversation('plain upstream source\n'),null);
});

test('installing over a v2 patched tree upgrades the file and the marker',t=>{
  const root=temp();
  t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  fs.mkdirSync(path.join(root,'services','protocol'),{recursive:true});
  fs.mkdirSync(path.join(root,'api'),{recursive:true});
  const file=path.join(root,'services','protocol','conversation.py');
  fs.writeFileSync(file,V2_FILE);
  // The other patched files are unchanged by v3 but must not keep a stale header.
  fs.writeFileSync(path.join(root,'api','ai.py'),'# DSH_POOL_GIF_PATCH pool-gif-v2\nimport x\n');
  fs.writeFileSync(path.join(root,'.dsh-pool-gif-patch'),'pool-gif-v2\n');

  const result=installPoolGifBackendPatch(root);
  assert.deepEqual({version:result.version,upgraded:result.upgraded},{version:'pool-gif-v3',upgraded:true});
  assert.equal(fs.readFileSync(path.join(root,'.dsh-pool-gif-patch'),'utf8').trim(),'pool-gif-v3');
  const upgraded=fs.readFileSync(file,'utf8');
  assert.match(upgraded,/continue/);
  assert.match(upgraded,/if output_format == "gif" and not data:/);
  assert.match(fs.readFileSync(path.join(root,'api','ai.py'),'utf8'),/^# DSH_POOL_GIF_PATCH pool-gif-v3\n/);

  // Second install is a no-op, so startup stays idempotent.
  assert.equal(installPoolGifBackendPatch(root).skipped,true);
});

test('a stale v2 header is repaired even when the marker already says v3',t=>{
  const root=temp();
  t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  fs.mkdirSync(path.join(root,'api'),{recursive:true});
  fs.writeFileSync(path.join(root,'api','ai.py'),'# DSH_POOL_GIF_PATCH pool-gif-v2\nimport x\n');
  fs.writeFileSync(path.join(root,'.dsh-pool-gif-patch'),'pool-gif-v3\n');
  assert.equal(installPoolGifBackendPatch(root).skipped,true);
  assert.match(fs.readFileSync(path.join(root,'api','ai.py'),'utf8'),/^# DSH_POOL_GIF_PATCH pool-gif-v3\n/);
});

test('a corrupted v2 tree fails loudly instead of half-patching',t=>{
  const root=temp();
  t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  fs.mkdirSync(path.join(root,'services','protocol'),{recursive:true});
  fs.writeFileSync(path.join(root,'services','protocol','conversation.py'),'# DSH_POOL_GIF_PATCH pool-gif-v2\nunexpected body\n');
  fs.writeFileSync(path.join(root,'.dsh-pool-gif-patch'),'pool-gif-v2\n');
  assert.throws(()=>installPoolGifBackendPatch(root),/无法从 pool-gif-v2 升级/);
});

const snapshotRoots=[process.env.CHATGPT2API_HOME,process.env.DSH_CHATGPT2API_HOME,path.join(os.homedir(),'.chatgpt2api'),path.join(os.homedir(),'.dsh','chatgpt2api-native')].filter(Boolean);
const cachedSnapshot=snapshotRoots.map(root=>path.join(root,'downloads',`chatgpt2api-${SOURCE_COMMIT}.zip`)).find(file=>fs.existsSync(file))||'';
test('the full backport applies to the pinned upstream snapshot',{skip:!fs.existsSync(cachedSnapshot)},t=>{
  const dir=temp();
  t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
  extractZipSafe(cachedSnapshot,dir);
  const root=path.join(dir,`chatgpt2api-${SOURCE_COMMIT}`);
  const result=installPoolGifBackendPatch(root);
  assert.equal(result.version,'pool-gif-v3');
  assert.equal(result.files,8);
  const conversation=fs.readFileSync(path.join(root,'services','protocol','conversation.py'),'utf8');
  // Still frames are skipped; the animation is returned; only an all-still reply fails.
  assert.match(conversation,/GIF89a"\)\):\n            continue\n/);
  assert.match(conversation,/if output_format == "gif" and not data:/);
  assert.match(conversation,/output_format: str \| None = None/);
  assert.equal(installPoolGifBackendPatch(root).skipped,true);
});

const cachedPython=snapshotRoots.map(root=>path.join(root,'source','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')).find(file=>fs.existsSync(file));

test('image errors backport stops completed missing-reference replies and preserves asynchronous results',
  {skip:!cachedSnapshot||!cachedPython},async t=>{
    const {installImageErrorBackendPatch}=await import('../lib/backend-image-error-patch.js');
    const dir=temp();
    t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
    extractZipSafe(cachedSnapshot,dir);
    const root=path.join(dir,`chatgpt2api-${SOURCE_COMMIT}`);
    installPoolGifBackendPatch(root);
    const files=['services/openai_backend_api.py','services/protocol/conversation.py'];

    // Execute the patched production parsers and runner without importing the
    // upstream app (which initializes real account storage). No network or sleeps.
    const harness=String.raw`
import ast, base64, json, re, sys, types
from dataclasses import dataclass, field
from pathlib import Path

class Clock:
    def __init__(self): self.now = 0
    def time(self): return self.now
    def sleep(self, seconds): self.now += seconds

clock = Clock()
config = types.SimpleNamespace(image_poll_timeout_secs=5, image_poll_interval_secs=1, image_poll_initial_wait_secs=0,
    image_settle_enabled=False, image_settle_secs=0, image_check_before_hit_enabled=False)
logger = types.SimpleNamespace(**{name:lambda *args, **kwargs:None for name in ('info','debug','warning','error')})
class UpstreamHTTPError(Exception): pass
class RequestException(Exception): pass
namespace = dict(re=re, json=json, base64=base64, dataclass=dataclass, field=field,
    time=clock, random=types.SimpleNamespace(uniform=lambda *_:0), config=config, logger=logger,
    UpstreamHTTPError=UpstreamHTTPError, requests=types.SimpleNamespace(exceptions=types.SimpleNamespace(RequestException=RequestException)))

def load(relative, ns):
    tree=ast.parse((Path(sys.argv[1])/relative).read_text(encoding='utf-8-sig'))
    nodes=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)]
    nodes += [node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef,ast.Assign,ast.AnnAssign))]
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),relative,'exec'),ns)

load('services/openai_backend_api.py',namespace)
backend_type=namespace['OpenAIBackendAPI']
missing_error=namespace.get('ImageMissingReferenceError',type('MissingReferenceExpected',(Exception,),{}))
protocol=dict(namespace)
load('services/protocol/conversation.py',protocol)
protocol['save_image_bytes']=lambda *_:'memory-image.png'

file_id='file_000000001234567890abcdef12345678'
tool_text='The user asked to edit or restore a specific existing image, but there is no usable image target in the conversation. Do not retry image generation. Tell the user to upload or identify the original image.'

def message(role,text='',status='finished_successfully',end=True):
    return dict(author=dict(role=role),content=dict(content_type='text',parts=[text]),
                status=status,end_turn=end,channel='final' if role=='assistant' else 'commentary',
                metadata={},create_time=2)

def document(reply, old_error=False):
    mapping={'user':dict(message=message('user','Create a new illustration'),parent=None),
             'reply':dict(message=reply,parent='user')}
    if old_error:
        mapping['old-user']=dict(message=message('user','old request'),parent=None)
        mapping['old-error']=dict(message=message('assistant','请上传需要进行风格迁移的原始图片。'),parent='old-user')
        mapping['user']['parent']='old-error'
    return dict(mapping=mapping,current_node='reply')

def image_document():
    reply=message('tool')
    reply['content']=dict(content_type='multimodal_text',parts=[dict(content_type='image_asset_pointer',asset_pointer='sediment://'+file_id)])
    reply['metadata']['async_task_type']='image_gen'
    return document(reply)

def backend(documents):
    instance=object.__new__(backend_type)
    values=iter(documents)
    latest=documents[-1]
    instance._get_conversation=lambda _:next(values,latest)
    instance._query_backend_tasks=lambda **_:[]
    instance._resolve_image_urls=lambda *_:['memory-image']
    instance.download_image_bytes=lambda _:[b'fixture-image']
    return instance

def assert_missing(reply):
    instance=backend([document(reply)])
    try: instance._poll_image_results('fixture',timeout_secs=5)
    except missing_error: return
    raise AssertionError('completed missing-reference reply did not stop polling')

assert_missing(message('tool',tool_text))
assert_missing(message('assistant','请上传需要进行风格迁移的原始图片。'))
assert_missing(message('assistant','目前没有检测到可供风格迁移的参考图片。请上传需要处理的原图。'))

for first in [
    document(message('assistant','请上传需要进行风格迁移的原始图片。',status='in_progress',end=False)),
    document(message('user','请上传需要进行风格迁移的原始图片。')),
    document(message('assistant','正在生成图片，请稍候。',status='in_progress',end=False)),
    document(message('assistant','正在生成图片。',status='in_progress',end=False),old_error=True),
    document(message('assistant','如果你希望进一步修改，可以上传参考图片。')),
    document(message('assistant','如果你希望进一步修改：\n请上传原始图片。')),
]:
    instance=backend([first,image_document()])
    files,sediments=instance._poll_image_results('fixture',timeout_secs=5)
    assert file_id in files or file_id in sediments, 'nonterminal reply incorrectly aborted image generation'

# An image result wins over an unrelated or earlier text error.
with_image=image_document()
with_image['mapping']['old-error']=dict(message=message('tool',tool_text),parent='user')
files,sediments=backend([with_image])._poll_image_results('fixture',timeout_secs=5)
assert file_id in files or file_id in sediments

def events(reply):
    payloads=[json.dumps(dict(type='server_ste_metadata',metadata=dict(tool_invoked=True,turn_use_case='image gen'))),
              json.dumps(dict(conversation_id='fixture',message=reply)), '[DONE]']
    return list(protocol['iter_conversation_payloads'](iter(payloads)))

request=protocol['ConversationRequest'](model='gpt-image-2.6',prompt='new illustration',response_format='b64_json')
for reply in [message('tool',tool_text),message('assistant','请上传需要进行风格迁移的原始图片。')]:
    instance=backend([document(reply)])
    def no_poll(*args,**kwargs): raise AssertionError('completed missing-reference SSE reply entered polling')
    instance.resolve_conversation_image_urls=no_poll
    protocol['conversation_events']=lambda *_args,**_kwargs:iter(events(reply))
    try: list(protocol['stream_image_outputs'](instance,request))
    except protocol['ImageGenerationError'] as error:
        assert error.status_code==400 and error.code=='missing_reference_image'
    else: raise AssertionError('missing-reference SSE reply was not reported as an invalid request')

# An interrupted stream with no completed final reply must still resolve later output.
pending=message('assistant','正在生成图片，请稍候。',status='in_progress',end=False)
protocol['conversation_events']=lambda *_args,**_kwargs:iter(events(pending))
outputs=list(protocol['stream_image_outputs'](backend([image_document()]),request))
assert any(item.kind=='result' for item in outputs)

# Later fallback polls pass through the pool runner as the same actionable 400.
def missing_fallback(*_): raise missing_error('Missing reference image', 'fixture')
protocol['stream_image_outputs']=missing_fallback
protocol['OpenAIBackendAPI']=lambda **_:backend([image_document()])
protocol['split_image_model']=lambda _:(None,None)
protocol['is_codex_image_model']=lambda _:False
protocol['_remove_image_conversation_later']=lambda *_args,**_kwargs:None
protocol['account_service']=types.SimpleNamespace(get_available_access_token=lambda **_:'fixture',
    get_account=lambda _:dict(email='fixture@example.test'),mark_image_result=lambda *_:None)
try: protocol['_generate_single_image'](request,1,1)
except protocol['ImageGenerationError'] as error:
    assert error.status_code==400 and error.code=='missing_reference_image' and error.conversation_id=='fixture'
else: raise AssertionError('a missing-reference fallback error became a generic failure')
print('terminal missing-reference replies, normal async generation, image precedence and current-turn isolation verified')
`;
    const baseline=spawnSync(cachedPython,['-B','-X','utf8','-',root],{encoding:'utf8',input:harness});
    assert.notEqual(baseline.status,0,'the unpatched production poller must reproduce the timeout');
    assert.match(baseline.stderr,/ImagePollTimeoutError/);

    installImageErrorBackendPatch(root);
    const installed=files.map(file=>fs.readFileSync(path.join(root,file),'utf8'));
    assert.equal(installImageErrorBackendPatch(root).skipped,true);
    assert.deepEqual(files.map(file=>fs.readFileSync(path.join(root,file),'utf8')),installed);
    const check=spawnSync(cachedPython,['-B','-X','utf8','-',root],{encoding:'utf8',input:harness});
    assert.equal(check.status,0,check.stderr||check.stdout);
    assert.match(check.stdout,/current-turn isolation verified/);

    // A source mismatch must leave the other target file intact.
    const broken=temp();
    t.after(()=>fs.rmSync(broken,{force:true,recursive:true}));
    extractZipSafe(cachedSnapshot,broken);
    const brokenRoot=path.join(broken,`chatgpt2api-${SOURCE_COMMIT}`);
    installPoolGifBackendPatch(brokenRoot);
    const backendFile=path.join(brokenRoot,files[0]);
    const originalBackend=fs.readFileSync(backendFile,'utf8');
    fs.writeFileSync(path.join(brokenRoot,files[1]),'unexpected upstream source\n');
    assert.throws(()=>installImageErrorBackendPatch(brokenRoot),/anchor|源码|补丁/i);
    assert.equal(fs.readFileSync(backendFile,'utf8'),originalBackend);
  });
