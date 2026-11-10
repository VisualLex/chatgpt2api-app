import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {extractZipSafe} from '../lib/archive.js';
import {installPoolGifBackendPatch} from '../lib/backend-gif-patch.js';
import {installImageErrorBackendPatch,installImageApiContractPatch} from '../lib/backend-image-error-patch.js';
import {SOURCE_COMMIT} from '../lib/platform-backend.js';

const homes=[process.env.CHATGPT2API_HOME,process.env.DSH_CHATGPT2API_HOME,path.join(os.homedir(),'.chatgpt2api'),path.join(os.homedir(),'.dsh','chatgpt2api-native')].filter(Boolean);
const snapshot=homes.map(root=>path.join(root,'downloads',`chatgpt2api-${SOURCE_COMMIT}.zip`)).find(file=>fs.existsSync(file));
const python=homes.map(root=>path.join(root,'source','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')).find(file=>fs.existsSync(file));

// Shipped helpers retained to exercise real installed-version upgrades.
const V1_HELPER=String.raw`def build_image_task_prompt(prompt: str, reference_count: int) -> str:
    if reference_count:
        task = (
            f"Image editing task. {reference_count} input image(s) are attached. "
            "Use the attached images as the actual editing inputs. Apply the user's requested changes "
            "and preserve the details the user asks to keep. "
        )
    else:
        task = (
            "Image generation task. No input images are attached. "
            "Generate a new image from the user's visual description. Treat mentions of reference "
            "images as textual descriptions, not as attached images. "
        )
    return (
        task + "Use the image generation tool to produce an actual image. Return the image result directly; "
        "do not substitute a text-only plan or ask whether to start.\n\nUser request:\n" + prompt
    )


`;

const V2_HELPER=String.raw`def build_image_task_prompt(prompt: str, reference_count: int) -> str:
    if reference_count:
        task = (
            f"Image editing task. {reference_count} input image(s) are attached. "
            "Use the attached images as the actual editing inputs. Apply the user's requested changes "
            "and preserve the details the user asks to keep. "
        )
    else:
        task = (
            "Image generation task. No input images are attached. "
            "Generate a new image independently from the user's visual description above. "
            "Mentions of source or reference images do not provide actual image files. "
            "Image-preservation and style-transfer constraints apply only when actual images are attached; "
            "none are attached in this request. Use the visual details available to create a new image "
            "without requesting an upload. "
        )
    return (
        "User image specification:\n<image_request>\n" + prompt + "\n</image_request>\n\n"
        "Image API execution instructions:\n" + task +
        "Use the image generation tool to produce an actual image. Return the image result directly; "
        "do not substitute a text-only plan or ask whether to start."
    )


`;

const V3_HELPER=String.raw`def build_image_task_prompt(prompt: str, reference_count: int) -> str:
    if reference_count:
        task = (
            f"Image editing task. {reference_count} input image(s) are attached. "
            "Use the attached images as the actual editing inputs. Apply the user's requested changes "
            "and preserve the details the user asks to keep. "
        )
    else:
        task = (
            "Image generation task. No input images are attached. "
            "Generate a new image independently from the user's visual description above. "
            "Mentions of source or reference images do not provide actual image files. "
            "If the requested operation requires an unavailable input image, report the missing input "
            "instead of claiming to have preserved or edited an image. "
        )
    return (
        "User image specification:\n<image_request>\n" + prompt + "\n</image_request>\n\n"
        "Image API execution instructions:\n" + task +
        "Use the image generation tool to produce an actual image. Return the image result directly; "
        "do not substitute a text-only plan or ask whether to start."
    )


`;

