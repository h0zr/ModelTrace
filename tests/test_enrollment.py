from __future__ import annotations

import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from app import app
from enrollment import completion_url, request_completion


def responses_payload(text: str = "123, 234") -> dict:
    return {
        "object": "response",
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "999"}]},
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            },
        ],
    }


def json_response(payload: dict) -> io.BytesIO:
    return io.BytesIO(json.dumps(payload).encode("utf-8"))


class CompletionProtocolTests(unittest.TestCase):
    def test_endpoint_paths_preserve_prefix_and_query(self):
        cases = [
            ("https://example.test", "responses", "https://example.test/v1/responses"),
            ("https://example.test/v1/", "responses", "https://example.test/v1/responses"),
            ("https://example.test/proxy/v1", "responses", "https://example.test/proxy/v1/responses"),
            (
                "https://example.test/proxy/v1/responses/?api-version=preview",
                "responses",
                "https://example.test/proxy/v1/responses?api-version=preview",
            ),
            (
                "https://example.test/v1/chat/completions?api-version=preview",
                "responses",
                "https://example.test/v1/responses?api-version=preview",
            ),
            ("https://example.test/v1/responses", "anthropic", "https://example.test/v1/messages"),
            ("https://example.test/v1/messages", "openai", "https://example.test/v1/chat/completions"),
            ("https://example.test/responses", "responses", "https://example.test/responses"),
        ]
        for base, protocol, expected in cases:
            with self.subTest(base=base, protocol=protocol):
                self.assertEqual(completion_url(base, protocol), expected)

    def test_responses_request_carries_prompt_instructions_and_temperature(self):
        for temperature in (None, 0.0, 0.7):
            with self.subTest(temperature=temperature):
                with patch("enrollment.urllib.request.urlopen", return_value=json_response(responses_payload())) as send:
                    text = request_completion(
                        "https://example.test/v1", "dummy-key", "test-model", "数字挑战", temperature,
                        api_format="responses", system_prompt="只输出整数",
                    )
                request = send.call_args.args[0]
                body = json.loads(request.data)
                self.assertEqual(request.full_url, "https://example.test/v1/responses")
                self.assertEqual(request.get_method(), "POST")
                self.assertEqual(request.get_header("Authorization"), "Bearer dummy-key")
                self.assertEqual(body["model"], "test-model")
                self.assertEqual(body["input"], "数字挑战")
                self.assertEqual(body["instructions"], "只输出整数")
                self.assertFalse(body["stream"])
                self.assertFalse(body["store"])
                self.assertNotIn("messages", body)
                if temperature is None:
                    self.assertNotIn("temperature", body)
                else:
                    self.assertEqual(body["temperature"], temperature)
                self.assertEqual(text, "123, 234")

    def test_responses_collects_message_text_and_excludes_reasoning(self):
        payload = responses_payload("123, ")
        payload["output"][1]["content"].append({"type": "output_text", "text": "234, "})
        payload["output"].append({
            "type": "message", "status": "completed", "role": "assistant",
            "content": [{"type": "output_text", "text": "345"}],
        })
        with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)):
            text = request_completion("https://example.test", "dummy", "demo", "prompt", None, "responses")
        self.assertEqual(text, "123, 234, 345")

    def test_responses_rejects_unfinished_or_failed_output(self):
        for status in ("incomplete", "failed", "cancelled", "queued", "in_progress"):
            with self.subTest(status=status):
                payload = responses_payload()
                payload["status"] = status
                payload["incomplete_details"] = {"reason": "max_output_tokens"}
                with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)):
                    with self.assertRaisesRegex(RuntimeError, status):
                        request_completion("https://example.test", "dummy", "demo", "prompt", None, "responses")

    def test_responses_rejects_refusal_even_with_partial_text(self):
        payload = responses_payload()
        payload["output"][1]["content"].append({"type": "refusal", "refusal": "Cannot comply"})
        with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)):
            with self.assertRaisesRegex(RuntimeError, "拒绝"):
                request_completion("https://example.test", "dummy", "demo", "prompt", None, "responses")

    def test_responses_rejects_incomplete_message(self):
        payload = responses_payload()
        payload["output"][1]["status"] = "incomplete"
        with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)):
            with self.assertRaisesRegex(RuntimeError, "消息未正常完成"):
                request_completion("https://example.test", "dummy", "demo", "prompt", None, "responses")

    def test_responses_rejects_missing_malformed_or_empty_text(self):
        payloads = [
            {}, {"output": None}, {"output": []}, {"output": [None]},
            {"output": [{"type": "reasoning", "summary": []}]},
            {"output": [{"type": "message", "content": None}]},
            {"output": [{"type": "message", "content": [None]}]},
            {"output": [{"type": "message", "content": [{"type": "output_text", "text": None}]}]},
            responses_payload(" "),
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)):
                    with self.assertRaises(RuntimeError):
                        request_completion("https://example.test", "dummy", "demo", "prompt", None, "responses")

    def test_explicit_responses_endpoint_is_tried_first(self):
        with patch("enrollment.urllib.request.urlopen", return_value=json_response(responses_payload())) as send:
            text = request_completion("https://example.test/v1/responses?route=test", "dummy", "demo", "prompt", None)
        self.assertEqual(text, "123, 234")
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0].full_url, "https://example.test/v1/responses?route=test")

    def test_auto_tries_responses_when_chat_endpoint_is_unavailable(self):
        urls = []

        def upstream(request, **kwargs):
            urls.append(request.full_url)
            if request.full_url.endswith("/chat/completions"):
                raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b"not found"))
            return json_response(responses_payload())

        with patch("enrollment.urllib.request.urlopen", side_effect=upstream):
            text = request_completion("https://example.test/v1", "dummy", "demo", "prompt", None)
        self.assertEqual(text, "123, 234")
        self.assertEqual(urls, ["https://example.test/v1/chat/completions", "https://example.test/v1/responses"])

    def test_auto_reaches_responses_after_invalid_chat_responses(self):
        bodies = [
            b"not JSON", b"\xff", b"[]", b'{"choices":[]}',
            b'{"choices":[{"message":{"content":null},"finish_reason":"stop"}]}',
            b'{"error":{"message":"Use Responses"}}',
            json.dumps(responses_payload()).encode(),
        ]
        for raw in bodies:
            with self.subTest(raw=raw):
                with patch("enrollment.urllib.request.urlopen", side_effect=[io.BytesIO(raw), json_response(responses_payload())]) as send:
                    text = request_completion("https://example.test/v1", "dummy", "demo", "prompt", None)
                self.assertEqual(text, "123, 234")
                self.assertEqual(send.call_count, 2)
                self.assertTrue(send.call_args.args[0].full_url.endswith("/responses"))

    def test_legacy_chat_and_messages_still_parse_text(self):
        cases = [
            ("openai", {"choices": [{"message": {"content": [{"type": "text", "text": "123, 234"}]}, "finish_reason": "stop"}]}),
            ("anthropic", {"content": [{"type": "thinking", "thinking": "999"}, {"type": "text", "text": "123, 234"}], "stop_reason": "end_turn"}),
        ]
        for protocol, payload in cases:
            with self.subTest(protocol=protocol):
                with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)) as send:
                    text = request_completion("https://example.test/v1", "dummy", "demo", "prompt", None, protocol, "system")
                body = json.loads(send.call_args.args[0].data)
                if protocol == "openai":
                    self.assertEqual(body["messages"][0], {"role": "system", "content": "system"})
                else:
                    self.assertEqual(body["system"], "system")
                    self.assertEqual(body["max_tokens"], 4096)
                self.assertEqual(text, "123, 234")

    def test_messages_remains_a_fallback(self):
        payload = {"content": [{"type": "text", "text": "123, 234"}], "stop_reason": "end_turn"}
        with patch("enrollment.urllib.request.urlopen", side_effect=[
            io.BytesIO(b"not JSON"), json_response({"output": []}), json_response(payload),
        ]) as send:
            self.assertEqual(request_completion("https://example.test", "dummy", "demo", "prompt", None), "123, 234")
        self.assertEqual(send.call_count, 3)
        self.assertTrue(send.call_args.args[0].full_url.endswith("/messages"))

    def test_responses_reuses_http_retry_handling(self):
        endpoint = "https://example.test/v1/responses"
        error = urllib.error.HTTPError(endpoint, 503, "Unavailable", {}, io.BytesIO(b"temporarily unavailable"))
        with patch("enrollment.time.sleep"), patch("enrollment.urllib.request.urlopen", side_effect=[
            error, json_response(responses_payload()),
        ]) as send:
            text = request_completion(endpoint, "dummy", "demo", "prompt", None)
        self.assertEqual(text, "123, 234")
        self.assertEqual(send.call_count, 2)
        self.assertTrue(all(call.args[0].full_url == endpoint for call in send.call_args_list))

    def test_unknown_protocol_fails_before_sending_request(self):
        with patch("enrollment.urllib.request.urlopen") as send:
            with self.assertRaises(ValueError):
                request_completion("https://example.test", "dummy", "demo", "prompt", None, "unknown")
        send.assert_not_called()

    def test_web_probe_accepts_responses_output(self):
        numbers = " ".join(str(number) for number in range(1, 121))
        with patch("enrollment.urllib.request.urlopen", return_value=json_response(responses_payload(numbers))) as send:
            response = app.test_client().post("/api/test/probe", json={
                "api_format": "responses", "base_url": "https://example.test/v1", "api_key": "dummy", "api_model": "demo",
                "prompt": "Generate 120 integers", "expected_count": 120,
            })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["accepted"])
        self.assertEqual(response.json["parsed_numbers"], 120)
        self.assertEqual(response.json["text"], numbers)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0].full_url, "https://example.test/v1/responses")


class ProtocolSelectionTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.numbers = " ".join(str(number) for number in range(1, 121))
        self.configuration = {
            "base_url": "https://example.test", "api_key": "dummy", "api_model": "demo",
            "prompt": "Generate 120 integers", "expected_count": 120,
            "model_label": "demo", "sample_count": 3,
        }

    def test_probe_calls_only_the_selected_protocol(self):
        cases = [
            ("openai", "/v1/chat/completions", {"choices": [{"message": {"content": self.numbers}, "finish_reason": "stop"}]}),
            ("responses", "/v1/responses", responses_payload(self.numbers)),
            ("anthropic", "/v1/messages", {"content": [{"type": "text", "text": self.numbers}], "stop_reason": "end_turn"}),
        ]
        for protocol, endpoint, payload in cases:
            with self.subTest(protocol=protocol):
                with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)) as send:
                    response = self.client.post("/api/test/probe", json={**self.configuration, "api_format": protocol})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json["accepted"])
                self.assertEqual(send.call_count, 1)
                self.assertEqual(send.call_args.args[0].full_url, "https://example.test" + endpoint)

    def test_selection_failure_does_not_switch_protocols(self):
        endpoint = "https://example.test/v1/responses"
        error = urllib.error.HTTPError(endpoint, 404, "Not Found", {}, io.BytesIO(b"not found"))
        with patch("enrollment.urllib.request.urlopen", side_effect=error) as send:
            response = self.client.post("/api/test/probe", json={**self.configuration, "api_format": "responses"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0].full_url, endpoint)

    def test_invalid_protocol_is_rejected_before_any_upstream_request(self):
        for route in ("/api/test/probe", "/api/test/auto", "/api/enroll/auto"):
            for protocol in ("unknown", "auto", None, ["responses"]):
                with self.subTest(route=route, protocol=protocol):
                    with patch("enrollment.urllib.request.urlopen") as send:
                        response = self.client.post(route, json={**self.configuration, "api_format": protocol})
                    self.assertEqual(response.status_code, 400)
                    self.assertIn("接口协议", response.json["error"])
                    send.assert_not_called()

    def test_missing_protocol_defaults_to_chat_completions(self):
        payload = {"choices": [{"message": {"content": self.numbers}, "finish_reason": "stop"}]}
        with patch("enrollment.urllib.request.urlopen", return_value=json_response(payload)) as send:
            response = self.client.post("/api/test/probe", json=self.configuration)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0].full_url, "https://example.test/v1/chat/completions")

    def test_batch_test_receives_selected_protocol(self):
        with patch("app.test_automatic", return_value={}) as run:
            response = self.client.post("/api/test/auto", json={**self.configuration, "api_format": "responses"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(run.call_args.kwargs["api_format"], "responses")

    def test_enrollment_receives_selected_protocol(self):
        with patch("app.enroll_automatic", return_value={}) as enroll, patch("app.replace_bank"):
            response = self.client.post("/api/enroll/auto", json={**self.configuration, "api_format": "anthropic"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(enroll.call_args.kwargs["api_format"], "anthropic")


if __name__ == "__main__":
    unittest.main()
