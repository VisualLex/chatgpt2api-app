#!/usr/bin/env python3
"""
ChatGPT2API Native DSH Plugin: Account OAuth & 2FA Authentication Worker
Executes OAuth + PKCE + TOTP 2FA flow against OpenAI to exchange credentials for access & refresh tokens,
and optionally enrolls them directly into the running account pool.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import struct
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

# Ensure the chatgpt2api source directory is in sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
CANDIDATE_ROOTS = [
    Path.cwd(),
    SCRIPT_DIR,
    SCRIPT_DIR.parent,
    Path.home() / ".dsh" / "chatgpt2api-native" / "source",
]
for candidate in CANDIDATE_ROOTS:
    if (candidate / "utils" / "sentinel.py").is_file():
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))
        break

try:
    from curl_cffi import requests
except ImportError:
    requests = None

try:
    from utils.pkce import generate_pkce
except ImportError:
    generate_pkce = None

try:
    from utils.sentinel import build_sentinel_token
except ImportError:
    build_sentinel_token = None

try:
    from services.config import config
except ImportError:
    config = None


def parse_jwt_payload(t: str) -> dict:
    """Safely decode JWT payload JSON without signature verification."""
    try:
        parts = str(t or "").split(".")
        if len(parts) != 3:
            return {}
        padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
        return json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except Exception:
        return {}


def get_totp(secret: str) -> str:
    """Calculate current 6-digit TOTP code from Base32 secret."""
    secret = secret.replace(" ", "").upper()
    secret += "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(secret)
    counter = int(time.time() // 30)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[19] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def resolve_proxy(custom_proxy: str = "") -> str:
    """Resolve usable proxy URL from argument, config, environment, or probe common local ports."""
    if custom_proxy and str(custom_proxy).strip():
        return str(custom_proxy).strip()
    if config:
        try:
            cfg_proxy = config.get_proxy_settings()
            if cfg_proxy:
                return cfg_proxy
        except Exception:
            pass
    for env_key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        val = os.environ.get(env_key, "").strip()
        if val:
            return val
    # Check if common local proxy ports are listening
    import socket
    for port in (7890, 7897, 10809, 10808):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.15):
                return f"http://127.0.0.1:{port}"
        except OSError:
            continue
    return ""


def login_with_password_and_totp(email: str, password: str, totp_secret: str = "", proxy: str = "") -> dict:
    """
    Log in to OpenAI Platform OAuth via email, password, and optional TOTP 2FA.
    Returns token dict on success or error dict on failure.
    """
    if not requests or not generate_pkce or not build_sentinel_token:
        return {"ok": False, "error": "dependencies_missing", "detail": "curl_cffi or utils modules not found"}

    auth_base = "https://auth.openai.com"
    platform_oauth_audience = "https://api.openai.com/v1"
    platform_auth0_client = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9"
    platform_oauth_client_id = "app_2SKx67EdpoN0G6j64rFvigXD"
    platform_oauth_redirect_uri = "https://platform.openai.com/auth/callback"
    user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"

    session_kwargs = {"impersonate": "chrome110", "verify": False}
    proxy_url = resolve_proxy(proxy)
    if proxy_url:
        session_kwargs["proxy"] = proxy_url

    session = requests.Session(**session_kwargs)
    device_id = str(uuid.uuid4())
    code_verifier, code_challenge = generate_pkce()

    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")

    # 1. Authorize
    params = {
        "issuer": auth_base,
        "client_id": platform_oauth_client_id,
        "audience": platform_oauth_audience,
        "redirect_uri": platform_oauth_redirect_uri,
        "device_id": device_id,
        "screen_hint": "login_or_signup",
        "max_age": "0",
        "login_hint": email,
        "scope": "openid profile email offline_access",
        "response_type": "code",
        "response_mode": "query",
        "state": secrets.token_urlsafe(32),
        "nonce": secrets.token_urlsafe(32),
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "auth0Client": platform_auth0_client,
    }
    authorize_url = f"{auth_base}/api/accounts/authorize?{urlencode(params)}"
    try:
        resp = session.get(authorize_url, headers={"user-agent": user_agent}, allow_redirects=True, timeout=30)
    except Exception as e:
        return {"ok": False, "error": f"authorize_network_error: {str(e)}"}

    if resp.status_code not in (200, 302):
        return {"ok": False, "error": f"authorize_failed_{resp.status_code}"}

    # 2. Password verify
    login_headers = {
        "accept": "application/json",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        "origin": auth_base,
        "priority": "u=1, i",
        "user-agent": user_agent,
        "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "referer": f"{auth_base}/email-verification",
        "oai-device-id": device_id,
    }

    try:
        sentinel_val, oai_sc_val = build_sentinel_token(session, device_id, "password_verify")
        login_headers["openai-sentinel-token"] = sentinel_val
        if oai_sc_val:
            session.cookies.set("oai-sc", oai_sc_val, domain=".openai.com")
    except Exception:
        pass

    try:
        login_resp = session.post(
            f"{auth_base}/api/accounts/password/verify",
            headers=login_headers,
            json={"password": password},
            timeout=30,
        )
    except Exception as e:
        return {"ok": False, "error": f"password_verify_network_error: {str(e)}"}

    if login_resp.status_code != 200:
        return {"ok": False, "error": f"password_verify_failed_{login_resp.status_code}", "detail": login_resp.text}

    login_data = login_resp.json() if login_resp.text else {}
    continue_url = str(login_data.get("continue_url") or "").strip()
    auth_code = ""

    if continue_url and "code=" in continue_url:
        parsed_params = parse_qs(urlparse(continue_url).query)
        auth_code = str((parsed_params.get("code") or [""])[0]).strip()

    # 3. 2FA MFA challenge if needed
    if not auth_code:
        page_info = login_data.get("page", {})
        page_type = str(page_info.get("type") or "")
        if page_type == "mfa_challenge":
            factor_id = page_info.get("payload", {}).get("factor_id", "")
            if not factor_id:
                factors = page_info.get("payload", {}).get("factors", [])
                if factors:
                    factor_id = factors[0].get("id", "")

            if not factor_id:
                return {"ok": False, "error": "mfa_challenge_no_factor_id", "detail": login_data}

            if not totp_secret:
                return {"ok": False, "error": "mfa_challenge_requires_totp_secret", "detail": login_data}

            try:
                totp_code = get_totp(totp_secret)
            except binascii.Error:
                return {"ok": False, "error": "invalid_totp_secret_base32", "detail": "TOTP secret is not valid Base32"}
            except Exception as e:
                return {"ok": False, "error": f"totp_generation_failed: {str(e)}"}

            mfa_headers = dict(login_headers)
            try:
                mfa_sentinel, mfa_sc = build_sentinel_token(session, device_id, "verify_mfa")
                mfa_headers["openai-sentinel-token"] = mfa_sentinel
                if mfa_sc:
                    session.cookies.set("oai-sc", mfa_sc, domain=".openai.com")
            except Exception:
                pass

            mfa_headers["referer"] = f"{auth_base}/mfa-challenge/{factor_id}"

            try:
                mfa_resp = session.post(
                    f"{auth_base}/api/accounts/mfa/verify",
                    headers=mfa_headers,
                    json={
                        "id": factor_id,
                        "type": "totp",
                        "code": totp_code,
                    },
                    timeout=30,
                )
            except Exception as e:
                return {"ok": False, "error": f"mfa_verify_network_error: {str(e)}"}

            if mfa_resp.status_code != 200:
                return {"ok": False, "error": f"mfa_verify_failed_{mfa_resp.status_code}", "detail": mfa_resp.text}

            mfa_data = mfa_resp.json() if mfa_resp.text else {}
            mfa_continue_url = str(mfa_data.get("continue_url") or "").strip()
            if mfa_continue_url and "code=" in mfa_continue_url:
                parsed_params = parse_qs(urlparse(mfa_continue_url).query)
                auth_code = str((parsed_params.get("code") or [""])[0]).strip()

    if not auth_code:
        return {"ok": False, "error": "no_auth_code_obtained", "detail": login_data}

    # 4. Exchange Token
    platform_base = "https://platform.openai.com"
    token_headers = {
        "accept": "*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "auth0-client": platform_auth0_client,
        "cache-control": "no-cache",
        "content-type": "application/json",
        "origin": platform_base,
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": f"{platform_base}/",
        "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": user_agent,
    }
    token_payload = {
        "client_id": platform_oauth_client_id,
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
        "code": auth_code,
        "redirect_uri": platform_oauth_redirect_uri,
    }

    try:
        token_resp = session.post(
            f"{auth_base}/api/accounts/oauth/token",
            headers=token_headers,
            json=token_payload,
            timeout=60,
        )
    except Exception as e:
        return {"ok": False, "error": f"token_exchange_network_error: {str(e)}"}

    if token_resp.status_code != 200:
        return {"ok": False, "error": f"token_exchange_failed_{token_resp.status_code}", "detail": token_resp.text}

    token_data = token_resp.json() if token_resp.text else {}
    access_token = str(token_data.get("access_token") or "").strip()
    if not access_token:
        return {"ok": False, "error": "empty_access_token", "detail": token_data}

    return {
        "ok": True,
        "email": email,
        "password": password,
        "totp_secret": totp_secret,
        "access_token": access_token,
        "refresh_token": str(token_data.get("refresh_token") or "").strip(),
        "id_token": str(token_data.get("id_token") or "").strip(),
        "expires_in": token_data.get("expires_in"),
    }


def parse_credentials(raw_text: str) -> list[tuple[str, str, str, str]]:
    """Parse email----password----2FA[----token] lines."""
    accounts = []
    for line in raw_text.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("==="):
            continue
        parts = [p.strip() for p in line.split("----")]
        if len(parts) < 3:
            parts = [p.strip() for p in line.split("---")]
        if len(parts) >= 4:
            email, pwd, totp, tok = parts[0], parts[1], parts[2], parts[3]
            accounts.append((email, pwd, totp, tok))
        elif len(parts) >= 3:
            email, pwd, totp = parts[0], parts[1], parts[2]
            accounts.append((email, pwd, totp, ""))
        elif len(parts) == 2:
            accounts.append((parts[0], parts[1], "", ""))
    return accounts


def main():
    # Read input from stdin or file
    raw_input = ""
    if len(sys.argv) > 1 and Path(sys.argv[1]).is_file():
        raw_input = Path(sys.argv[1]).read_text(encoding="utf-8")
    else:
        raw_input = sys.stdin.read()

    # Try parsing as JSON first
    accounts_to_auth = []
    custom_proxy = ""
    api_url = ""
    auth_key = ""
    is_json = False

    try:
        data = json.loads(raw_input)
        if isinstance(data, dict):
            is_json = True
            custom_proxy = str(data.get("proxy") or "").strip()
            api_url = str(data.get("api_url") or "").strip()
            auth_key = str(data.get("auth_key") or "").strip()
            raw_accs = data.get("accounts")
            if isinstance(raw_accs, list):
                for item in raw_accs:
                    if isinstance(item, dict):
                        acc_id = str(item.get("id") or "").strip()
                        email = str(item.get("email") or "").strip()
                        password = str(item.get("password") or "").strip()
                        totp = str(item.get("totp_secret") or item.get("auxiliary") or "").strip()
                        if email and password:
                            accounts_to_auth.append({
                                "id": acc_id,
                                "email": email,
                                "password": password,
                                "totp_secret": totp,
                                "access_token": str(item.get("access_token") or item.get("token") or "").strip(),
                                "refresh_token": str(item.get("refresh_token") or "").strip(),
                            })
    except Exception:
        is_json = False

    # If not JSON, parse lines
    if not is_json:
        parsed_lines = parse_credentials(raw_input)
        for acc_tuple in parsed_lines:
            accounts_to_auth.append({
                "id": "",
                "email": acc_tuple[0],
                "password": acc_tuple[1],
                "totp_secret": acc_tuple[2] if len(acc_tuple) > 2 else "",
                "access_token": acc_tuple[3] if len(acc_tuple) > 3 else "",
                "refresh_token": "",
            })

    if not accounts_to_auth:
        output = {"ok": False, "error": "no_valid_accounts", "results": []}
        if is_json:
            print(json.dumps(output, ensure_ascii=False))
        else:
            print("未检测到有效账号信息")
        return

    results = []
    enrolled_items = []
    enrolled_tokens = []

    for acc in accounts_to_auth:
        email = acc["email"]
        password = acc["password"]
        totp = acc["totp_secret"]
        acc_id = acc.get("id") or ""
        given_token = str(acc.get("access_token") or "").strip()
        given_refresh = str(acc.get("refresh_token") or "").strip()

        valid_cached = False
        if given_token:
            payload = parse_jwt_payload(given_token)
            exp = payload.get("exp")
            if exp and isinstance(exp, (int, float)) and exp > time.time() + 60:
                valid_cached = True
                results.append({
                    "id": acc_id,
                    "email": email,
                    "ok": True,
                    "access_token": given_token,
                    "refresh_token": given_refresh,
                    "id_token": "",
                    "expires_in": max(0, int(exp - time.time()))
                })
                enrolled_items.append({
                    "email": email,
                    "password": password,
                    "totp_secret": totp,
                    "access_token": given_token,
                    "refresh_token": given_refresh,
                    "id_token": "",
                    "source_type": "oauth_password_2fa",
                    "type": "oauth"
                })
                enrolled_tokens.append(given_token)

        if not valid_cached:
            res = login_with_password_and_totp(email, password, totp, proxy=custom_proxy)
            if res.get("ok"):
                access_token = res["access_token"]
                refresh_token = res.get("refresh_token") or given_refresh or ""
                id_token = res.get("id_token") or ""
                results.append({
                    "id": acc_id,
                    "email": email,
                    "ok": True,
                    "access_token": access_token,
                    "refresh_token": refresh_token,
                    "id_token": id_token,
                    "expires_in": res.get("expires_in")
                })
                enrolled_items.append({
                    "email": email,
                    "password": password,
                    "totp_secret": totp,
                    "access_token": access_token,
                    "refresh_token": refresh_token,
                    "id_token": id_token,
                    "source_type": "oauth_password_2fa",
                    "type": "oauth"
                })
                enrolled_tokens.append(access_token)
            else:
                results.append({
                    "id": acc_id,
                    "email": email,
                    "ok": False,
                    "error": res.get("error") or "login_failed",
                    "detail": str(res.get("detail") or "")[:200]
                })

    # Optional auto-enroll via API URL
    enroll_summary = None
    if api_url and auth_key and enrolled_items:
        try:
            import urllib.request
            req = urllib.request.Request(
                api_url,
                data=json.dumps({"accounts": enrolled_items, "tokens": enrolled_tokens}).encode("utf-8"),
                headers={"Authorization": f"Bearer {auth_key}", "Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                if resp.status == 200:
                    res_data = json.loads(resp.read().decode("utf-8"))
                    enroll_summary = {
                        "added": res_data.get("added", 0),
                        "skipped": res_data.get("skipped", 0),
                        "refreshed": res_data.get("refreshed", 0),
                        "errors": res_data.get("errors", [])
                    }
        except Exception as e:
            enroll_summary = {"error": str(e)}

    response_data = {
        "ok": True,
        "total": len(accounts_to_auth),
        "results": results,
        "enrolled": enroll_summary
    }

    if is_json:
        print(json.dumps(response_data, ensure_ascii=False))
    else:
        success_cnt = sum(1 for r in results if r.get("ok"))
        print(f"处理完成：共 {len(results)} 个，成功 {success_cnt} 个，失败 {len(results) - success_cnt} 个")
        for r in results:
            if r.get("ok"):
                print(f"  [OK] {r['email']} -> Token 换取成功")
            else:
                print(f"  [FAIL] {r['email']} -> {r.get('error')}")


if __name__ == "__main__":
    main()