// Run the production request-to-backend chain without importing account storage
// or opening an upstream connection. The terminal fixture stops after capture;
// image result parsing is covered by the existing backend replay tests.
const harness=String.raw`
import ast, sys, types
from dataclasses import dataclass, field
from pathlib import Path

config=types.SimpleNamespace(global_system_prompt='')
logger=types.SimpleNamespace(info=lambda *_:None)
namespace=dict(dataclass=dataclass,field=field,config=config,logger=logger,
    time=types.SimpleNamespace(time=lambda:1),normalize_messages=lambda messages:messages,
    is_supported_image_model=lambda model:model.startswith('gpt-image-'),
    iter_conversation_payloads=lambda payloads,*_:payloads,
    is_missing_reference_image_message=lambda _:False,
    _get_detailed_error_from_tasks=lambda *_args,**_kwargs:'')
names={'ConversationRequest','ImageOutput','ImageGenerationError','build_image_prompt',
    'build_image_task_prompt','prompt_with_global_system','conversation_events','stream_image_outputs'}
tree=ast.parse((Path(sys.argv[1])/'services/protocol/conversation.py').read_text(encoding='utf-8-sig'))
nodes=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)]
nodes += [node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in names]
exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'conversation.py','exec'),namespace)

class Backend:
    def stream_conversation(self,**kwargs):
        self.captured=kwargs
        return iter([dict(type='conversation.complete',text='terminal fixture',blocked=True)])

def capture(prompt,images=None,enabled=True,**options):
    backend=Backend()
    request=namespace['ConversationRequest'](model='gpt-image-2.6',prompt=prompt,
        images=images,message_as_error=enabled,quality='',**options)
    list(namespace['stream_image_outputs'](backend,request))
    assert request.prompt==prompt, 'the original request was mutated'
    assert backend.captured['images']==(images or []), 'input images were changed'
    if images:
        assert backend.captured['images'] is images, 'input image payloads were replaced'
    assert backend.captured['system_hints']==['picture_v2']
    return backend.captured

# Prompts with and without reference-related words must follow the actual inputs.
for prompt in ['Draw a blue bird.', '保留参考图的姿势与人物，把背景改成森林。',
               'Put the words reference, edit, missing and upload on a sign.']:
    captured=capture(prompt)
    assert 'Image generation task.' in captured['prompt'], 'task constraint missing on the production image path'
    specification='User image specification:\n<image_request>\n'+prompt+'\n</image_request>\n\n'
    assert captured['prompt'].startswith(specification)
    footer=captured['prompt'][len(specification):]
    assert footer.startswith('Image API execution instructions:\nImage generation task. Create exactly one new image from the visual description above.')
    assert 'use the image generation tool' in footer.lower()
    assert not any(word in footer.lower() for word in ('reference','edit','missing','upload')), 'generation instructions introduced unavailable-image concepts'

for images in [['fixture-image-one'],['fixture-image-one','fixture-image-two']]:
    for prompt in ['Draw a blue bird.', '请按参考图修改背景，保留原图人物。']:
        captured=capture(prompt,images)
        assert 'Image editing task.' in captured['prompt']
        assert f'{len(images)} input image(s) are attached.' in captured['prompt']
        assert 'No input images are attached.' not in captured['prompt']
        assert 'use the image generation tool' in captured['prompt'].lower()
        assert captured['prompt'].startswith('User image specification:\n<image_request>\n'+prompt+'\n</image_request>\n\n')
        assert '\n</image_request>\n\nImage API execution instructions:\nImage editing task.' in captured['prompt']

helper=namespace['build_image_task_prompt']
original='  保留所有标点、换行与英文。\nIMPORTANT: Keep the exact original pose and identity.  \n'
for count in [0,1,2]:
    specification='User image specification:\n<image_request>\n'+original+'\n</image_request>\n\n'
    wrapped=helper(original,count)
    assert wrapped.startswith(specification), 'user prompt was stripped or rewritten'
    assert wrapped[len(specification):].startswith('Image API execution instructions:\n'), 'execution instructions must follow the complete original specification'

# Chat/Responses image-model requests use this shared function with opt-in false.
for images in [None,['fixture-image-one']]:
    prompt='保留参考图，照着文字创作。'
    assert capture(prompt,images,enabled=False)['prompt']==prompt

# Existing global instructions and format hints still reach the backend after
# task wrapping. The separate user request remains intact in the request object.
config.global_system_prompt='Global image policy.'
backend=Backend()
request=namespace['ConversationRequest'](model='gpt-image-2.6',prompt='Animate the blue bird.',
    images=['fixture-image-one'],message_as_error=True,size='1024x1536',quality='high',
    output_format='gif',frame_count=8,frame_duration_ms=80)
list(namespace['stream_image_outputs'](backend,request))
prompt=backend.captured['prompt']
assert prompt.startswith('Global image policy.\n\n')
for part in ['Image editing task.','1 input image(s) are attached.',
             'User image specification:\n<image_request>\nAnimate the blue bird.\n</image_request>\n\nImage API execution instructions:\n',
             '输出图片尺寸为 1024x1536。','输出图片质量为 high。',
             '生成格式为 gif 动图；输出真正的多帧动画，不要输出分镜拼图或静态帧。',
             'frame_count: 8。','frame_duration_ms: 80。']:
    assert part in prompt, 'task wrapping dropped an existing image instruction: '+part
assert backend.captured['images'] is request.images
assert request.prompt=='Animate the blue bird.'
print('image task scope, real attachments, original prompts and GIF hints verified')
`;

