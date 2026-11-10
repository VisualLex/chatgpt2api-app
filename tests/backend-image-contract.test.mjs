import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as imagePatches from '../lib/backend-image-error-patch.js';
import {installPoolGifBackendPatch} from '../lib/backend-gif-patch.js';
import {extractZipSafe} from '../lib/archive.js';
import {SOURCE_COMMIT} from '../lib/platform-backend.js';

const roots=[process.env.CHATGPT2API_HOME,process.env.DSH_CHATGPT2API_HOME,path.join(os.homedir(),'.chatgpt2api'),path.join(os.homedir(),'.dsh','chatgpt2api-native')].filter(Boolean);
const snapshot=roots.map(root=>path.join(root,'downloads',`chatgpt2api-${SOURCE_COMMIT}.zip`)).find(file=>fs.existsSync(file));
const python=roots.map(root=>path.join(root,'source','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')).find(file=>fs.existsSync(file));
const targets=['services/protocol/openai_v1_image_edit.py','services/protocol/openai_v1_image_generations.py','services/protocol/conversation.py','api/image_inputs.py'];

test('image API contracts reject missing edit inputs and empty results without changing chat fallbacks',
  {skip:!snapshot||!python},t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-image-contract-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    extractZipSafe(snapshot,directory);
    const root=path.join(directory,`chatgpt2api-${SOURCE_COMMIT}`);
    installPoolGifBackendPatch(root);
    imagePatches.installImageErrorBackendPatch(root);
    const original=targets.map(file=>fs.readFileSync(path.join(root,file),'utf8'));
    const textFiles=['services/protocol/openai_v1_chat_complete.py','services/protocol/openai_v1_response.py'];
    const textOriginal=textFiles.map(file=>fs.readFileSync(path.join(root,file),'utf8'));
    const harness=String.raw`
import ast, asyncio, base64, json, sys, types
from dataclasses import dataclass, field
from pathlib import Path
from fastapi import HTTPException
from fastapi.responses import JSONResponse

root=Path(sys.argv[1])
ns=dict(base64=base64,dataclass=dataclass,field=field,time=types.SimpleNamespace(time=lambda:1234))

def load(relative, namespace, names=None):
    tree=ast.parse((root/relative).read_text(encoding='utf-8-sig'))
    nodes=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)]
    nodes += [n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) and (names is None or n.name in names)]
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),relative,'exec'),namespace)

# Exercise the API's earlier input-reading boundary and its actual OpenAI
# exception normalization, without importing upstream modules or storage.
inputs=dict(HTTPException=HTTPException)
errors=dict(JSONResponse=JSONResponse)
load('api/image_inputs.py',inputs,{'read_image_sources'})
load('services/protocol/error_response.py',errors)
try: asyncio.run(inputs['read_image_sources']([]))
except HTTPException as error:
    response=errors['openai_error_response'](error.detail,error.status_code)
    payload=json.loads(response.body)
    assert response.status_code==400 and payload['error']==dict(
        message='缺少参考图片，请上传原图后重试，或改用纯文生图提示词。',
        type='invalid_request_error',param=None,code='missing_reference_image'), (response.status_code,payload)
else: raise AssertionError('empty image sources reached generation')
reference=(b'fixture-image','reference.png','image/png')
assert asyncio.run(inputs['read_image_sources']([reference]))==[reference]

load('services/protocol/conversation.py',ns,{'ImageGenerationError','ImageOutput','ConversationRequest',
    'encode_images','stream_image_chunks','collect_image_outputs'})
Error=ns['ImageGenerationError']
Output=ns['ImageOutput']
def output(kind,**kwargs): return Output(kind=kind,model='gpt-image-2',index=1,total=2,**kwargs)

calls=[]
ns.update(count_text_tokens=lambda *_:0,count_image_output_items_tokens=lambda *_:0,
          count_image_inputs_tokens=lambda *_:0,image_usage=lambda **_:dict(total_tokens=0),
          stream_image_outputs_with_pool=lambda request:(calls.append(request) or iter([])))
edit=dict(ns)
generation=dict(ns)
load('services/protocol/openai_v1_image_edit.py',edit)
load('services/protocol/openai_v1_image_generations.py',generation)

def expect_error(action,status,code):
    try: action()
    except Error as error:
        assert error.status_code==status and error.code==code, (error.status_code,error.code,str(error))
        return error
    raise AssertionError('image endpoint accepted a request without an image result')

for stream in (False,True):
    error=expect_error(lambda:edit['handle'](dict(prompt='edit the original',stream=stream)),400,'missing_reference_image')
    assert str(error)=='缺少参考图片，请上传原图后重试，或改用纯文生图提示词。'
assert not calls, 'an edit without an image reached the upstream runner'

progress=output('progress',text='Generating...')
picture=output('result',data=[dict(b64_json='aW1hZ2U=')])
warning=output('message',text='A later image could not be generated.')

for endpoint in (generation,edit):
    body=dict(prompt='a new illustration',n=2)
    if endpoint is edit: body['images']=[(b'fixture-image','reference.png','image/png')]
    for outputs in ([],[progress],[output('message',text='Please clarify.')],[output('result')]):
        endpoint['stream_image_outputs_with_pool']=lambda _,items=outputs:iter(items)
        expect_error(lambda:endpoint['handle'](body),502,'empty_image_result')
        expect_error(lambda:list(endpoint['handle'](dict(body,stream=True))),502,'empty_image_result')

    # Progress remains immediately iterable; only terminal emptiness fails.
    endpoint['stream_image_outputs_with_pool']=lambda _:iter([progress])
    chunks=endpoint['handle'](dict(body,stream=True))
    assert next(chunks)['progress_text']=='Generating...'
    expect_error(lambda:next(chunks),502,'empty_image_result')

    # One real result remains a success even when another image has no result.
    endpoint['stream_image_outputs_with_pool']=lambda _:iter([progress,picture,warning])
    assert endpoint['handle'](body)['data']==picture.data
    chunks=list(endpoint['handle'](dict(body,stream=True)))
    assert any(chunk['data']==picture.data for chunk in chunks)

    # A specific failure is never replaced by the terminal empty-result guard.
    failure=Error('specific fixture failure',status_code=400,code='missing_reference_image')
    def fail(_):
        yield progress
        raise failure
    endpoint['stream_image_outputs_with_pool']=fail
    assert expect_error(lambda:endpoint['handle'](body),400,'missing_reference_image') is failure
    assert expect_error(lambda:list(endpoint['handle'](dict(body,stream=True))),400,'missing_reference_image') is failure

# The shared collector keeps the image-model chat text fallback opt-in unchanged.
text=ns['collect_image_outputs'](iter([output('message',text='Please clarify.')]))
assert text['data']==[] and text['message']=='Please clarify.'
chat=dict(ns)
chat.update(chat_image_args=lambda _ :('gpt-image-2','a question',1,[]),
    stream_image_outputs_with_pool=lambda request:iter([output('message',text='Please clarify.')]),
    completion_response=lambda model,content,created:dict(content=content),chat_usage_from_image_usage=lambda usage:usage)
load('services/protocol/openai_v1_chat_complete.py',chat,{'image_result_content','image_chat_response'})
assert chat['image_chat_response']({})['content']=='Please clarify.'
assert ns['ConversationRequest']().message_as_error is False
print('missing edit inputs, empty JSON/SSE results, progress, partial success and chat fallback verified')
`;
    const run=(source=root)=>spawnSync(python,['-B','-X','utf8','-',source],{encoding:'utf8',input:harness});
    const baseline=run();
    assert.notEqual(baseline.status,0,'the original input reader must reproduce its generic bad_request');
    assert.match(baseline.stderr,/bad_request/);
    t.diagnostic('Baseline reproduced: the API input reader loses the missing-reference error code.');

    assert.equal(typeof imagePatches.installImageApiContractPatch,'function');
    const result=imagePatches.installImageApiContractPatch(root);
    const check=run();
    assert.equal(check.status,0,check.stderr||check.stdout);
    assert.match(check.stdout,/chat fallback verified/);
    assert.equal(result.files,4);
    assert.equal(result.version,'image-api-contract-v2');
    const installed=targets.map(file=>fs.readFileSync(path.join(root,file),'utf8'));
    assert.equal(imagePatches.installImageApiContractPatch(root).skipped,true);
    assert.equal(imagePatches.installImageErrorBackendPatch(root).skipped,true);
    assert.equal(installPoolGifBackendPatch(root).skipped,true);
    assert.deepEqual(targets.map(file=>fs.readFileSync(path.join(root,file),'utf8')),installed);
    assert.deepEqual(textFiles.map(file=>fs.readFileSync(path.join(root,file),'utf8')),textOriginal);
    // v1 already installed guards in the first three files; upgrade only their
    // markers, and add the earlier API reader check without duplicating guards.
    const upgrade=path.join(directory,'upgrade-v1');
    for(const [index,file] of targets.entries()){
      fs.mkdirSync(path.dirname(path.join(upgrade,file)),{recursive:true});
      fs.writeFileSync(path.join(upgrade,file),index<3?installed[index].replace('image-api-contract-v2','image-api-contract-v1'):original[index]);
    }
    for(const file of [...textFiles,'services/protocol/error_response.py','services/openai_backend_api.py','.dsh-pool-gif-patch']){
      fs.mkdirSync(path.dirname(path.join(upgrade,file)),{recursive:true});
      fs.copyFileSync(path.join(root,file),path.join(upgrade,file));
    }
    const beforeUpgrade=run(upgrade);
    assert.notEqual(beforeUpgrade.status,0,'v1 must reproduce the early reader classification failure');
    assert.match(beforeUpgrade.stderr,/bad_request/);
    assert.equal(imagePatches.installImageApiContractPatch(upgrade).version,'image-api-contract-v2');
    assert.deepEqual(targets.map(file=>fs.readFileSync(path.join(upgrade,file),'utf8')),installed);
    assert.equal(installPoolGifBackendPatch(upgrade).skipped,true);
    assert.equal(imagePatches.installImageErrorBackendPatch(upgrade).skipped,true);
    assert.equal(imagePatches.installImageApiContractPatch(upgrade).skipped,true);
    const upgradedCheck=run(upgrade);
    assert.equal(upgradedCheck.status,0,upgradedCheck.stderr||upgradedCheck.stdout);

    // A changed upstream anchor must not leave a partially installed contract.
    const broken=path.join(directory,'broken');
    for(const [index,file] of targets.entries()){
      fs.mkdirSync(path.dirname(path.join(broken,file)),{recursive:true});
      fs.writeFileSync(path.join(broken,file),index===2?'unexpected source\n':original[index]);
    }
    assert.throws(()=>imagePatches.installImageApiContractPatch(broken),/anchor/);
    assert.equal(fs.readFileSync(path.join(broken,targets[0]),'utf8'),original[0]);
    assert.equal(fs.readFileSync(path.join(broken,targets[1]),'utf8'),original[1]);
  });
