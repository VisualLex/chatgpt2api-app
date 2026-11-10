/** Preserve terminal missing-reference replies instead of polling them as pending images. */
import fs from 'node:fs';
import path from 'node:path';

const TAG='# DSH_IMAGE_ERRORS_PATCH image-errors-v1\n';
const BACKEND_HELPERS=String.raw`
class ImageMissingReferenceError(ImageTaskError):
    pass


def is_missing_reference_image_message(message: Dict[str, Any]) -> bool:
    """Only completed tool refusals or final requests for an original image qualify."""
    if message.get("status") != "finished_successfully":
        return False
    role = str((message.get("author") or {}).get("role") or "")
    content = message.get("content") or {}
    if not isinstance(content, dict) or content.get("content_type") != "text":
        return False
    text = "\n".join(part for part in content.get("parts", []) if isinstance(part, str)).strip()
    if role == "tool":
        return bool(re.search(r"\bno usable image target\b", text, re.IGNORECASE))
    if role != "assistant" or message.get("end_turn") is not True or message.get("channel") not in (None, "", "final"):
        return False
    # Match direct requests, never conditional suggestions such as "if you want ...".
    match = re.search(
        r"(?:^|\n)\s*(?:\*\*)?(?:请(?:先|再)?上传[^\n。！？]{0,60}(?:原图|原始图片|原始参考图片|参考图|图片)|"
        r"(?:目前|当前)?(?:没有检测到|未检测到|缺少)[^\n。！？]{0,40}(?:参考图|目标图|原图)|"
        r"please (?:upload|attach|provide)\b[^\n.!?]{0,80}\b(?:original|reference|source|target) image\b)",
        text, re.IGNORECASE,
    )
    return bool(match) and not re.search(r"如果|若|\bif\b", text[:match.start()], re.IGNORECASE)


def find_missing_reference_image_error(data: Dict[str, Any]) -> bool:
    """Inspect the current turn only; earlier failed edits are irrelevant."""
    mapping = data.get("mapping") or {}
    current = data.get("current_node")
    if current not in mapping:
        # Without a branch pointer, do not guess which older turn is active.
        return False
    seen = set()
    while current in mapping and current not in seen:
        seen.add(current)
        node = mapping[current] or {}
        message = node.get("message") or {}
        if (message.get("author") or {}).get("role") == "user":
            break
        if is_missing_reference_image_message(message):
            return True
        current = node.get("parent")
    return False


`;

function replaceOnce(text,needle,replacement,file){
  const at=text.indexOf(needle);
  if(at<0||text.indexOf(needle,at+needle.length)>=0)throw Error('Image error patch source anchor mismatch: '+file);
  return text.slice(0,at)+replacement+text.slice(at+needle.length);
}

export function installImageErrorBackendPatch(sourceRoot){
  const files=['services/openai_backend_api.py','services/protocol/conversation.py'];
  const pending=[];
  for(const relative of files){
    const filename=path.join(sourceRoot,relative);
    let text=fs.readFileSync(filename,'utf8');
    if(text.startsWith(TAG))continue;
    const change=(needle,replacement)=>{text=replaceOnce(text,needle,replacement,relative)};
    if(relative==='services/openai_backend_api.py'){
      change('class OpenAIBackendAPI:',BACKEND_HELPERS+'class OpenAIBackendAPI:');
      change('            if not file_ids and not sediment_ids:\n                policy_msg = self._find_content_policy_error_in_conversation(conversation)',
        '            if not file_ids and not sediment_ids:\n                if find_missing_reference_image_error(conversation):\n                    raise ImageMissingReferenceError("Missing reference image", conversation_id)\n                policy_msg = self._find_content_policy_error_in_conversation(conversation)');
    }else{
      change('from services.openai_backend_api import ImageContentPolicyError, ImagePollTimeoutError, OpenAIBackendAPI',
        'from services.openai_backend_api import (ImageContentPolicyError, ImagePollTimeoutError, ImageMissingReferenceError, OpenAIBackendAPI, is_missing_reference_image_message)');
      change('    last: dict[str, Any] = {}\n    for event in conversation_events(',
        '    last: dict[str, Any] = {}\n    missing_reference = False\n    for event in conversation_events(');
      change('        last = event\n        if event.get("type") == "conversation.delta":',
        '        last = event\n        raw = event.get("raw") or {}\n        if isinstance(raw, dict):\n            value = raw.get("v") or {}\n            message = raw.get("message") or (value.get("message") if isinstance(value, dict) else None)\n            if isinstance(message, dict) and is_missing_reference_image_message(message):\n                missing_reference = True\n        if event.get("type") == "conversation.delta":');
      change('    if message and not file_ids and not sediment_ids and last.get("blocked"):',
        '    if missing_reference and not file_ids and not sediment_ids:\n        raise ImageGenerationError(\n            "缺少参考图片，请上传原图后重试，或改用纯文生图提示词。",\n            status_code=400, error_type="invalid_request_error", code="missing_reference_image",\n            conversation_id=conversation_id,\n        )\n    if message and not file_ids and not sediment_ids and last.get("blocked"):');
      change('    except (ImageContentPolicyError, ImagePollTimeoutError) as exc:',
        '    except ImageMissingReferenceError as exc:\n        raise ImageGenerationError(\n            "缺少参考图片，请上传原图后重试，或改用纯文生图提示词。",\n            status_code=400, error_type="invalid_request_error", code="missing_reference_image",\n            conversation_id=conversation_id,\n        ) from exc\n    except (ImageContentPolicyError, ImagePollTimeoutError) as exc:');
      change('        except ImageContentPolicyError as exc:',
        '        except ImageMissingReferenceError as exc:\n            account_service.mark_image_result(token, False)\n            raise ImageGenerationError(\n                "缺少参考图片，请上传原图后重试，或改用纯文生图提示词。",\n                status_code=400, error_type="invalid_request_error", code="missing_reference_image",\n                account_email=account_email, conversation_id=exc.conversation_id,\n            ) from exc\n        except ImageContentPolicyError as exc:');
    }
    pending.push([filename,TAG+text]);
  }
  // Validate every anchor before replacing any source file.
  for(const [filename,text] of pending){
    const temporary=filename+'.dsh-image-errors-tmp';
    fs.writeFileSync(temporary,text,{mode:0o600});
    fs.renameSync(temporary,filename);
  }
  return {version:'image-errors-v1',files:pending.length,skipped:pending.length===0};
}

