"""Standalone tests: python3 -m unittest discover -s tests -p 'test_dsh_backend_entry.py'."""
import asyncio
import base64
import importlib.util
import json
import os
from pathlib import Path
import random
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zlib


fake_main = types.ModuleType("main")

async def upstream_app(scope, receive, send):
    chunks = []
    while True:
        item = await receive()
        if item["type"] == "http.request":
            chunks.append(item.get("body", b""))
            if not item.get("more_body", False):
                break
    data = b"".join(chunks)
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": data})

fake_main.app = upstream_app
sys.modules["main"] = fake_main
file_path = Path(__file__).resolve().parents[1] / "scripts" / "dsh_backend_entry.py"
spec = importlib.util.spec_from_file_location("dsh_backend_entry", file_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PREFS = {"defaultModel": "gpt-image-2", "defaultImageTier": "4k"}


def png_image(width=1, height=1, seed=0):
    generator = random.Random(seed)
    pixels = b"".join(b"\0" + generator.randbytes(width * 3) for _ in range(height))

    def png_chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack("!2I5B", width, height, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", zlib.compress(pixels)) + png_chunk(b"IEND", b""))


class ImageDefaultsTest(unittest.TestCase):
    def test_size_precedence_and_ratio(self):
        self.assertEqual(module.choose_size({"prompt": "一张16:9的风景"}, PREFS), "3840x2160")
        self.assertEqual(module.choose_size({"aspect_ratio": "9:16"}, PREFS), "2160x3840")
        self.assertIsNone(module.choose_size({"size": "1024x1024", "prompt": "16:9"}, PREFS))
        self.assertIsNone(module.choose_size({"prompt": "没有比例的风景"}, PREFS))

    def test_json_respects_size(self):
        body = b'{"prompt":"a 16:9 scene"}'
        result = json.loads(module.apply_json_defaults(body, PREFS))
        self.assertEqual(result["size"], "3840x2160")
        result = json.loads(module.apply_json_defaults(b'{"size":"auto","prompt":"16:9"}', PREFS))
        self.assertEqual(result["size"], "auto")

    def test_responses_image_tool(self):
        body = json.dumps({"input": "16:9 forest", "tools": [{"type": "image_generation"}]}).encode()
        result = json.loads(module.apply_responses_defaults(body, PREFS))
        self.assertEqual(result["tools"][0]["size"], "3840x2160")
        body = json.dumps({"input": "16:9 forest", "tools": [{"type": "web_search"}]}).encode()
        self.assertEqual(module.apply_responses_defaults(body, PREFS), body)

    def test_multipart_preserves_uploaded_image(self):
        boundary = "testBoundary"
        data = (b'--testBoundary\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n16:9 photo\r\n'
                b'--testBoundary\r\nContent-Disposition: form-data; name="image"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\n\x89PNGbytes\r\n'
                b'--testBoundary--\r\n')
        output = module.apply_multipart_defaults(data, "multipart/form-data; boundary=testBoundary", PREFS)
        self.assertIn(b"3840x2160", output)
        self.assertIn(b"\x89PNGbytes", output)
        explicit = data.replace(b'--testBoundary--', b'--testBoundary\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024\r\n--testBoundary--')
        explicit_result = module.apply_multipart_defaults(explicit, "multipart/form-data; boundary=testBoundary", PREFS)
        self.assertEqual(explicit_result.count(b'name="size"'), 1)
        self.assertIn(b"1024x1024", explicit_result)
        self.assertNotIn(b"3840x2160", explicit_result)
        self.assertIn(b"\x89PNGbytes", explicit_result)

    def test_asgi_wrapper_changes_external_json(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "image-preferences.json"
            filename.write_text(json.dumps(PREFS), encoding="utf-8")
            old = os.environ.get("DSH_IMAGE_PREFERENCES_FILE")
            os.environ["DSH_IMAGE_PREFERENCES_FILE"] = str(filename)
            try:
                async def simulate():
                    sent = []
                    received = False
                    async def receive():
                        nonlocal received
                        if not received:
                            received = True
                            return {"type": "http.request", "body": b'{"prompt":"16:9 landscape"}', "more_body": False}
                        return {"type": "http.disconnect"}
                    async def send(value):
                        sent.append(value)
                    await module.app({"type": "http", "method": "POST", "path": "/v1/images/generations",
                                      "headers": [(b"content-type", b"application/json")]}, receive, send)
                    return sent
                result = asyncio.run(simulate())
                self.assertEqual(json.loads(result[-1]["body"])["size"], "3840x2160")
            finally:
                if old is None:
                    os.environ.pop("DSH_IMAGE_PREFERENCES_FILE", None)
                else:
                    os.environ["DSH_IMAGE_PREFERENCES_FILE"] = old


class ApiHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "api-request-history"
        environment = patch.dict(os.environ, {"DSH_API_HISTORY_DIR": str(self.directory), "CHATGPT2API_AUTH_KEY": "internal-management-key"})
        environment.start()
        self.addCleanup(environment.stop)

    def records(self):
        return [json.loads(filename.read_text(encoding="utf-8")) for filename in self.directory.glob("*.json")]

    def invoke(self, application, body=b"{}", path="/v1/chat/completions", content_type="application/json", authorization="Bearer external-user-key", chunks=None, send_hook=None, server=None):
        async def simulate():
            queue = list(chunks or [{"type": "http.request", "body": body, "more_body": False}])
            sent = []

            async def receive():
                return queue.pop(0) if queue else {"type": "http.disconnect"}

            async def send(message):
                sent.append(message)
                if send_hook:
                    send_hook(message)

            await application({"type": "http", "method": "POST", "path": path,
                               "headers": [(b"content-type", content_type.encode()), (b"authorization", authorization.encode())], "server": server}, receive, send)
            return sent

        return asyncio.run(simulate())

    def response_app(self, payload=None, status=200):
        async def application(scope, receive, send):
            while (await receive()).get("more_body", False):
                pass
            self.assertTrue(any(task["status"] == "running" for task in self.records()))
            await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": json.dumps(payload or {"id": "completion-id"}).encode()})

        return module.RecordApiRequests(application)

    def test_success_records_all_public_generation_routes(self):
        application = self.response_app({"usage": {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}})
        for path in sorted(module.API_PATHS):
            self.invoke(application, json.dumps({"model": "auto", "prompt": "森林", "stream": False}).encode(), path=path)
        records = self.records()
        self.assertEqual(len(records), 4)
        self.assertEqual({item["params"]["path"] for item in records}, module.API_PATHS)
        for task in records:
            self.assertEqual(task["type"], "api_request")
            self.assertEqual(task["status"], "succeeded")
            self.assertEqual(task["params"]["prompt"], "森林")
            self.assertEqual(task["result"]["usage"]["total_tokens"], 15)
            self.assertEqual(task["result"]["httpStatus"], 200)
            self.assertEqual(task["files"], [])
            self.assertTrue(task["startedAt"].endswith("Z"))
            self.assertTrue(task["finishedAt"].endswith("Z"))

    def test_large_image_response_saves_preview_without_persisting_base64(self):
        image = png_image(997, 800)
        encoded = base64.b64encode(image).decode()
        payload = {"data": [{"b64_json": encoded}], "created": 1234}
        response = self.invoke(self.response_app(payload), b'{"prompt":"a landscape"}', path="/v1/images/generations")
        self.assertGreater(len(response[-1]["body"]), 3_000_000)
        task = self.records()[0]
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(len(task["files"]), 1)
        descriptor = task["files"][0]
        self.assertEqual(descriptor["mimeType"], "image/png")
        self.assertEqual(descriptor["size"], len(image))
        self.assertEqual(descriptor["role"], "result")
        self.assertEqual(task["result"]["files"], task["files"])
        self.assertEqual((self.directory.parent / "task-files" / (descriptor["id"] + ".png")).read_bytes(), image)
        saved = next(self.directory.glob("*.json")).read_text(encoding="utf-8")
        self.assertNotIn("b64_json", saved)
        self.assertNotIn(encoded[:100], saved)

    def test_responses_image_generation_result_saves_preview(self):
        image = png_image(700, 500)
        encoded = base64.b64encode(image).decode()
        payload = {"status": "completed", "output": [{"type": "image_generation_call", "id": "image-result", "status": "completed", "result": encoded}],
                   "usage": {"input_tokens": 10, "output_tokens": 100}}
        self.invoke(self.response_app(payload), b'{"input":"a tree","tools":[{"type":"image_generation"}]}', path="/v1/responses")
        task = self.records()[0]
        self.assertEqual(len(task["files"]), 1)
        self.assertEqual(task["result"]["usage"]["output_tokens"], 100)
        descriptor = task["files"][0]
        self.assertEqual((self.directory.parent / "task-files" / (descriptor["id"] + ".png")).read_bytes(), image)

    def test_image_stream_completion_saves_once_and_keeps_forwarding(self):
        image = png_image(160, 160)
        encoded = base64.b64encode(image).decode()
        item = {"type": "image_generation_call", "id": "image-result", "status": "completed", "result": encoded}
        events = [b'event: response.output_item.done\ndata: ' + json.dumps({"type": "response.output_item.done", "item": item}).encode() + b'\n\n',
                  b'event: response.completed\ndata: ' + json.dumps({"type": "response.completed", "response": {"status": "completed", "output": [item], "usage": {"output_tokens": 101}}}).encode() + b'\n\n']
        forwarded = []

        async def application(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            for event in events:
                for position in range(0, len(event), 7919):
                    chunk = event[position:position + 7919]
                    await send({"type": "http.response.body", "body": chunk, "more_body": True})
                    self.assertEqual(forwarded[-1]["body"], chunk)
            await send({"type": "http.response.body", "body": b""})

        self.invoke(module.RecordApiRequests(application), b'{"input":"a tree","tools":[{"type":"image_generation"}],"stream":true}',
                    path="/v1/responses", send_hook=forwarded.append)
        task = self.records()[0]
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(len(task["files"]), 1)
        self.assertEqual(len(list((self.directory.parent / "task-files").iterdir())), 1)
        self.assertEqual(task["result"]["usage"]["output_tokens"], 101)

    def test_actual_image_api_stream_object_saves_large_image(self):
        image = png_image(700, 500)
        encoded = base64.b64encode(image).decode()
        event = b'data: ' + json.dumps({"id": "image-stream", "object": "image.generation.result", "data": [{"b64_json": encoded}]}).encode() + b'\n\n'

        async def application(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            for position in range(0, len(event), 32771):
                await send({"type": "http.response.body", "body": event[position:position + 32771], "more_body": True})
            await send({"type": "http.response.body", "body": b'data: [DONE]\n\n'})

        self.invoke(module.RecordApiRequests(application), b'{"prompt":"a tree","stream":true}', path="/v1/images/generations")
        task = self.records()[0]
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(len(task["files"]), 1)
        self.assertEqual(task["files"][0]["size"], len(image))

    def test_url_only_results_copy_fixed_local_images_without_network(self):
        image = png_image()
        source = self.directory.parent / "source" / "data" / "images" / "2026" / "11" / "06" / "result.png"
        source.parent.mkdir(parents=True)
        source.write_bytes(image)
        for url in ("/images/2026/11/06/result.png", "http://127.0.0.1:38650/images/2026/11/06/result.png", "http://localhost:38650/images/2026/11/06/result.png"):
            self.invoke(self.response_app({"data": [{"url": url}]}), path="/v1/images/edits", server=("127.0.0.1", 38650))
        records = self.records()
        self.assertEqual(len(records), 3)
        for task in records:
            self.assertEqual(len(task["files"]), 1)
            self.assertEqual(task["status"], "succeeded")
            self.assertNotIn("imageError", task["result"])
            descriptor = task["files"][0]
            self.assertEqual((self.directory.parent / "task-files" / (descriptor["id"] + ".png")).read_bytes(), image)

    def test_unsafe_remote_or_traversal_image_urls_never_save_files(self):
        source_root = self.directory.parent / "source" / "data" / "images"
        source_root.mkdir(parents=True)
        (source_root / "result.png").write_bytes(png_image())
        urls = ["https://example.test/images/result.png", "http://127.0.0.1:38651/images/result.png", "//example.test/images/result.png",
                "/images/../result.png", "/images/%2e%2e/result.png", "/images/%252e%252e/result.png", "/images/..%5cresult.png",
                "http://user:secret@127.0.0.1:38650/images/result.png", "/images/result.png?path=private", "/other/result.png"]
        for url in urls:
            self.invoke(self.response_app({"data": [{"url": url}]}), path="/v1/images/generations", server=("127.0.0.1", 38650))
        for task in self.records():
            self.assertEqual(task["status"], "succeeded")
            self.assertEqual(task["files"], [])
            self.assertIn("imageError", task["result"])
        self.assertFalse((self.directory.parent / "task-files").exists())

    def test_linked_source_and_output_directories_do_not_save_images(self):
        outside = self.directory.parent / "outside.png"
        outside.write_bytes(png_image())
        source = self.directory.parent / "source" / "data" / "images"
        source.mkdir(parents=True)
        try:
            (source / "linked.png").symlink_to(outside)
        except OSError:
            self.skipTest("OS does not allow symbolic links")
        self.invoke(self.response_app({"data": [{"url": "/images/linked.png"}]}), path="/v1/images/generations")
        target = self.directory.parent / "outside-results"
        target.mkdir()
        (self.directory.parent / "task-files").symlink_to(target, target_is_directory=True)
        self.invoke(self.response_app({"data": [{"b64_json": base64.b64encode(png_image()).decode()}]}), path="/v1/images/generations")
        self.assertTrue(all(task["status"] == "succeeded" and task["files"] == [] and "imageError" in task["result"] for task in self.records()))
        self.assertEqual(list(target.iterdir()), [])

    def test_image_capture_stops_at_72mb_without_changing_response(self):
        payload = b" " * (72 * 1024 * 1024 + 1)

        async def application(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": payload})

        response = self.invoke(module.RecordApiRequests(application), path="/v1/images/generations")
        self.assertIs(response[-1]["body"], payload)
        task = self.records()[0]
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(task["result"]["responseBytes"], len(payload))
        self.assertIn("72MB", task["result"]["imageError"])
        self.assertEqual(task["files"], [])

    def test_invalid_image_and_unwritable_output_keep_api_success(self):
        self.invoke(self.response_app({"data": [{"b64_json": base64.b64encode(b"not an image").decode()}]}), path="/v1/images/generations")
        task = self.records()[0]
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(task["files"], [])
        self.assertIn("格式无效", task["result"]["imageError"])
        (self.directory.parent / "task-files").write_text("blocked", encoding="utf-8")
        self.invoke(self.response_app({"data": [{"b64_json": base64.b64encode(png_image()).decode()}]}), path="/v1/images/edits")
        self.assertTrue(all(task["status"] == "succeeded" and task["files"] == [] and "imageError" in task["result"] for task in self.records()))
        self.assertTrue(any("无法保存" in task["result"]["imageError"] for task in self.records()))

    def test_image_count_and_decoded_byte_limits_keep_api_success(self):
        payload = {"data": [{"b64_json": base64.b64encode(png_image(seed=index)).decode()} for index in range(9)]}
        self.invoke(self.response_app(payload), path="/v1/images/generations")
        task = self.records()[0]
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(len(task["files"]), 8)
        self.assertIn("8张", task["result"]["imageError"])
        image = b"\x89PNG\r\n\x1a\n" + b"\0" * (32 * 1024 * 1024 - 7)
        self.invoke(self.response_app({"data": [{"b64_json": base64.b64encode(image).decode()}]}), path="/v1/images/generations")
        too_large = next(task for task in self.records() if not task["files"])
        self.assertEqual(too_large["status"], "succeeded")
        self.assertIn("32MB", too_large["result"]["imageError"])
        self.assertEqual(len(list((self.directory.parent / "task-files").iterdir())), 8)

    def test_supported_image_formats_and_plain_text_capture(self):
        images = [(png_image(), "image/png", ".png"), (b"\xff\xd8\xffJPEG", "image/jpeg", ".jpg"),
                  (b"RIFF\x04\0\0\0WEBP", "image/webp", ".webp"), (b"GIF89a\x01\0\x01\0\0\0\0", "image/gif", ".gif")]
        self.invoke(self.response_app({"data": [{"b64_json": base64.b64encode(image).decode()} for image, _, _ in images]}), path="/v1/images/edits")
        task = self.records()[0]
        self.assertEqual({file["mimeType"] for file in task["files"]}, {mime for _, mime, _ in images})
        for file, (image, _, extension) in zip(task["files"], images):
            self.assertEqual((self.directory.parent / "task-files" / (file["id"] + extension)).read_bytes(), image)
        before = set((self.directory.parent / "task-files").iterdir())
        self.invoke(self.response_app({"output": [{"type": "message", "content": "text " * 250000}]}), path="/v1/responses")
        text_task = next(task for task in self.records() if not task["files"])
        self.assertEqual(text_task["status"], "succeeded")
        self.assertNotIn("imageError", text_task["result"])
        self.assertEqual(set((self.directory.parent / "task-files").iterdir()), before)

    def test_http_failure_never_saves_error_response_or_credentials(self):
        application = self.response_app({"error": {"message": "private-response-secret"}}, status=401)
        self.invoke(application, json.dumps({"model": "external-user-key", "messages": [
            {"role": "system", "content": "private-system-instruction"},
            {"role": "user", "content": [{"type": "text", "text": "draw external-user-key data:image/png;base64,QUJDREVGRw=="},
                                           {"type": "image_url", "image_url": {"url": "data:image/png;base64,aW1hZ2Utc2VjcmV0"}}]}],
            "access_token": "private-body-secret", "images": [{"b64_json": "private-image-data"}]}).encode())
        task = self.records()[0]
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["result"]["httpStatus"], 401)
        encoded = json.dumps(task)
        for secret in ("external-user-key", "private-response-secret", "private-body-secret", "private-image-data", "private-system-instruction", "QUJDREVGRw", "aW1hZ2Utc2VjcmV0", "base64"):
            self.assertNotIn(secret, encoded)
        self.assertEqual(task["params"]["model"], "[REDACTED]")
        self.assertIn("[图片数据已省略]", task["params"]["prompt"])

    def test_multipart_captures_text_without_image_upload(self):
        body = (b'--history-boundary\r\nContent-Disposition: form-data; name="prompt"\r\n\r\npaint a lake\r\n'
                b'--history-boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n'
                b'--history-boundary\r\nContent-Disposition: form-data; name="image"; filename="private-file.png"\r\n\r\nprivate-image-binary\r\n'
                b'--history-boundary--\r\n')
        self.invoke(self.response_app(), body, path="/v1/images/edits", content_type="multipart/form-data; boundary=history-boundary")
        task = self.records()[0]
        self.assertEqual(task["params"]["prompt"], "paint a lake")
        self.assertNotIn("private-", json.dumps(task))

    def test_stream_chunks_forward_immediately_and_capture_numeric_usage(self):
        chunks = [b'data: {"choices":[{"delta":{"content":"private-answer"}}]}\n\n',
                  b'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"password":"private-secret"}}\n\n',
                  b'data: [DONE]\n\n']
        forwarded = []

        async def application(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            for chunk in chunks:
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
                self.assertEqual(forwarded[-1]["body"], chunk)
                self.assertEqual(self.records()[0]["status"], "running")
            await send({"type": "http.response.body", "body": b""})

        result = self.invoke(module.RecordApiRequests(application), b'{"messages":[{"role":"user","content":"hello"}],"stream":true}', send_hook=forwarded.append)
        self.assertEqual(b"".join(item.get("body", b"") for item in result), b"".join(chunks))
        task = self.records()[0]
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(task["result"]["usage"], {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6})
        self.assertNotIn("private-", json.dumps(task))

    def test_split_and_oversized_stream_events_still_detect_later_failure(self):
        chunks = [b'data: {"result":"' + b"x" * (module.MAX_EVENT_BYTES + 1), b'"}\n\n',
                  b'data: {"type":"respon', b'se.failed","response":{"error":{"message":"private-error"},"usage":{"output_tokens":7}}}\r\n\r\n']

        async def application(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            for chunk in chunks:
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b""})

        self.invoke(module.RecordApiRequests(application), path="/v1/responses")
        task = self.records()[0]
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["result"]["usage"], {"output_tokens": 7})
        self.assertNotIn("private-error", json.dumps(task))

    def test_responses_capture_only_latest_user_text_and_failed_status(self):
        body = json.dumps({"input": [{"role": "user", "content": "old private question"},
                                      {"role": "assistant", "content": "old private answer"},
                                      {"role": "user", "content": [{"type": "input_text", "text": "latest question"}]}]}).encode()
        self.invoke(self.response_app({"status": "failed"}), body, path="/v1/responses")
        task = self.records()[0]
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["params"]["prompt"], "latest question")
        self.assertNotIn("old private", json.dumps(task))

    def test_stream_without_terminal_event_marks_unknown_result(self):
        async def application(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            await send({"type": "http.response.body", "body": b'data: {"choices":[]}\n\n'})

        self.invoke(module.RecordApiRequests(application))
        self.assertEqual(self.records()[0]["status"], "interrupted")

    def test_disconnect_and_cancellation_mark_unknown_result(self):
        async def application(scope, receive, send):
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"partial", "more_body": True})
            await receive()

        self.invoke(module.RecordApiRequests(application))
        self.assertEqual(self.records()[0]["status"], "interrupted")

        async def cancelled(scope, receive, send):
            raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            self.invoke(module.RecordApiRequests(cancelled))
        self.assertEqual({task["status"] for task in self.records()}, {"interrupted"})

    def test_upstream_exception_is_propagated_without_saving_its_text(self):
        async def application(scope, receive, send):
            raise RuntimeError("private-upstream-exception")

        with self.assertRaisesRegex(RuntimeError, "private-upstream-exception"):
            self.invoke(module.RecordApiRequests(application))
        self.assertEqual(self.records()[0]["status"], "failed")
        self.assertNotIn("private-upstream-exception", json.dumps(self.records()))

    def test_internal_requests_and_disabled_capture_pass_through(self):
        application = module.RecordApiRequests(upstream_app)
        body = b'{"prompt":"pass through unchanged"}'
        result = self.invoke(application, body, authorization="Bearer internal-management-key")
        self.assertEqual(result[-1]["body"], body)
        self.assertEqual(self.records(), [])
        with patch.dict(os.environ, {"DSH_API_HISTORY_DIR": ""}):
            result = self.invoke(application, body)
        self.assertEqual(result[-1]["body"], body)
        self.assertEqual(self.records(), [])
        self.invoke(application, body, path="/v1/not-recorded")
        self.assertEqual(self.records(), [])

    def test_invalid_large_and_chunked_requests_are_transparent(self):
        application = module.RecordApiRequests(upstream_app)
        for body in (b'{invalid-json', b'{"prompt":"' + b"x" * (module.MAX_ANALYSIS_BYTES + 1) + b'"}'):
            result = self.invoke(application, chunks=[{"type": "http.request", "body": body[:17], "more_body": True},
                                                      {"type": "http.request", "body": body[17:], "more_body": False}])
            self.assertEqual(result[-1]["body"], body)
        self.assertTrue(all("prompt" not in task["params"] for task in self.records()))
        body = json.dumps({"prompt": "long" * 5000, "model": "m" * 1000}).encode()
        self.invoke(application, body)
        task = next(task for task in self.records() if "prompt" in task["params"])
        self.assertEqual(len(task["params"]["prompt"]), 12000)
        self.assertEqual(len(task["params"]["model"]), 80)
        self.assertLessEqual(len(task["summary"]), 300)

    def test_recovery_happens_at_wrapper_startup_and_retention_preserves_active(self):
        store = module.ApiHistoryFiles(self.directory)
        task = {"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "createdAt": "2026-01-01T00:00:00.000Z", "status": "running"}
        store.save(task)
        module.RecordApiRequests(upstream_app)
        recovered = self.records()[0]
        self.assertEqual(recovered["status"], "interrupted")
        self.assertTrue(recovered["finishedAt"])
        store.ready = True
        active_id = str(module.uuid4())
        store.save({"id": active_id, "createdAt": "2025-01-01T00:00:00.000Z", "status": "running"})
        for index in range(1000):
            store.save({"id": str(module.uuid4()), "createdAt": f"2026-01-02T00:{index // 60:02}:{index % 60:02}.000Z", "status": "succeeded"})
        store.prepare()
        records = self.records()
        self.assertEqual(len(records), 1000)
        self.assertEqual(next(task for task in records if task["id"] == active_id)["status"], "running")
        with patch.object(Path, "read_text", side_effect=AssertionError("warm retention must not read JSON")):
            store.prepare()
        for task in [task for task in records if task["status"] == "succeeded"][:500]:
            (self.directory / (task["id"] + ".json")).unlink()
        survivors = {filename.stem for filename in self.directory.glob("*.json")}
        extra_id = str(module.uuid4())
        store.save({"id": extra_id, "createdAt": "2026-01-03T00:00:00.000Z", "status": "succeeded"})
        store.prepare()
        self.assertEqual({filename.stem for filename in self.directory.glob("*.json")}, survivors | {extra_id})

    def test_analysis_failure_does_not_change_the_original_request(self):
        with patch.object(module, "request_fields", side_effect=RuntimeError("metadata-only failure")):
            result = self.invoke(module.RecordApiRequests(upstream_app), b'{"prompt":"hello"}')
        self.assertEqual(result[-1]["body"], b'{"prompt":"hello"}')
        self.assertEqual(self.records()[0]["status"], "succeeded")

    def test_unwritable_record_location_does_not_break_api(self):
        blocked = Path(self.temporary.name) / "not-a-directory"
        blocked.write_text("blocked", encoding="utf-8")
        with patch.dict(os.environ, {"DSH_API_HISTORY_DIR": str(blocked)}):
            result = self.invoke(module.RecordApiRequests(upstream_app), b'{"prompt":"hello"}')
        self.assertEqual(result[-1]["body"], b'{"prompt":"hello"}')


if __name__ == "__main__":
    unittest.main()
