"""DSH-managed ASGI entrypoint: apply saved defaults to third-party image API calls.

This wraps the pinned upstream app without modifying upstream source files.
Image defaults preserve explicit size and model. Public generation requests
also write bounded metadata records for the local management history.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from main import app as upstream_app

PRESET_SIZES = {
    "1:1": {"1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096"},
    "16:9": {"1k": "1920x1088", "2k": "2560x1440", "4k": "3840x2160"},
    "9:16": {"1k": "1088x1920", "2k": "1440x2560", "4k": "2160x3840"},
    "3:2": {"1k": "1536x1024", "2k": "2400x1600", "4k": "3600x2400"},
    "2:3": {"1k": "1024x1536", "2k": "1600x2400", "4k": "2400x3600"},
    "4:3": {"1k": "1365x1024", "2k": "2560x1920", "4k": "3840x2880"},
    "3:4": {"1k": "1024x1365", "2k": "1920x2560", "4k": "2880x3840"},
}
RATIO_RE = re.compile(
    r"(?:^|[^\d])(?:比例|画幅|aspect\s*ratio)?\s*"
    r"(1\s*:\s*1|16\s*:\s*9|9\s*:\s*16|3\s*:\s*2|2\s*:\s*3|4\s*:\s*3|3\s*:\s*4)(?!\d)",
    re.IGNORECASE,
)
MAX_BUFFER_BYTES = 72 * 1024 * 1024
MAX_ANALYSIS_BYTES = 1024 * 1024
MAX_EVENT_BYTES = 64 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
API_PATHS = {"/v1/chat/completions", "/v1/responses", "/v1/images/generations", "/v1/images/edits"}
RECORD_NAME = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json")


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ApiHistoryFiles:
    """Python owns these records; the management host only reads or removes them."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.ready = False
        self.records = {}

    def save(self, task):
        temporary = None
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.directory.is_symlink():
                return False
            temporary = self.directory / (str(uuid4()) + ".tmp")
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as output:
                json.dump(task, output, ensure_ascii=False, separators=(",", ":"))
            os.replace(temporary, self.directory / (task["id"] + ".json"))
            self.records[task["id"]] = (str(task.get("createdAt", "")), task.get("status"))
            return True
        except Exception:
            return False
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def prepare(self):
        if self.ready:
            self.prune()
            return
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.directory.is_symlink():
                return
            records = {}
            for filename in self.directory.iterdir():
                try:
                    if not RECORD_NAME.fullmatch(filename.name) or filename.is_symlink() or filename.stat().st_size > 128 * 1024:
                        continue
                    task = json.loads(filename.read_text(encoding="utf-8"))
                    if task.get("id") + ".json" != filename.name:
                        continue
                    if task.get("status") in ("queued", "running"):
                        task.update(status="interrupted", finishedAt=timestamp(), error="后端已重启，请核对原请求结果。")
                        self.save(task)
                    records[task["id"]] = (str(task.get("createdAt", "")), task.get("status"))
                except Exception:
                    continue
            self.records = records
            self.ready = True
            self.prune()
        except Exception:
            pass

    def prune(self):
        excess = len(self.records) - 1000
        if excess <= 0:
            return
        # The management host can delete completed records between requests.
        try:
            present = {filename.stem for filename in self.directory.iterdir() if RECORD_NAME.fullmatch(filename.name)}
            self.records = {task_id: meta for task_id, meta in self.records.items() if task_id in present}
        except OSError:
            return
        excess = len(self.records) - 1000
        for task_id, (_, status) in sorted(self.records.items(), key=lambda item: item[1][0]):
            if excess <= 0:
                break
            if status not in ("queued", "running"):
                try:
                    (self.directory / (task_id + ".json")).unlink(missing_ok=True)
                    self.records.pop(task_id, None)
                    excess -= 1
                except OSError:
                    pass