const CONTRACT_V1_TAG='# DSH_IMAGE_API_CONTRACT_PATCH image-api-contract-v1\n';
const CONTRACT_TAG='# DSH_IMAGE_API_CONTRACT_PATCH image-api-contract-v2\n';

export function installImageApiContractPatch(sourceRoot){
  const files=['services/protocol/openai_v1_image_edit.py','services/protocol/openai_v1_image_generations.py','services/protocol/conversation.py','api/image_inputs.py'];
  const pending=[];
  const emptyResult='        raise ImageGenerationError("上游未返回图片，请稍后重试。", status_code=502, code="empty_image_result")';
  for(const relative of files){
    const filename=path.join(sourceRoot,relative);
    let text=fs.readFileSync(filename,'utf8');
    if(text.includes(CONTRACT_TAG))continue;
    if(relative!=='api/image_inputs.py'&&text.includes(CONTRACT_V1_TAG)){
      pending.push([filename,replaceOnce(text,CONTRACT_V1_TAG,CONTRACT_TAG,relative)]);
      continue;
    }
    const change=(needle,replacement)=>{text=replaceOnce(text,needle,replacement,relative)};
    if(relative==='api/image_inputs.py'){
      change('        raise HTTPException(status_code=400, detail={"error": "image file or image_url is required"})',
        '        raise HTTPException(status_code=400, detail={"error": {\n            "message": "缺少参考图片，请上传原图后重试，或改用纯文生图提示词。",\n            "type": "invalid_request_error", "code": "missing_reference_image",\n        }})');
    }else if(relative.endsWith('/conversation.py')){
      // Chat shares the collector and deliberately allows text. Only image API
      // handlers opt in; their dedicated SSE formatter always requires a result.
      change('def collect_image_outputs(outputs: Iterable[ImageOutput]) -> dict[str, Any]:',
        'def collect_image_outputs(outputs: Iterable[ImageOutput], *, require_image: bool = False) -> dict[str, Any]:');
      change('    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}\n    if not data:',
        '    if require_image and not data:\n'+emptyResult+'\n    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}\n    if not data:');
      change('def stream_image_chunks(outputs: Iterable[ImageOutput]) -> Iterator[dict[str, Any]]:\n    for output in outputs:\n        yield output.to_chunk()',
        'def stream_image_chunks(outputs: Iterable[ImageOutput]) -> Iterator[dict[str, Any]]:\n    has_result = False\n    for output in outputs:\n        has_result = has_result or (output.kind == "result" and bool(output.data))\n        yield output.to_chunk()\n    if not has_result:\n'+emptyResult);
    }else{
      if(relative.endsWith('/openai_v1_image_edit.py')){
        change('        raise ImageGenerationError("image is required")',
          '        raise ImageGenerationError(\n            "缺少参考图片，请上传原图后重试，或改用纯文生图提示词。",\n            status_code=400, error_type="invalid_request_error", code="missing_reference_image",\n        )');
      }
      change('    result = collect_image_outputs(outputs)',
        '    result = collect_image_outputs(outputs, require_image=True)');
    }
    // Preserve the existing patch's leading tag so the full install order stays
    // idempotent when this contract is installed over an already patched tree.
    pending.push([filename,text.replace(/\n?$/,'\n')+CONTRACT_TAG]);
  }
  for(const [filename,text] of pending){
    const temporary=filename+'.dsh-image-contract-tmp';
    fs.writeFileSync(temporary,text,{mode:0o600});
    fs.renameSync(temporary,filename);
  }
  return {version:'image-api-contract-v2',files:pending.length,skipped:pending.length===0};
}