test('image task backport constrains only image API requests and preserves their real inputs',
  {skip:!snapshot||!python},async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-c2a-image-task-'));
    t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
    extractZipSafe(snapshot,dir);
    const root=path.join(dir,`chatgpt2api-${SOURCE_COMMIT}`);
    installPoolGifBackendPatch(root);
    installImageErrorBackendPatch(root);
    installImageApiContractPatch(root);
    const run=()=>spawnSync(python,['-B','-X','utf8','-',root],{encoding:'utf8',input:harness});

    const baseline=run();
    assert.notEqual(baseline.status,0,'the existing image path must demonstrate the missing task constraint');
    assert.match(baseline.stderr,/task constraint missing on the production image path/);

    const {installImageTaskBackendPatch}=await import('../lib/backend-image-task-patch.js');
    assert.equal(installImageTaskBackendPatch(root).version,'image-task-v4');
    const check=run();
    assert.equal(check.status,0,check.stderr||check.stdout);
    assert.match(check.stdout,/original prompts and GIF hints verified/);

    const file=path.join(root,'services','protocol','conversation.py');
    const installed=fs.readFileSync(file,'utf8');
    assert.equal(installImageTaskBackendPatch(root).skipped,true);
    assert.equal(fs.readFileSync(file,'utf8'),installed);
    // A normal startup repeats every installer, including the older patch tags.
    assert.equal(installPoolGifBackendPatch(root).skipped,true);
    assert.equal(installImageErrorBackendPatch(root).skipped,true);
    assert.equal(installImageApiContractPatch(root).skipped,true);
    assert.equal(installImageTaskBackendPatch(root).skipped,true);
    assert.equal(fs.readFileSync(file,'utf8'),installed);

    // Upgrade the actual old helper and marker without relying on the version
    // currently installed in the developer's managed runtime.
    const helperStart=installed.indexOf('def build_image_task_prompt(');
    const helperEnd=installed.indexOf('def build_image_prompt(',helperStart);
    assert.ok(helperStart>=0&&helperEnd>helperStart);
    for(const [version,helper] of [['image-task-v1',V1_HELPER],['image-task-v2',V2_HELPER],['image-task-v3',V3_HELPER]]){
      const previous=(installed.slice(0,helperStart)+helper+installed.slice(helperEnd))
        .replace('# DSH_IMAGE_TASK_PATCH image-task-v4\n','# DSH_IMAGE_TASK_PATCH '+version+'\n');
      fs.writeFileSync(file,previous);
      const upgrade=installImageTaskBackendPatch(root);
      assert.deepEqual(upgrade,{version:'image-task-v4',files:1,skipped:false});
      assert.equal(fs.readFileSync(file,'utf8'),installed,version+' upgrade must produce the same source as a fresh v4 install');
      assert.equal(installImageTaskBackendPatch(root).skipped,true);
      const upgraded=run();
      assert.equal(upgraded.status,0,upgraded.stderr||upgraded.stdout);
    }

    fs.writeFileSync(file,'unexpected upstream source\n');
    assert.throws(()=>installImageTaskBackendPatch(root),/anchor|源码|补丁/i);
    assert.equal(fs.readFileSync(file,'utf8'),'unexpected upstream source\n');
  });
