"""Explicitly installed account retention and credential recovery for the managed backend."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from queue import Empty, Queue
import re
import subprocess
import sys
from threading import BoundedSemaphore, Lock, Thread


def utcnow():
    return datetime.now(timezone.utc)


class AccountRecovery:
    def __init__(self, service, config, log_service, worker_path):
        self.service = service
        self.config = config
        self.log_service = log_service
        self.worker_path = Path(worker_path)
        self.original_normal_tokens = service.list_normal_tokens
        self.original_fetch = service.fetch_remote_info
        self.slots = BoundedSemaphore(2)
        self.lock = Lock()
        self.running = set()

    @staticmethod
    def has_password(account):
        return bool(str(account.get("email") or "").strip() and str(account.get("password") or "").strip())

    @staticmethod
    def cooling_down(account):
        value = account.get("last_credential_recovery_at")
        if not value:
            return False
        try:
            last_attempt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if last_attempt.tzinfo is None:
                last_attempt = last_attempt.replace(tzinfo=timezone.utc)
            return utcnow() - last_attempt < timedelta(minutes=30)
        except (TypeError, ValueError):
            return False

    def list_refresh_tokens(self):
        tokens = self.original_normal_tokens()
        if not self.config.auto_relogin_after_refresh:
            return tokens
        retries = [
            a["access_token"] for a in self.service.list_accounts()
            if a.get("status") == "异常" and a.get("access_token")
            and a.get("last_credential_recovery_error") != "account_deactivated"
            and (self.has_password(a) or a.get("refresh_token")) and not self.cooling_down(a)
        ]
        return list(dict.fromkeys([*tokens, *retries[:2]]))

    def fetch_remote_info(self, access_token, event="fetch_remote_info", defer_invalid_removal=True):
        account = self.service.get_account(access_token)
        refresh_only_retry = bool(
            account and account.get("status") == "异常" and account.get("refresh_token")
            and not self.has_password(account)
        )
        try:
            result = self.original_fetch(access_token, event, defer_invalid_removal)
        except Exception:
            if account and account.get("status") == "禁用" and self.service.get_account(access_token):
                self.service.update_account(access_token, {"status": "禁用", "quota": 0}, quiet=True)
            if refresh_only_retry:
                self.service.update_account(access_token, {
                    "last_credential_recovery_at": utcnow().isoformat(),
                    "last_credential_recovery_error": "refresh_failed",
                }, quiet=True)
            raise
        if refresh_only_retry and result is not None:
            self.service.update_account(access_token, {"last_credential_recovery_error": None}, quiet=True)
        return result

    @staticmethod
    def worker_error(result):
        # Only fixed error codes leave the worker; its detail/stderr can contain credentials.
        detail = str(result.get("detail") or "").lower()
        if "account_deactivated" in detail or "you do not have an account because it has been deleted or deactivated" in detail:
            return "account_deactivated"
        error = str(result.get("error") or "")
        if error in {"invalid_password", "need_verification_code", "mfa_challenge_requires_totp_secret",
                     "invalid_totp_secret_base32", "rate_limit_exceeded", "unsupported_country_region_territory",
                     "account_deactivated"} or re.fullmatch(r"(?:mfa_verify|password_verify|token_exchange)_failed_\d{3}", error):
            return error
        return "login_failed"

    def progress(self, progress_id, token, status, error=None):
        if progress_id:
            self.service.update_relogin_progress(progress_id, token, status, error)

    def re_login_accounts(self, access_tokens, progress_id=None):
        tokens = list(dict.fromkeys(t for t in access_tokens if t))
        result = {"relogined": len(tokens), "skipped": 0, "errors": [], "items": []}
        if progress_id:
            self.service.init_relogin_progress(progress_id, len(tokens))
        if not tokens:
            if progress_id:
                self.service.finish_relogin_progress(progress_id, result=result)
            return result
        pending = Queue()
        for token in tokens:
            account = self.service.get_account(token)
            pending.put((token, bool(account and account.get("status") == "禁用")))

        def worker():
            while True:
                try:
                    token, initial_disabled = pending.get_nowait()
                except Empty:
                    return
                self.relogin(token, "", "", "manual_relogin", progress_id, initial_disabled)

        for _ in range(min(2, len(tokens))):
            Thread(target=worker, daemon=True).start()
        return result

    def relogin(self, access_token, email, password, event, progress_id=None, initial_disabled=None):
        account = self.service.get_account(access_token)
        manual = event == "manual_relogin"
        if initial_disabled is None:
            initial_disabled = bool(manual and account and account.get("status") == "禁用")
        if not account or (account.get("status") == "禁用" and not initial_disabled):
            self.progress(progress_id, access_token, "跳过", "账号不存在或已禁用")
            return
        if not manual and (not self.config.auto_relogin_after_refresh or self.cooling_down(account)
                           or account.get("last_credential_recovery_error") == "account_deactivated"):
            self.progress(progress_id, access_token, "跳过", "自动恢复已关闭或处于重试等待期")
            return
        if not self.has_password(account):
            self.progress(progress_id, access_token, "跳过", "缺少邮箱密码，请重新导入有效凭据")
            return
        identity = str(account.get("email") or account["access_token"]).strip().lower()
        with self.lock:
            if identity in self.running:
                self.progress(progress_id, access_token, "跳过", "凭据恢复正在进行，请稍后重试")
                return
            self.running.add(identity)
        if not self.slots.acquire(blocking=manual):
            with self.lock:
                self.running.discard(identity)
            self.progress(progress_id, access_token, "跳过", "凭据恢复正在进行，请稍后重试")
            return
        token = access_token
        error = "login_failed"
        try:
            account = self.service.get_account(token)
            if not account or (account.get("status") == "禁用" and not initial_disabled):
                self.progress(progress_id, access_token, "跳过", "账号已移除或禁用")
                return
            self.service.update_account(token, {"last_credential_recovery_at": utcnow().isoformat()}, quiet=True)
            target = {"id": "recovery", "email": account["email"], "password": account["password"],
                      "totp_secret": str(account.get("totp_secret") or account.get("auxiliary") or ""),
                      "access_token": "", "refresh_token": ""}
            process = subprocess.run(
                [sys.executable, str(self.worker_path)], input=json.dumps({"action": "authenticate", "accounts": [target]}),
                capture_output=True, text=True, encoding="utf-8", timeout=180,
                cwd=str(self.worker_path.parent),
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}),
            )
            if process.returncode:
                raise RuntimeError("worker_failed")
            results = json.loads(process.stdout).get("results", [])
            result = next((r for r in results if r.get("id") == "recovery"), {})
            if not result.get("ok") or not str(result.get("access_token") or "").strip():
                error = self.worker_error(result)
                raise RuntimeError("login_failed")
            current = self.service.get_account(token)
            if not current or (current.get("status") == "禁用" and not initial_disabled):
                self.progress(progress_id, access_token, "跳过", "账号已移除或禁用")
                return
            token = self.service._apply_refreshed_tokens(token, {
                k: str(result.get(k) or "").strip() for k in ("access_token", "refresh_token", "id_token")
            }, f"{event}:credential_recovery")
            self.service.update_account(token, {"status": "异常", "quota": 0}, quiet=True)
            error = "verification_failed"
            verified = self.original_fetch(token, f"{event}:credential_recovery", False)
            if not verified or verified.get("status") not in {"正常", "限流"}:
                raise RuntimeError("verification_failed")
            self.service.update_account(token, {"last_credential_recovery_error": None}, quiet=True)
            self.log_service.add("account", "自动更新凭证成功", {
                "source": event, "account": hashlib.sha256(identity.encode()).hexdigest()[:12],
            })
            self.progress(progress_id, access_token, "成功")
        except Exception as exc:
            current = self.service.get_account(token)
            if not current or (current.get("status") == "禁用" and not initial_disabled):
                self.progress(progress_id, access_token, "跳过", "账号已移除或禁用")
                return
            if isinstance(exc, subprocess.TimeoutExpired):
                error = "login_timeout"
            status = "禁用" if initial_disabled or error == "account_deactivated" else "异常"
            self.service.update_account(token, {
                "status": status, "quota": 0,
                "last_credential_recovery_at": utcnow().isoformat(),
                "last_credential_recovery_error": error,
            }, quiet=True)
            self.log_service.add("account", "自动更新凭证失败，保留账号", {
                "source": event, "account": hashlib.sha256(identity.encode()).hexdigest()[:12], "error": error,
            })
            self.progress(progress_id, access_token, status, error)
        finally:
            with self.lock:
                self.running.discard(identity)
                self.slots.release()


def install_account_recovery(service, config, log_service, worker_path):
    """Migrate saved defaults once, then install wrappers before the watcher starts."""
    if getattr(service, "_dsh_account_recovery", None) is not None:
        return service._dsh_account_recovery
    if config.data.get("dsh_account_recovery_version") != 1:
        config.update({"auto_remove_invalid_accounts": False, "auto_remove_rate_limited_accounts": False,
                       "auto_relogin_after_refresh": True, "dsh_account_recovery_version": 1})
    recovery = AccountRecovery(service, config, log_service, worker_path)
    service._password_re_login_thread = recovery.relogin
    service.re_login_accounts = recovery.re_login_accounts
    service.list_normal_tokens = recovery.list_refresh_tokens
    service.fetch_remote_info = recovery.fetch_remote_info
    service._dsh_account_recovery = recovery
    return recovery