class ImageResults:
    def __init__(self, history_directory, server=None):
        self.root = Path(history_directory).parent
        self.directory = self.root / "task-files"
        self.server = server
        self.files = []
        self.digests = set()
        self.error = ""

    def add(self, encoded):
        if not isinstance(encoded, str):
            return
        try:
            if len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
                self.error = "图片结果超过单张32MB限制，未保存预览。"
                return
            data = base64.b64decode(encoded, validate=True)
            self.save_data(data)
        except (ValueError, TypeError):
            self.error = "图片结果编码无效，未保存预览。"

    def add_url(self, url):
        if not isinstance(url, str):
            return
        try:
            parsed = urlsplit(url)
            if parsed.netloc or parsed.scheme:
                loopback = ("127.0.0.1", "localhost", "::1")
                if (parsed.scheme != "http" or not self.server or self.server[0] not in loopback
                        or parsed.hostname not in loopback or parsed.port != self.server[1]):
                    raise ValueError("not this backend")
            path = unquote(parsed.path)
            if parsed.query or parsed.fragment or parsed.username or parsed.password or not path.startswith("/images/"):
                raise ValueError("invalid image URL")
            parts = path[len("/images/"):].split("/")
            if any(part in ("", ".", "..") or any(char in part for char in "\\:%\0") for part in parts):
                raise ValueError("unsafe image path")
            source_root = self.root / "source" / "data" / "images"
            candidate = self.root
            for part in ("source", "data", "images", *parts):
                candidate = candidate / part
                if candidate.is_symlink() or getattr(candidate, "is_junction", lambda: False)():
                    raise ValueError("linked image path")
            if not candidate.resolve(strict=True).is_relative_to(source_root.resolve(strict=True)):
                raise ValueError("outside image storage")
            info = candidate.lstat()
            with os.fdopen(os.open(candidate, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as source:
                opened = os.fstat(source.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_ino != info.st_ino or opened.st_size != info.st_size:
                    raise ValueError("changed image source")
                if opened.st_size > MAX_IMAGE_BYTES:
                    self.error = "图片结果超过单张32MB限制，未保存预览。"
                    return
                self.save_data(source.read(MAX_IMAGE_BYTES + 1))
        except ValueError:
            self.error = "图片链接不属于本机后端或路径不安全，未保存预览。"
        except OSError:
            self.error = "本机图片结果不存在或无法读取，未保存预览。"

    def save_data(self, data):
        try:
            if not data or len(data) > MAX_IMAGE_BYTES:
                self.error = "图片结果为空或超过单张32MB限制，未保存预览。"
                return
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                mime, extension = "image/png", ".png"
            elif data.startswith(b"\xff\xd8\xff"):
                mime, extension = "image/jpeg", ".jpg"
            elif len(data) >= 13 and data.startswith((b"GIF87a", b"GIF89a")):
                mime, extension = "image/gif", ".gif"
            elif len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
                mime, extension = "image/webp", ".webp"
            else:
                self.error = "图片结果格式无效，仅支持PNG、JPEG、WebP和GIF预览。"
                return
            digest = hashlib.sha256(data).digest()
            if digest in self.digests:
                return
            if len(self.files) >= 8:
                self.error = "图片结果超过8张，历史记录仅保存前8张预览。"
                return
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.directory.is_symlink() or getattr(self.directory, "is_junction", lambda: False)():
                raise OSError("unsafe image directory")
            descriptor = {"id": str(uuid4()), "mimeType": mime, "size": len(data), "role": "result"}
            filename = self.directory / (descriptor["id"] + extension)
            try:
                with filename.open("xb") as output:
                    os.chmod(filename, 0o600)
                    output.write(data)
            except OSError:
                filename.unlink(missing_ok=True)
                raise
            self.files.append(descriptor)
            self.digests.add(digest)
        except OSError:
            self.error = "图片结果无法保存到本机，请检查数据目录和磁盘空间。"


def text_input(value, depth=0) -> str:
    if depth > 8:
        return ""
    if isinstance(value, str):
        return value[:12000]
    if isinstance(value, list):
        parts = [text_input(item, depth + 1) for item in value[-80:]]
        return "\n".join(part for part in parts if part)[-12000:]
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"][:12000]
        return text_input(value.get("content"), depth + 1)
    return ""


def request_fields(body, content_type):
    try:
        if content_type.split(";", 1)[0].strip().lower() == "multipart/form-data":
            return multipart_fields(body, content_type)
        value = json.loads(body)
        return value if isinstance(value, dict) else {}
    except (ValueError, UnicodeDecodeError, RecursionError):
        return {}


def request_prompt(fields):
    if isinstance(fields.get("prompt"), str):
        return fields["prompt"][:12000]
    value = fields.get("input")
    if isinstance(value, str):
        return value[:12000]
    items = value if isinstance(value, list) else fields.get("messages")
    if isinstance(items, list):
        for item in reversed(items):
            if isinstance(item, str):
                return item[:12000]
            if not isinstance(item, dict) or item.get("role") not in (None, "user"):
                continue
            text = text_input(item)
            if text:
                return text
    return ""


def numeric_usage(value, depth=0):
    if not isinstance(value, dict) or depth > 2:
        return {}
    keys = {"input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens"}
    result = {key: item for key, item in value.items() if key in keys and type(item) in (int, float) and 0 <= item < 10**15}
    for key in ("input_tokens_details", "output_tokens_details", "prompt_tokens_details", "completion_tokens_details"):
        details = numeric_usage(value.get(key), depth + 1)
        if details:
            result[key] = details
    return result


PUBLIC_API_ERRORS = {
    "missing_reference_image": "缺少参考图片，请上传原图后重试，或改用纯文生图提示词。",
    "empty_image_result": "上游未返回图片，请稍后重试。",
    "content_policy_violation": "上游以内容安全策略拒绝了本次生成，请调整提示词。",
    "image_generation_timeout": "任务请求超时，请核对当前结果后再决定是否重试。",
    "request_timeout": "任务请求超时，请核对当前结果后再决定是否重试。",
    "insufficient_quota": "当前账号没有可用额度，请检查号池。",
    "quota_exceeded": "当前账号没有可用额度，请检查号池。",
    "rate_limit_exceeded": "上游请求被限流，请稍后重试。",
    "rate_limit_error": "上游请求被限流，请稍后重试。",
    "invalid_api_key": "接口认证失败，请检查 API 密钥。",
}


def public_api_error(value):
    # Never persist arbitrary upstream messages, even for recognized error codes.
    for _ in range(4):
        if not isinstance(value, dict):
            break
        for key in ("code", "type"):
            code = value.get(key)
            if isinstance(code, str) and code in PUBLIC_API_ERRORS:
                return PUBLIC_API_ERRORS[code]
        nested = value.get("error", value.get("detail"))
        if nested is None:
            break
        value = nested
    message = value if isinstance(value, str) else value.get("message", "") if isinstance(value, dict) else ""
    if not isinstance(message, str):
        return ""
    if (re.match(r"^(?:ChatGPT 生图超时（已等待 \d+(?:\.\d+)? 秒）|图片生成流已超过硬上限 \d+ 秒)", message)
            or message.strip().lower() == "upstream connection timed out, please retry later"):
        return PUBLIC_API_ERRORS["image_generation_timeout"]
    if message.strip().lower() in ("no available image quota", "quota exceeded"):
        return PUBLIC_API_ERRORS["insufficient_quota"]
    return ""


class ResponseSummary:
    def __init__(self, images=None, image_response=False):
        self.bytes = 0
        self.body = bytearray()
        self.sse = False
        self.pending = bytearray()
        self.dropping_line = False
        self.event = bytearray()
        self.event_overflow = False
        self.event_limit = MAX_EVENT_BYTES
        self.failed = False
        self.error = ""
        self.incomplete = False
        self.terminal = False
        self.usage = {}
        self.images = images
        self.body_limit = MAX_BUFFER_BYTES if image_response else MAX_ANALYSIS_BYTES

    def inspect(self, value, depth=0):
        if not isinstance(value, dict) or depth > 4:
            return
        if not self.error:
            self.error = public_api_error(value)
        if self.images and isinstance(value.get("data"), list):
            for item in value["data"]:
                if isinstance(item, dict):
                    if item.get("b64_json"):
                        self.images.add(item["b64_json"])
                    elif item.get("url"):
                        self.images.add_url(item["url"])
        if self.images and isinstance(value.get("output"), list):
            for item in value["output"]:
                self.inspect(item, depth + 1)
        event_type = value.get("type")
        response = value.get("response")
        if self.images:
            if event_type == "image_generation_call" and value.get("status") != "failed":
                self.images.add(value.get("result"))
            elif event_type == "response.output_item.done":
                self.inspect(value.get("item"), depth + 1)
            elif event_type in ("image_generation.completed", "image_edit.completed"):
                self.images.add(value.get("b64_json") or value.get("result"))
        if event_type in ("response.completed", "response.failed", "response.incomplete", "error", "response.error", "image_generation.completed", "image_edit.completed"):
            self.terminal = True
        if value.get("error") or value.get("status") == "failed" or event_type in ("error", "response.failed", "response.error"):
            self.failed = True
        if event_type == "response.incomplete" or value.get("status") == "incomplete":
            self.incomplete = True
        self.usage.update(numeric_usage(value.get("usage")))
        if isinstance(response, dict):
            self.inspect(response, depth + 1)

    def event_end(self):
        if self.event and not self.event_overflow:
            try:
                if bytes(self.event).strip() == b"[DONE]":
                    self.terminal = True
                else:
                    self.inspect(json.loads(self.event))
            except (ValueError, UnicodeDecodeError, RecursionError):
                pass
        self.event.clear()
        self.event_overflow = False
        self.event_limit = MAX_EVENT_BYTES

    def image_event(self, prefix):
        return self.images is not None and any(marker in prefix for marker in (
            b'"image_generation.completed"', b'"image_edit.completed"', b'"image_generation_call"',
            b'"image.generation.result"',
            b'event: image_generation.completed', b'event: image_edit.completed'))

    def chunk(self, chunk):
        self.bytes += len(chunk)
        if not self.sse:
            if self.body_limit == MAX_ANALYSIS_BYTES and self.image_event(bytes(self.body[:2048]) + chunk[:2048]):
                self.body_limit = MAX_BUFFER_BYTES
            if len(self.body) <= self.body_limit:
                self.body.extend(chunk[:self.body_limit + 1 - len(self.body)])
            return
        # Incremental line parsing keeps even a base64 image SSE event bounded.
        for part in chunk.splitlines(keepends=True):
            ends_line = part.endswith(b"\n")
            if self.event_limit == MAX_EVENT_BYTES and self.image_event(bytes(self.pending[:2048]) + part[:2048]):
                self.event_limit = MAX_BUFFER_BYTES
            if not self.dropping_line:
                if len(self.pending) + len(part) > self.event_limit:
                    self.pending.clear()
                    self.dropping_line = True
                    self.event_overflow = True
                    if self.images and self.event_limit == MAX_BUFFER_BYTES:
                        self.images.error = "图片流式结果超过72MB采集限制，未保存预览。"
                else:
                    self.pending.extend(part)
            if ends_line:
                if not self.dropping_line:
                    line = bytes(self.pending).rstrip(b"\r\n")
                    if not line:
                        self.event_end()
                    elif line.startswith(b"data:"):
                        payload = line[5:].lstrip(b" ")
                        if len(self.event) + len(payload) > self.event_limit:
                            self.event_overflow = True
                        elif not self.event_overflow:
                            self.event.extend(payload + b"\n")
                self.pending.clear()
                self.dropping_line = False

    def finish(self):
        if self.sse:
            self.event_end()
        elif len(self.body) <= self.body_limit:
            try:
                self.inspect(json.loads(self.body))
            except (ValueError, UnicodeDecodeError, RecursionError):
                pass
        elif self.images and self.body_limit == MAX_BUFFER_BYTES:
            self.images.error = "图片响应超过72MB采集限制，未保存预览。"


class RecordApiRequests:
    def __init__(self, app):
        self.app = app
        self.stores = {}
        directory = os.environ.get("DSH_API_HISTORY_DIR", "")
        if directory:
            self.stores[directory] = ApiHistoryFiles(directory)
            self.stores[directory].prepare()

    async def __call__(self, scope, receive, send):
        directory = os.environ.get("DSH_API_HISTORY_DIR", "")
        if not directory or scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") not in API_PATHS:
            return await self.app(scope, receive, send)
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        authorization = headers.get(b"authorization", b"").decode("latin1").split(None, 1)
        internal_key = os.environ.get("CHATGPT2API_AUTH_KEY", "")
        if internal_key and len(authorization) == 2 and authorization[0].lower() == "bearer" and authorization[1] == internal_key:
            return await self.app(scope, receive, send)
        store = self.stores.setdefault(directory, ApiHistoryFiles(directory))
        if not store.ready:
            store.prepare()
        now = timestamp()
        task = {"id": str(uuid4()), "type": "api_request", "summary": "POST " + scope["path"], "status": "running",
                "params": {"method": "POST", "path": scope["path"]}, "progress": {}, "result": None, "files": [],
                "createdAt": now, "startedAt": now, "finishedAt": None, "error": "", "parentTaskId": None}
        store.save(task)
        body = bytearray()
        input_overflow = False
        input_done = False
        disconnected = False
        completed = False
        raised = False
        http_status = 0
        image_response = scope["path"].startswith("/v1/images/")
        images = ImageResults(directory, scope.get("server")) if image_response or scope["path"] == "/v1/responses" else None
        summary = ResponseSummary(images, image_response)

        def safe_text(value, limit):
            for key in (internal_key, authorization[1] if len(authorization) == 2 else ""):
                if key:
                    value = value.replace(key, "[REDACTED]")
            value = re.sub(r"data:[^\s,]*;base64,[A-Za-z0-9+/=_-]+", "[图片数据已省略]", value, flags=re.IGNORECASE)
            return value[:limit]

        def capture_input():
            if input_overflow:
                return
            try:
                fields = request_fields(body, headers.get(b"content-type", b"").decode("latin1"))
                if summary.images and isinstance(fields.get("tools"), list) and any(isinstance(tool, dict) and tool.get("type") == "image_generation" for tool in fields["tools"]):
                    summary.body_limit = MAX_BUFFER_BYTES
                model = fields.get("model")
                if isinstance(model, str):
                    task["params"]["model"] = safe_text(model, 80)
                if type(fields.get("stream")) is bool:
                    task["params"]["stream"] = fields["stream"]
                prompt = safe_text(request_prompt(fields), 12000)
                if prompt:
                    task["params"]["prompt"] = prompt
                    task["summary"] = prompt[:100]
            except Exception:
                # Telemetry must never reject an otherwise valid API request.
                pass

        async def tracked_receive():
            nonlocal input_overflow, input_done, disconnected
            message = await receive()
            if message["type"] == "http.disconnect":
                disconnected = True
            if message["type"] == "http.request" and not input_done:
                chunk = message.get("body", b"")
                if len(body) + len(chunk) > MAX_ANALYSIS_BYTES:
                    input_overflow = True
                    body.clear()
                elif not input_overflow:
                    body.extend(chunk)
                if not message.get("more_body", False):
                    input_done = True
                    capture_input()
                    body.clear()
                    store.save(task)
            return message

        async def tracked_send(message):
            nonlocal http_status, completed
            # Forward first: history inspection never delays a streaming chunk.
            await send(message)
            if message["type"] == "http.response.start":
                http_status = message.get("status", 0)
                response_headers = {key.lower(): value for key, value in message.get("headers", [])}
                summary.sse = b"text/event-stream" in response_headers.get(b"content-type", b"").lower()
            elif message["type"] == "http.response.body":
                try:
                    summary.chunk(message.get("body", b""))
                except Exception:
                    pass
                if not message.get("more_body", False):
                    completed = True

        try:
            await self.app(scope, tracked_receive, tracked_send)
        except BaseException as error:
            raised = True
            if isinstance(error, (asyncio.CancelledError, OSError)):
                disconnected = True
            raise
        finally:
            try:
                summary.finish()
            except Exception:
                pass
            status = "succeeded"
            if disconnected and not completed:
                status = "interrupted"
            elif raised or summary.failed or not 200 <= http_status < 300:
                status = "failed"
            elif summary.incomplete or not completed or summary.sse and not summary.terminal:
                status = "interrupted"
            failure_reason = summary.error or (f"API 请求失败（HTTP {http_status}），请检查客户端响应。" if http_status >= 400 else "API 请求失败，请检查客户端响应。")
            task.update(status=status, finishedAt=timestamp(), result={"httpStatus": http_status, "responseBytes": summary.bytes},
                        error="请求已中断，结果未知；请核对客户端结果。" if status == "interrupted" else failure_reason if status == "failed" else "")
            if summary.usage:
                task["result"]["usage"] = summary.usage
            if summary.images:
                task["files"] = summary.images.files
                task["result"]["files"] = summary.images.files
                if summary.images.error:
                    task["result"]["imageError"] = summary.images.error
            store.save(task)
            store.prepare()


def preferences() -> dict[str, str]:
    defaults = {"defaultModel": "gpt-image-2", "defaultImageTier": "auto"}
    filename = os.environ.get("DSH_IMAGE_PREFERENCES_FILE", "")
    if not filename:
        return defaults
    try:
        doc = json.loads(Path(filename).read_text(encoding="utf-8"))
        model = doc.get("defaultModel")
        tier = doc.get("defaultImageTier")
        if isinstance(model, str) and re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", model):
            defaults["defaultModel"] = model
        if isinstance(tier, str) and tier.lower() in ("auto", "1k", "2k", "4k"):
            defaults["defaultImageTier"] = tier.lower()
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return defaults


def choose_size(fields: dict[str, Any], prefs: dict[str, str]) -> str | None:
    # 'size' is always authoritative, including auto.
    if fields.get("size") is not None and str(fields["size"]).strip():
        return None
    tier = str(fields.get("resolution") or fields.get("imageTier") or prefs["defaultImageTier"]).lower()
    if tier not in ("1k", "2k", "4k"):
        return None
    ratio = fields.get("aspect_ratio") or fields.get("aspectRatio") or ""
    ratio = str(ratio).strip()
    if not ratio:
        match = RATIO_RE.search(str(fields.get("prompt") or ""))
        ratio = re.sub(r"\s", "", match.group(1)) if match else ""
    return PRESET_SIZES.get(ratio, {}).get(tier)


def apply_json_defaults(body: bytes, prefs: dict[str, str]) -> bytes:
    try:
        fields = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(fields, dict):
        return body
    changed = False
    if not fields.get("model"):
        fields["model"] = prefs["defaultModel"]
        changed = True
    size = choose_size(fields, prefs)
    if size:
        fields["size"] = size
        changed = True
    return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if changed else body


def apply_responses_defaults(body: bytes, prefs: dict[str, str]) -> bytes:
    """Apply image tier to Responses API image_generation tool, never text requests."""
    try:
        fields = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(fields, dict) or not isinstance(fields.get("tools"), list):
        return body
    changed = False
    tools = []
    for item in fields["tools"]:
        if not isinstance(item, dict) or item.get("type") != "image_generation":
            tools.append(item)
            continue
        tool = dict(item)
        prompt_input = fields.get("input")
        if isinstance(prompt_input, str):
            prompt = prompt_input
        else:
            # Use the last text-bearing input; leave unrelated fields untouched.
            prompt = str(prompt_input or "")[:12000]
        ratio_fields = {"prompt": prompt, "aspect_ratio": fields.get("aspect_ratio"),
                        "resolution": tool.get("resolution") or fields.get("resolution"),
                        "size": tool.get("size")}
        new_size = choose_size(ratio_fields, prefs)
        if new_size:
            tool["size"] = new_size
            changed = True
        tools.append(tool)
    if changed:
        fields["tools"] = tools
        return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return body


def multipart_fields(body: bytes, content_type: str) -> dict[str, str]:
    match = re.search(r"(?:^|;)\s*boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.IGNORECASE)
    if not match:
        return {}
    boundary = (match.group(1) or match.group(2)).encode("ascii", "ignore")
    if not boundary or len(boundary) > 200:
        return {}
    marker = b"--" + boundary
    closing = marker + b"--"
    pos = body.rfind(closing)
    if pos < 0:
        return {}
    # Inspect form part headers only, never search binary image payloads.
    parts = body[:pos].split(marker)
    fields: dict[str, str] = {}
    for part in parts:
        if not part.startswith(b"\r\n"):
            continue
        head, sep, value = part[2:].partition(b"\r\n\r\n")
        if not sep or len(head) > 8192:
            continue
        found = re.search(rb'(?im)^Content-Disposition:\s*form-data;\s*name="([a-zA-Z_]+)"', head)
        if not found or b"filename=" in head.lower():
            continue
        name = found.group(1).decode("ascii")
        if name in ("prompt", "size", "model", "resolution", "imageTier", "aspect_ratio", "aspectRatio"):
            fields[name] = value.rstrip(b"\r\n").decode("utf-8", "replace")[:12000]
    return fields


def apply_multipart_defaults(body: bytes, content_type: str, prefs: dict[str, str]) -> bytes:
    match = re.search(r"(?:^|;)\s*boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.IGNORECASE)
    if not match:
        return body
    boundary = (match.group(1) or match.group(2)).encode("ascii", "ignore")
    if not boundary or len(boundary) > 200:
        return body
    marker = b"--" + boundary
    pos = body.rfind(marker + b"--")
    if pos < 0:
        return body
    fields = multipart_fields(body, content_type)
    additions = {}
    if not fields.get("model"):
        additions["model"] = prefs["defaultModel"]
    size = choose_size(fields, prefs)
    if size:
        additions["size"] = size
    if not additions:
        return body
    encoded = bytearray()
    for key, value in additions.items():
        encoded.extend(marker + b'\r\nContent-Disposition: form-data; name="' + key.encode() + b'"\r\n\r\n')
        encoded.extend(value.encode() + b"\r\n")
    return body[:pos] + bytes(encoded) + body[pos:]


class ApplyImagePreferences:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("method") == "GET" and scope.get("path") == "/dsh/pool-gif-status":
            from starlette.responses import JSONResponse
            response = JSONResponse({"enabled": True, "mode": "chatgpt_account_pool",
                                     "models": ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]})
            return await response(scope, receive, send)
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") not in (
            "/v1/images/generations", "/v1/images/edits", "/v1/responses"
        ):
            return await self.app(scope, receive, send)
        prefs = preferences()
        headers = list(scope.get("headers", []))
        content_type = next((v.decode("latin1") for k, v in headers if k.lower() == b"content-type"), "")
        is_json = content_type.split(";", 1)[0].strip().lower() == "application/json"
        is_form = content_type.split(";", 1)[0].strip().lower() == "multipart/form-data"
        if not is_json and not is_form:
            return await self.app(scope, receive, send)
        chunks = []
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > MAX_BUFFER_BYTES:
                payload = b'{"detail":{"error":"image upload exceeds 72MB limit"}}'
                await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]})
                await send({"type": "http.response.body", "body": payload})
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        original = b"".join(chunks)
        updated = (apply_responses_defaults(original, prefs) if scope["path"] == "/v1/responses"
                   else apply_json_defaults(original, prefs)) if is_json else apply_multipart_defaults(original, content_type, prefs)
        if updated != original:
            headers = [(k, v) for k, v in headers if k.lower() != b"content-length"]
            headers.append((b"content-length", str(len(updated)).encode()))
            scope = dict(scope, headers=headers)
        handed = False

        async def single_receive():
            nonlocal handed
            if not handed:
                handed = True
                return {"type": "http.request", "body": updated, "more_body": False}
            return await receive()

        await self.app(scope, single_receive, send)


app = RecordApiRequests(ApplyImagePreferences(upstream_app))
