"""Offline account recovery checks; no real credentials or network requests."""
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import threading
import types
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "dsh_account_recovery", Path(__file__).resolve().parents[1] / "scripts" / "dsh_account_recovery.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NOW = datetime(2026, 11, 20, 5, 0, tzinfo=timezone.utc)


class Config:
    def __init__(self, **data):
        self.data = data
        self.updates = []

    @property
    def auto_relogin_after_refresh(self):
        return self.data.get("auto_relogin_after_refresh", False)

    def update(self, values):
        self.data.update(values)
        self.updates.append(dict(values))


class Service:
    def __init__(self, accounts):
        self.accounts = {a["access_token"]: dict(a) for a in accounts}
        self.aliases = {}
        self.progress = []
        self.cumulative_total = len(accounts)
        self.fail_fetch = False
        self.progress_states = {}
        self.progress_done = {}
        self.progress_lock = threading.Lock()

    def get_account(self, token):
        token = self.aliases.get(token, token)
        account = self.accounts.get(token)
        return dict(account) if account else None

    def list_accounts(self):
        return [dict(a) for a in self.accounts.values()]

    def list_normal_tokens(self):
        return [t for t, a in self.accounts.items() if a.get("status") == "正常"]

    def update_account(self, token, values, quiet=False):
        token = self.aliases.get(token, token)
        if token not in self.accounts:
            return None
        self.accounts[token].update(values)
        return self.get_account(token)

    def _apply_refreshed_tokens(self, token, values, event):
        token = self.aliases.get(token, token)
        if token not in self.accounts:
            return token
        account = self.accounts.pop(token)
        account.update({k: v for k, v in values.items() if v})
        replacement = account["access_token"]
        self.accounts[replacement] = account
        self.aliases[token] = replacement
        return replacement

    def fetch_remote_info(self, token, event="fetch_remote_info", defer_invalid_removal=True):
        if self.fail_fetch:
            raise RuntimeError("token invalidated: do-not-expose-this-secret")
        return self.update_account(token, {"status": "正常", "quota": 12})

    def update_relogin_progress(self, progress_id, token, status, error=None):
        with self.progress_lock:
            self.progress.append((progress_id, status, error))
            state = self.progress_states.get(progress_id)
            if state is not None:
                state["processed"] += 1
                state["results"].append({"status": status, "error": error})
                if state["processed"] == state["total"]:
                    state["done"] = True
                    self.progress_done[progress_id].set()

    def init_relogin_progress(self, progress_id, total):
        self.progress_states[progress_id] = {"total": total, "processed": 0, "done": False, "results": []}
        self.progress_done[progress_id] = threading.Event()

    def finish_relogin_progress(self, progress_id, result=None, error=None):
        self.progress_states[progress_id].update(done=True, result=result, error=error)
        self.progress_done[progress_id].set()


def account(token="old", **values):
    return {"access_token": token, "email": token + "@example.test", "password": "password-secret",
            "totp_secret": "totp-secret", "refresh_token": "revoked-refresh-secret", "status": "异常",
            "quota": 0, "success": 17, "created_at": "2026-11-01", **values}


def worker_result(**values):
    result = {"id": "recovery", "ok": True, "access_token": "new", "refresh_token": "new-refresh", **values}
    return types.SimpleNamespace(returncode=0, stdout=json.dumps({"results": [result]}), stderr="")


class AccountRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.config = Config(proxy="preserved-private-proxy")
        self.logs = []
        self.logger = types.SimpleNamespace(add=lambda *args: self.logs.append(args))
        self.clock = patch.object(module, "utcnow", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def install(self, service):
        return module.install_account_recovery(service, self.config, self.logger, Path("auth-worker.py"))

    def login(self, service, token="old", event="auto_relogin_after_refresh", progress=None):
        a = service.get_account(token)
        service._password_re_login_thread(token, a["email"], a.get("password", ""), event, progress)

    def test_migrates_retention_once_without_resetting_later_preferences(self):
        service = Service([account()])
        self.install(service)
        self.assertFalse(self.config.data["auto_remove_invalid_accounts"])
        self.assertFalse(self.config.data["auto_remove_rate_limited_accounts"])
        self.assertTrue(self.config.auto_relogin_after_refresh)
        self.assertEqual(self.config.data["proxy"], "preserved-private-proxy")
        self.config.update({"auto_relogin_after_refresh": False})
        self.install(Service(service.list_accounts()))
        self.assertFalse(self.config.auto_relogin_after_refresh)

    def test_forces_totp_login_and_rotates_in_place_then_verifies_quota(self):
        service = Service([account()])
        self.install(service)
        with patch.object(module.subprocess, "run", return_value=worker_result()) as run:
            self.login(service)
        data = json.loads(run.call_args.kwargs["input"])
        target = data["accounts"][0]
        self.assertEqual(data["action"], "authenticate")
        self.assertEqual(target["totp_secret"], "totp-secret")
        self.assertEqual(target["access_token"], "")
        self.assertEqual(target["refresh_token"], "")
        self.assertEqual(run.call_args.kwargs["timeout"], 180)
        self.assertEqual(len(service.accounts), 1)
        self.assertEqual(service.cumulative_total, 1)
        self.assertEqual(service.get_account("old")["access_token"], "new")
        self.assertEqual(service.get_account("new")["success"], 17)
        self.assertEqual(service.get_account("new")["quota"], 12)
        self.assertEqual(service.get_account("new")["status"], "正常")

    def test_failed_login_preserves_account_and_cooldown_survives_restart(self):
        service = Service([account()])
        self.install(service)
        with patch.object(module.subprocess, "run", return_value=worker_result(ok=False, error="mfa_verify_failed_401")):
            self.login(service)
        self.assertEqual(len(service.accounts), 1)
        self.assertEqual(service.get_account("old")["status"], "异常")
        self.assertEqual(service.list_normal_tokens(), [])
        restarted = Service(copy.deepcopy(service.list_accounts()))
        self.install(restarted)
        self.assertEqual(restarted.list_normal_tokens(), [])
        with patch.object(module, "utcnow", return_value=NOW + timedelta(minutes=31)):
            self.assertEqual(restarted.list_normal_tokens(), ["old"])

    def test_automatic_off_and_disabled_skip_but_manual_retry_can_reenable(self):
        service = Service([account(), account("disabled", status="禁用")])
        self.install(service)
        self.config.update({"auto_relogin_after_refresh": False})
        with patch.object(module.subprocess, "run", return_value=worker_result()) as run:
            self.login(service)
            self.login(service, "disabled")
            self.assertFalse(run.called)
            self.login(service, "disabled", "manual_relogin", "disabled-progress")
            self.assertEqual(service.get_account("disabled")["status"], "正常")
            self.assertEqual(service.progress[-1], ("disabled-progress", "成功", None))
            service.update_account("old", {"last_credential_recovery_at": NOW.isoformat()})
            run.return_value = worker_result(access_token="old-new")
            self.login(service, "old", "manual_relogin", "manual-progress")
        self.assertTrue(run.called)
        self.assertEqual(service.progress[-1], ("manual-progress", "成功", None))
        self.assertEqual(len(service.accounts), 2)

    def test_manual_disabled_failure_remains_disabled_and_exposes_only_safe_reason(self):
        service = Service([account(status="禁用", last_credential_recovery_at=NOW.isoformat())])
        self.install(service)
        self.config.update({"auto_relogin_after_refresh": False})
        with patch.object(module.subprocess, "run", return_value=worker_result(ok=False, error="invalid_password")):
            self.login(service, event="manual_relogin", progress="disabled-failed")
        self.assertEqual(service.get_account("old")["status"], "禁用")
        self.assertEqual(service.get_account("old")["last_credential_recovery_error"], "invalid_password")
        self.assertEqual(service.progress[-1], ("disabled-failed", "禁用", "invalid_password"))

    def test_truncated_upstream_deactivation_message_is_not_a_temporary_mfa_failure(self):
        service = Service([account()])
        self.install(service)
        detail = '{"error":{"message":"You do not have an account because it has been deleted or deactivated."'
        with patch.object(module.subprocess, "run", return_value=worker_result(
            ok=False, error="mfa_verify_failed_403", detail=detail
        )):
            self.login(service, event="manual_relogin", progress="deactivated")
        self.assertEqual(service.get_account("old")["status"], "禁用")
        self.assertEqual(service.progress[-1], ("deactivated", "禁用", "account_deactivated"))

    def test_retries_abnormal_with_refresh_only_or_password_but_not_disabled_or_empty(self):
        service = Service([account("normal", status="正常"), account("refresh-only", password=""),
                           account("password-only", refresh_token=""), account("empty", password="", refresh_token=""),
                           account("disabled", status="禁用")])
        self.install(service)
        self.assertEqual(service.list_normal_tokens(), ["normal", "refresh-only", "password-only"])
        service.fail_fetch = True
        with self.assertRaises(RuntimeError):
            service.fetch_remote_info("refresh-only")
        self.assertEqual(service.list_normal_tokens(), ["normal", "password-only"])
        self.assertEqual(len(service.accounts), 5)
        service.update_account("password-only", {"last_credential_recovery_error": "account_deactivated"})
        self.assertEqual(service.list_normal_tokens(), ["normal"])
        with patch.object(module.subprocess, "run") as run:
            self.login(service, "password-only")
        self.assertFalse(run.called)

    def test_selected_refresh_keeps_disabled_on_failure_but_can_recover_after_verification(self):
        for succeeds in (True, False):
            with self.subTest(succeeds=succeeds):
                service = Service([account(status="禁用")])

                def fetch(token, event, defer_invalid_removal):
                    service.update_account(token, {"status": "异常", "quota": 0})
                    if not succeeds:
                        raise RuntimeError("invalid access token")
                    return service.update_account(token, {"status": "正常", "quota": 12})

                service.fetch_remote_info = fetch
                self.install(service)
                if succeeds:
                    self.assertEqual(service.fetch_remote_info("old")["status"], "正常")
                    self.assertEqual(service.get_account("old")["quota"], 12)
                else:
                    with self.assertRaises(RuntimeError):
                        service.fetch_remote_info("old")
                    self.assertEqual(service.get_account("old")["status"], "禁用")

    def test_concurrent_and_duplicate_logins_are_bounded_and_busy_accounts_retry_later(self):
        service = Service([account("a"), account("b"), account("c")])
        self.install(service)
        started = threading.Barrier(3)
        release = threading.Event()
        calls = []

        def run(*args, **kwargs):
            calls.append(json.loads(kwargs["input"])["accounts"][0]["email"])
            started.wait(timeout=3)
            release.wait(timeout=3)
            return worker_result(ok=False, error="login_failed")

        with patch.object(module.subprocess, "run", side_effect=run):
            threads = [threading.Thread(target=self.login, args=(service, t)) for t in ("a", "b")]
            for thread in threads:
                thread.start()
            started.wait(timeout=3)
            self.login(service, "a", "manual_relogin", "duplicate-progress")
            self.login(service, "c", "auto_relogin_after_refresh", "busy-progress")
            self.assertEqual(len(calls), 2)
            self.assertNotIn("last_credential_recovery_at", service.get_account("c"))
            release.set()
            for thread in threads:
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
        self.assertEqual(service.list_normal_tokens(), ["c"])
        self.assertEqual([p[1] for p in service.progress], ["跳过", "跳过"])

    def test_selected_batch_queues_all_six_and_preserves_unselected_accounts(self):
        selected = [f"account-{i}" for i in range(6)]
        service = Service([account(t, status="禁用" if i % 2 else "异常") for i, t in enumerate(selected)]
                          + [account("unselected", status="正常")])
        self.install(service)
        started = threading.Barrier(3)
        release = threading.Event()
        calls = []
        active = peak = 0
        lock = threading.Lock()

        def run(*args, **kwargs):
            nonlocal active, peak
            email = json.loads(kwargs["input"])["accounts"][0]["email"]
            with lock:
                calls.append(email)
                first_pair = len(calls) <= 2
                active += 1
                peak = max(peak, active)
            if first_pair:
                started.wait(timeout=3)
                release.wait(timeout=3)
            with lock:
                active -= 1
            return worker_result(access_token="new-" + email)

        with patch.object(module.subprocess, "run", side_effect=run):
            result = service.re_login_accounts([*selected, selected[0]], "batch-six")
            started.wait(timeout=3)
            self.assertEqual(result["relogined"], 6)
            self.assertFalse(service.progress_states["batch-six"]["done"])
            self.assertEqual(len(calls), 2)
            release.set()
            self.assertTrue(service.progress_done["batch-six"].wait(timeout=3))
        state = service.progress_states["batch-six"]
        self.assertEqual((state["total"], state["processed"]), (6, 6))
        self.assertEqual([r["status"] for r in state["results"]], ["成功"] * 6)
        self.assertEqual(set(calls), {t + "@example.test" for t in selected})
        self.assertEqual(peak, 2)
        self.assertEqual(len(service.accounts), 7)
        self.assertEqual(service.get_account("unselected")["access_token"], "unselected")

    def test_selected_batch_reports_missing_credentials_and_empty_batch_finishes(self):
        service = Service([account("a"), account("no-password", password="")])
        self.install(service)
        with patch.object(module.subprocess, "run", return_value=worker_result()) as run:
            service.re_login_accounts(["a", "no-password", "missing"], "mixed")
            self.assertTrue(service.progress_done["mixed"].wait(timeout=3))
        self.assertEqual(run.call_count, 1)
        state = service.progress_states["mixed"]
        self.assertEqual((state["total"], state["processed"]), (3, 3))
        self.assertEqual(sorted(r["status"] for r in state["results"]), sorted(["成功", "跳过", "跳过"]))
        self.assertIn("缺少邮箱密码，请重新导入有效凭据", [r["error"] for r in state["results"]])
        service.re_login_accounts([], "empty")
        self.assertTrue(service.progress_states["empty"]["done"])

    def test_selected_account_newly_disabled_while_queued_is_not_reenabled(self):
        service = Service([account(t) for t in ("a", "b", "c")])
        self.install(service)
        started = threading.Barrier(3)
        release = threading.Event()
        calls = []

        def run(*args, **kwargs):
            email = json.loads(kwargs["input"])["accounts"][0]["email"]
            calls.append(email)
            if email != "c@example.test":
                started.wait(timeout=3)
                release.wait(timeout=3)
            return worker_result(access_token="new-" + email)

        with patch.object(module.subprocess, "run", side_effect=run):
            service.re_login_accounts(["a", "b", "c"], "disabled-queued")
            started.wait(timeout=3)
            service.update_account("c", {"status": "禁用"})
            release.set()
            self.assertTrue(service.progress_done["disabled-queued"].wait(timeout=3))
        self.assertEqual(len(calls), 2)
        self.assertEqual(service.get_account("c")["access_token"], "c")
        self.assertEqual(service.get_account("c")["status"], "禁用")
        self.assertEqual(sorted(r["status"] for r in service.progress_states["disabled-queued"]["results"]),
                         sorted(["成功", "成功", "跳过"]))

    def test_manual_login_waits_for_automatic_slots_without_blocking_identity_lock(self):
        service = Service([account(t) for t in ("a", "b", "c")])
        recovery = self.install(service)
        started = threading.Barrier(3)
        release = threading.Event()
        waiting = threading.Event()
        calls = []
        acquire = recovery.slots.acquire

        def observed_acquire(blocking=True):
            if blocking:
                waiting.set()
            return acquire(blocking=blocking)

        def run(*args, **kwargs):
            email = json.loads(kwargs["input"])["accounts"][0]["email"]
            calls.append(email)
            if email != "c@example.test":
                started.wait(timeout=3)
                release.wait(timeout=3)
            return worker_result(ok=False, error="login_failed")

        with patch.object(module.subprocess, "run", side_effect=run), patch.object(recovery.slots, "acquire", side_effect=observed_acquire):
            automatic = [threading.Thread(target=self.login, args=(service, t)) for t in ("a", "b")]
            for t in automatic:
                t.start()
            started.wait(timeout=3)
            manual = threading.Thread(target=self.login, args=(service, "c", "manual_relogin", "waited"))
            manual.start()
            self.assertTrue(waiting.wait(timeout=3))
            self.login(service, "c", "manual_relogin", "duplicate-queued")
            self.assertEqual(service.progress[-1][0:2], ("duplicate-queued", "跳过"))
            self.assertEqual(len(calls), 2)
            release.set()
            for t in automatic + [manual]:
                t.join(timeout=3)
                self.assertFalse(t.is_alive())
        self.assertEqual(len(calls), 3)
        self.assertEqual(service.progress[-1][0], "waited")

    def test_successful_login_with_failed_verification_keeps_record_abnormal(self):
        service = Service([account()])
        service.fail_fetch = True
        self.install(service)
        with patch.object(module.subprocess, "run", return_value=worker_result()):
            self.login(service, event="manual_relogin", progress="verify-progress")
        self.assertEqual(len(service.accounts), 1)
        self.assertEqual(service.get_account("new")["status"], "异常")
        self.assertEqual(service.get_account("new")["quota"], 0)
        self.assertEqual(service.progress[-1][1], "异常")
        self.assertNotIn("do-not-expose-this-secret", json.dumps(self.logs + service.progress))

    def test_timeout_and_worker_output_do_not_leak_secrets(self):
        service = Service([account()])
        self.install(service)
        with patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 180, output="secret")):
            self.login(service, event="manual_relogin", progress="timeout-progress")
        self.assertEqual(len(service.accounts), 1)
        self.assertNotIn("secret", json.dumps(self.logs + service.progress))

    def test_disabling_account_during_login_is_preserved_on_success_or_failure(self):
        for succeeds in (True, False):
            with self.subTest(succeeds=succeeds):
                service = Service([account()])
                self.install(service)

                def run(*args, **kwargs):
                    service.update_account("old", {"status": "禁用"})
                    if succeeds:
                        return worker_result()
                    raise subprocess.TimeoutExpired("worker", 180)

                with patch.object(module.subprocess, "run", side_effect=run):
                    self.login(service, event="manual_relogin", progress="disabled-during-login")
                self.assertEqual(service.get_account("old")["status"], "禁用")
                self.assertEqual(service.get_account("old")["access_token"], "old")
                self.assertEqual(service.progress[-1][1], "跳过")

    def test_deleting_account_during_manual_login_does_not_restore_it(self):
        for succeeds in (True, False):
            with self.subTest(succeeds=succeeds):
                service = Service([account()])
                self.install(service)

                def run(*args, **kwargs):
                    service.accounts.pop("old")
                    if succeeds:
                        return worker_result()
                    raise subprocess.TimeoutExpired("worker", 180)

                with patch.object(module.subprocess, "run", side_effect=run):
                    self.login(service, event="manual_relogin", progress="deleted-during-login")
                self.assertEqual(service.accounts, {})
                self.assertEqual(service.progress[-1][1], "跳过")


if __name__ == "__main__":
    unittest.main()
