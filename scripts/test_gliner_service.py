from __future__ import annotations

import importlib.util
import os
import sys
import types
import threading
import time
import socket
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("gliner-service.py")
SPEC = importlib.util.spec_from_file_location("storyhold_gliner_service", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load Storyhold's Lorekeeper service module.")
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)


class QwenLlamaMemorySettingsTests(unittest.TestCase):
    def test_default_profile_keeps_context_and_logical_batch_but_reduces_micro_batch(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            settings = SERVICE.qwen_llama_context_settings()

        self.assertEqual(settings["n_ctx"], 16_384)
        self.assertEqual(settings["n_batch"], 512)
        self.assertEqual(settings["n_ubatch"], 128)
        self.assertIs(settings["offload_kqv"], True)

    def test_operator_overrides_are_bounded_and_micro_batch_cannot_exceed_batch(self) -> None:
        with mock.patch.dict(os.environ, {
            "STORYHOLD_LOCAL_QWEN_BATCH_SIZE": "96",
            "STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE": "512",
            "STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV": "false",
        }, clear=True):
            settings = SERVICE.qwen_llama_context_settings()

        self.assertEqual(settings["n_ctx"], 16_384)
        self.assertEqual(settings["n_batch"], 96)
        self.assertEqual(settings["n_ubatch"], 96)
        self.assertIs(settings["offload_kqv"], False)

    def test_invalid_overrides_return_to_the_conservative_defaults(self) -> None:
        with mock.patch.dict(os.environ, {
            "STORYHOLD_LOCAL_QWEN_BATCH_SIZE": "not-a-number",
            "STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE": "not-a-number",
            "STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV": "not-a-boolean",
        }, clear=True):
            settings = SERVICE.qwen_llama_context_settings()

        self.assertEqual(settings["n_batch"], 512)
        self.assertEqual(settings["n_ubatch"], 128)
        self.assertIs(settings["offload_kqv"], True)

    def test_gguf_loader_passes_the_conservative_profile_without_reducing_layers(self) -> None:
        captured: dict[str, object] = {}
        fake_module = types.ModuleType("llama_cpp")

        class FakeLlama:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

        fake_module.Llama = FakeLlama
        fake_module.llama_supports_gpu_offload = lambda: True
        fake_module.llama_print_system_info = lambda: b"Vulkan"
        with (
            mock.patch.dict(sys.modules, {"llama_cpp": fake_module}),
            mock.patch.object(SERVICE.os.path, "isfile", return_value=True),
            mock.patch.dict(os.environ, {
                "STORYHOLD_LOCAL_QWEN_GPU_LAYERS": "32",
            }, clear=True),
        ):
            loaded = SERVICE.load_qwen_model("qwen.gguf", "cache", "cuda")

        self.assertEqual(captured["n_ctx"], 16_384)
        self.assertEqual(captured["n_batch"], 512)
        self.assertEqual(captured["n_ubatch"], 128)
        self.assertEqual(captured["n_gpu_layers"], 32)
        self.assertIs(captured["offload_kqv"], True)
        self.assertEqual(loaded["gpuLayers"], 32)
        self.assertEqual(loaded["device"], "vulkan")


class WorkerFailureDiagnosticsTests(unittest.TestCase):
    class FakeProcess:
        pid = 8123
        exitcode = None

        def __init__(self) -> None:
            self.alive = True
            self.closed = False

        def is_alive(self) -> bool:
            return self.alive

        def join(self, timeout: float | None = None) -> None:
            self.alive = False

        def terminate(self) -> None:
            self.alive = False

        def kill(self) -> None:
            self.alive = False

        def close(self) -> None:
            self.closed = True

    class FakeConnection:
        def __init__(self) -> None:
            self.sent: list[dict[str, object]] = []
            self.closed = False

        def send(self, message: dict[str, object]) -> None:
            self.sent.append(message)

        def close(self) -> None:
            self.closed = True

    def test_explicit_vulkan_allocation_failure_is_retained_as_gpu_oom(self) -> None:
        failure = SERVICE.worker_failure_record(
            "qwen",
            8123,
            1,
            "ggml_vulkan: Device memory allocation of size 100663296 failed: ErrorOutOfDeviceMemory",
        )

        self.assertEqual(failure["kind"], "gpu_out_of_memory")
        self.assertIn("100663296", failure["message"])
        self.assertEqual(failure["stage"], "qwen")

    def test_windows_cpp_worker_exit_preserves_a_native_gpu_memory_diagnostic(self) -> None:
        signed_exit_code = SERVICE.WINDOWS_CPP_EXCEPTION - (1 << 32)
        with mock.patch.object(SERVICE.os, "name", "nt"):
            failure = SERVICE.worker_failure_record(
                "qwen",
                8123,
                signed_exit_code,
                "The local model worker closed its control connection unexpectedly.",
            )

        self.assertEqual(failure["kind"], "gpu_memory_or_native_backend_failure")
        self.assertEqual(failure["nativeExitCode"], "0xe06d7363")
        self.assertIn("failed llama.cpp GPU allocation", failure["message"])

    def test_manual_stage_release_does_not_clear_the_last_failure(self) -> None:
        manager = SERVICE.SequentialModelManager({"qwen": "model.gguf"}, "cache", "auto")
        manager.last_worker_failure = SERVICE.worker_failure_record(
            "qwen",
            8123,
            1,
            "Vulkan allocation failed: out of memory",
        )

        manager.release()

        self.assertEqual(manager.last_worker_failure["kind"], "gpu_out_of_memory")

    def test_live_worker_native_inference_error_is_released_and_retained(self) -> None:
        manager = SERVICE.SequentialModelManager({"qwen": "model.gguf"}, "cache", "auto")
        process = self.FakeProcess()
        connection = self.FakeConnection()
        manager.active_stage = "qwen"
        manager.worker_pid = process.pid
        manager.worker_process = process
        manager.worker_connection = connection
        manager._receive = mock.Mock(return_value={
            "type": "error",
            "id": 1,
            "error": "OSError: [WinError -529697949] Windows Error 0xe06d7363",
        })

        with self.assertRaisesRegex(RuntimeError, "failed llama.cpp GPU allocation"):
            manager.invoke("qwen", "audit", {"prompt": "evidence"})

        self.assertIsNone(manager.worker_process)
        self.assertIsNone(manager.active_stage)
        self.assertTrue(process.closed)
        self.assertTrue(connection.closed)
        self.assertIn({"type": "shutdown"}, connection.sent)
        self.assertEqual(
            manager.last_worker_failure["kind"],
            "gpu_memory_or_native_backend_failure",
        )
        self.assertEqual(manager.last_worker_failure["stage"], "qwen")


class LocalRequestSafetyTests(unittest.TestCase):
    def manager(self):
        return SERVICE.SequentialModelManager({"gliner2": "unchanged-model"}, "cache", "auto")

    def handler(self, manager=None):
        handler = object.__new__(SERVICE.Handler)
        handler.server = types.SimpleNamespace(manager=manager or self.manager(), inference_lock=threading.Lock())
        handler.caller_disconnected = mock.Mock(return_value=False)
        return handler

    def test_original_pagefile_failure_survives_missing_optional_bin_error(self):
        try:
            try:
                raise OSError("[WinError 1455] The paging file is too small for this operation")
            except OSError:
                raise RuntimeError("LocalEntryNotFoundError: no pytorch_model.bin in cache")
        except RuntimeError as error:
            message = SERVICE.worker_exception_message(error)
            self.assertIn("1455", message)
            self.assertNotIn("pytorch_model.bin", message)
            self.assertFalse(SERVICE.can_retry_on_cpu(error))
            self.assertEqual(SERVICE.worker_failure_record("gliner2", 1, None, message)["kind"], "system_memory_exhausted")

    def test_cpu_retry_is_only_for_a_gpu_placement_failure(self):
        self.assertTrue(SERVICE.can_retry_on_cpu(RuntimeError("CUDA out of memory")))
        for message in ("LocalEntryNotFoundError", "WinError 1455 paging file", "bad model configuration", "CPU out of memory"):
            self.assertFalse(SERVICE.can_retry_on_cpu(RuntimeError(message)), message)

    def test_device_detection_failure_is_reported_without_loading_or_reimporting(self):
        connection = WorkerFailureDiagnosticsTests.FakeConnection()
        with (
            mock.patch.object(SERVICE, "local_device", side_effect=OSError("[WinError 1455] paging file too small")),
            mock.patch.object(SERVICE, "load_gliner2_model") as loader,
            mock.patch.object(SERVICE.traceback, "print_exc"),
        ):
            SERVICE.lorekeeper_stage_worker(connection, "gliner2", "same-model", "cache", "auto")
        loader.assert_not_called()
        self.assertEqual(connection.sent[0]["type"], "boot_error")
        self.assertIn("1455", connection.sent[0]["error"])
        self.assertTrue(connection.closed)

    def test_low_commit_blocks_spawn_and_repeated_attempts(self):
        manager = self.manager()
        manager.context = mock.Mock()
        with mock.patch.object(SERVICE, "system_memory_status", return_value={"available": True, "availableCommitBytes": 500_000_000}):
            with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_MEMORY"):
                manager.activate("gliner2")
            with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_COOLDOWN"):
                manager.activate("gliner2")
        manager.context.Process.assert_not_called()
        self.assertIsNone(manager.loading_stage)
        self.assertFalse(manager.component_status("gliner2")["ready"])
        self.assertTrue(manager.component_status("gliner2")["blocked"])
        self.assertEqual(manager.last_worker_failure["kind"], "system_memory_exhausted")

    def test_healthy_resident_model_does_not_reload_when_memory_is_low(self):
        manager = self.manager()
        manager.active_stage = "gliner2"
        manager.worker_pid = 8123
        manager.worker_process = WorkerFailureDiagnosticsTests.FakeProcess()
        with mock.patch.object(SERVICE, "system_memory_status", side_effect=AssertionError("resident model does not need a new allocation")):
            result = manager.activate("gliner2")
        self.assertEqual(result["pid"], 8123)

    def test_expired_request_never_enters_inference_or_changes_resident_worker(self):
        handler = self.handler()
        with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_DEADLINE"):
            with handler.inference_scope({"deadlineUnixMs": (time.time() - 1) * 1000}):
                self.fail("Expired requests must not load a model")
        self.assertFalse(handler.server.inference_lock.locked())
        self.assertIsNone(handler.server.manager.request_deadline)

    def test_quick_precheck_never_starts_or_cooldowns_a_cold_model(self):
        manager = self.manager()
        manager.context = mock.Mock()
        handler = self.handler(manager)
        with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_NOT_READY"):
            with handler.inference_scope({"requireLoaded": True}):
                manager.activate("gliner2")
        manager.context.Process.assert_not_called()
        self.assertEqual(manager.retry_after, {})
        self.assertFalse(manager.request_requires_loaded)
        self.assertFalse(handler.server.inference_lock.locked())

    def test_quick_precheck_reuses_a_resident_model(self):
        manager = self.manager()
        manager.active_stage = "gliner2"
        manager.worker_pid = 8123
        manager.worker_process = WorkerFailureDiagnosticsTests.FakeProcess()
        handler = self.handler(manager)
        with handler.inference_scope({"requireLoaded": True}):
            self.assertEqual(manager.activate("gliner2")["pid"], 8123)

    def test_invalid_deadline_is_rejected_and_lock_released(self):
        for deadline in (True, "soon", float("nan"), float("inf")):
            handler = self.handler()
            with self.assertRaisesRegex(SERVICE.LocalRequestError, "invalid request deadline"):
                with handler.inference_scope({"deadlineUnixMs": deadline}):
                    self.fail("Invalid deadline entered inference")
            self.assertFalse(handler.server.inference_lock.locked())

    def test_deadline_expiring_during_prior_release_never_spawns_next_worker(self):
        manager = self.manager()
        manager.context = mock.Mock()
        def expire_during_release():
            manager.request_deadline = time.monotonic() - 1
        manager.release = expire_during_release
        with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_DEADLINE"):
            manager.activate("gliner2")
        manager.context.Process.assert_not_called()

    def test_response_provenance_survives_a_following_stage_change(self):
        handler = self.handler()
        with handler.inference_scope():
            handler.server.manager.worker_pid = 123
            handler.server.manager.resolved_device = "cuda"
        handler.server.manager.worker_pid = 456
        handler.server.manager.resolved_device = "cpu"
        self.assertEqual(handler.response_worker_pid, 123)
        self.assertEqual(handler.response_device, "cuda")

    def test_health_tolerates_concurrently_closed_worker(self):
        manager = self.manager()
        manager.worker_process = mock.Mock()
        manager.worker_process.is_alive.side_effect = ValueError("process object is closed")
        self.assertFalse(manager.worker_alive)

    def test_busy_request_does_not_queue_or_overwrite_active_deadline(self):
        handler = self.handler()
        handler.server.manager.request_deadline = 123
        handler.server.inference_lock.acquire()
        try:
            with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_BUSY"):
                with handler.inference_scope():
                    self.fail("Busy request entered inference")
            self.assertEqual(handler.server.manager.request_deadline, 123)
        finally:
            handler.server.inference_lock.release()

    def test_disconnect_during_receive_stops_own_worker_before_releasing_lock(self):
        manager = self.manager()
        manager.active_stage = "gliner2"
        process = WorkerFailureDiagnosticsTests.FakeProcess()
        manager.worker_process = process
        manager.worker_pid = process.pid
        manager.worker_connection = WorkerFailureDiagnosticsTests.FakeConnection()
        handler = self.handler(manager)
        handler.caller_disconnected = mock.Mock(side_effect=[False, False, False, True])
        with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_CANCELLED"):
            with handler.inference_scope():
                manager.invoke("gliner2", "extract_gliner2", {"text": "A scene"})
        self.assertTrue(process.closed)
        self.assertIsNone(manager.worker_process)
        self.assertFalse(handler.server.inference_lock.locked())

    def test_socket_disconnect_is_detected_without_blocking(self):
        reader, writer = socket.socketpair()
        handler = object.__new__(SERVICE.Handler)
        handler.connection = reader
        try:
            self.assertFalse(handler.caller_disconnected())
            writer.close()
            self.assertTrue(handler.caller_disconnected())
        finally:
            reader.close()
            writer.close()

    def test_shutdown_cancels_inflight_work_and_refuses_new_loads(self):
        manager = self.manager()
        manager.active_stage = "gliner2"
        process = WorkerFailureDiagnosticsTests.FakeProcess()
        manager.worker_process = process
        manager.worker_pid = process.pid
        connection = WorkerFailureDiagnosticsTests.FakeConnection()
        manager.worker_connection = connection
        original_send = connection.send
        def shutdown_when_request_sent(message):
            original_send(message)
            if message.get("type") == "request":
                manager.shutdown_requested.set()
        connection.send = shutdown_when_request_sent
        handler = self.handler(manager)
        with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_STOPPING"):
            with handler.inference_scope():
                manager.invoke("gliner2", "extract_gliner2", {"text": "A scene"})
        self.assertTrue(process.closed)
        self.assertFalse(handler.server.inference_lock.locked())
        with self.assertRaisesRegex(SERVICE.LocalRequestError, "LOREKEEPER_STOPPING"):
            manager.activate("gliner2")

    def test_failure_cooldown_is_stage_specific_and_expires(self):
        manager = self.manager()
        manager.models["nli"] = "nli-model"
        manager.loading_stage = "gliner2"
        with mock.patch.object(SERVICE.time, "monotonic", return_value=100):
            manager._record_worker_failure("LocalEntryNotFoundError")
            self.assertTrue(manager.component_status("gliner2")["blocked"])
            self.assertFalse(manager.component_status("nli")["blocked"])
        with mock.patch.object(SERVICE.time, "monotonic", return_value=161):
            self.assertFalse(manager.component_status("gliner2")["blocked"])
            self.assertIsNotNone(manager.component_status("gliner2")["lastFailure"])


if __name__ == "__main__":
    unittest.main()
