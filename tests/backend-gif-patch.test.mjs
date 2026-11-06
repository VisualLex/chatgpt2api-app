import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
