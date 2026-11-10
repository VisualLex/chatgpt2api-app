/** Give image endpoints explicit task instructions without rewriting user prompts. */
import fs from 'node:fs';
import path from 'node:path';

const VERSION='image-task-v4';
const TAG='# DSH_IMAGE_TASK_PATCH '+VERSION+'\n';
const PREVIOUS_TAGS=['image-task-v1','image-task-v2','image-task-v3'].map(version=>'# DSH_IMAGE_TASK_PATCH '+version+'\n');
const HELPER=String.raw`
def build_image_task_prompt(prompt: str, reference_count: int) -> str:
    if reference_count:
        task = (
            f"Image editing task. {reference_count} input image(s) are attached. "
            "Use the attached images as the actual editing inputs. Apply the user's requested changes "
            "and preserve the details the user asks to keep. "
        )
    else:
        task = (
            "Image generation task. Create exactly one new image from the visual description above. "
        )
    return (
        "User image specification:\n<image_request>\n" + prompt + "\n</image_request>\n\n"
        "Image API execution instructions:\n" + task +
        "Use the image generation tool to produce an actual image. Return the image result directly; "
        "do not substitute a text-only plan or ask whether to start."
    )


`;

export function installImageTaskBackendPatch(sourceRoot){
  const relative='services/protocol/conversation.py';
  const filename=path.join(sourceRoot,relative);
  let text=fs.readFileSync(filename,'utf8');
  if(text.includes(TAG))return {version:VERSION,files:0,skipped:true};
  const change=(needle,replacement)=>{
    const at=text.indexOf(needle);
    if(at<0||text.indexOf(needle,at+needle.length)>=0)throw Error('Image task patch source anchor mismatch: '+relative);
    text=text.slice(0,at)+replacement+text.slice(at+needle.length);
  };
  const previousTag=PREVIOUS_TAGS.find(tag=>text.includes(tag));
  if(previousTag){
    const start=text.indexOf('def build_image_task_prompt(');
    const end=text.indexOf('def build_image_prompt(',start);
    if(start<0||end<start)throw Error('Image task patch source anchor mismatch: '+relative);
    text=text.slice(0,start)+HELPER.trimStart()+text.slice(end);
    change(previousTag,TAG);
  }else{
    change('def build_image_prompt(',HELPER+'def build_image_prompt(');
    change('            backend,\n            prompt=request.prompt,\n            model=request.model,\n            images=request.images or [],',
      '            backend,\n            prompt=build_image_task_prompt(request.prompt, len(request.images or [])) if request.message_as_error else request.prompt,\n            model=request.model,\n            images=request.images or [],');
    text+='\n'+TAG;
  }
  const temporary=filename+'.dsh-image-task-tmp';
  fs.writeFileSync(temporary,text,{mode:0o600});
  fs.renameSync(temporary,filename);
  return {version:VERSION,files:1,skipped:false};
}
