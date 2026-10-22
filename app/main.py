from __future__ import annotations

import base64
import io
import json
import mimetypes
import os
import secrets
import subprocess
import sys
import shutil
import socket
import threading
import webbrowser
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    if Image is None:
        raise ImportError("Pillow is not installed")
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_PREVIEW_AVAILABLE = True
except ImportError:
    # Keep the vault usable if optional image-preview dependencies are missing;
    # the HEIC endpoint reports a clear error instead of crashing app startup.
    HEIF_PREVIEW_AVAILABLE = False
from typing import Any
import unicodedata

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

APP_NAME = "My Private Space"
APP_HOME = Path(os.environ.get("MPS_HOME", Path.home() / ".my-private-space")).expanduser().resolve()
CONFIG_PATH = APP_HOME / "config.me"
STATE_PATH = APP_HOME / "state.me"
STATE_OBFUSCATION = b"mps-state-obfuscation-v1"
LOCKOUT_SECONDS = 300
IDLE_TIMEOUT_SECONDS = 300
MANIFEST_NAME = "manifest.enc"
JOURNAL_NAME = "journal.json"
PASSWORD_CHANGE_JOURNAL = APP_HOME / "password-change-journal.json"
APP_HOME.mkdir(parents=True, exist_ok=True)

app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")

# One process-wide token, rendered only into the same-origin UI and required for API requests.
API_TOKEN = secrets.token_urlsafe(32)
STATE: dict[str, Any] = {"root": None, "key": None, "manifest": None, "unlocked": False, "vaults": [], "active_vault_id": None, "active_vault_label": None, "active_vault_type": "file", "pending_config": None, "last_activity": None}
MUTATION_LOCK = threading.RLock()


def _xor_state(data: bytes) -> bytes:
    return bytes(value ^ STATE_OBFUSCATION[i % len(STATE_OBFUSCATION)] for i, value in enumerate(data))

def _write_login_state(value: dict[str, Any]) -> None:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    atomic_write(STATE_PATH, base64.b64encode(_xor_state(raw)))

def _new_login_state(locked_until: float | None = None) -> dict[str, Any]:
    return {"failed_attempts": 0, "locked_until": locked_until or (time.time() + LOCKOUT_SECONDS)}

def _load_login_state_startup() -> dict[str, Any]:
    try:
        decoded = base64.b64decode(STATE_PATH.read_bytes(), validate=True)
        value = json.loads(_xor_state(decoded).decode("utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("failed_attempts"), int) or value["failed_attempts"] < 0 or not isinstance(value.get("locked_until"), (int, float)):
            raise ValueError("Invalid login state")
        return value
    except Exception:
        value = _new_login_state()
        _write_login_state(value)
        return value

LOGIN_STATE: dict[str, Any] = {}

def login_lockout_remaining() -> int:
    return max(0, int(float(LOGIN_STATE.get("locked_until", 0)) - time.time() + 0.999))

def check_login_lockout() -> None:
    remaining = login_lockout_remaining()
    if remaining > 0:
        raise HTTPException(429, f"Login temporarily locked. Try again in {remaining} seconds.", headers={"Retry-After": str(remaining)})

def record_auth_failure() -> None:
    LOGIN_STATE["failed_attempts"] = int(LOGIN_STATE.get("failed_attempts", 0)) + 1
    if LOGIN_STATE["failed_attempts"] >= 3:
        LOGIN_STATE["locked_until"] = time.time() + LOCKOUT_SECONDS
    _write_login_state(LOGIN_STATE)

def record_auth_success() -> None:
    LOGIN_STATE.update(failed_attempts=0, locked_until=0)
    _write_login_state(LOGIN_STATE)

def expire_session() -> None:
    STATE.update(root=None, key=None, manifest=None, unlocked=False, vaults=[], active_vault_id=None, active_vault_label=None, active_vault_type="file", pending_config=None, last_activity=None)

def touch_session() -> None:
    STATE["last_activity"] = time.monotonic()

def set_directory_hidden(path: Path, hidden: bool) -> bool | None:
    """Hide/unhide a directory using native OS metadata without renaming it.

    Returns True on success, False on an OS-level failure, and None on platforms
    where there is no portable, non-renaming hidden-directory flag.
    """
    path = Path(path)
    try:
        if sys.platform == "darwin":
            # Finder's hidden flag changes metadata only; the directory name/path
            # and all contents remain unchanged.
            subprocess.run(
                ["chflags", "hidden" if hidden else "nohidden", str(path)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            return True
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            get_attributes = kernel32.GetFileAttributesW
            get_attributes.argtypes = [wintypes.LPCWSTR]
            get_attributes.restype = wintypes.DWORD
            set_attributes = kernel32.SetFileAttributesW
            set_attributes.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
            set_attributes.restype = wintypes.BOOL
            attributes = get_attributes(str(path))
            invalid = 0xFFFFFFFF
            if attributes == invalid:
                return False
            hidden_flag = 0x2  # FILE_ATTRIBUTE_HIDDEN
            updated = (attributes | hidden_flag) if hidden else (attributes & ~hidden_flag)
            if updated == 0:
                updated = 0x80  # FILE_ATTRIBUTE_NORMAL
            return bool(set_attributes(str(path), updated))
        # Linux has no universal hidden attribute for directories. Deliberately
        # do not rename to a dot-prefixed path or depend on file-manager metadata.
        return None
    except (OSError, subprocess.SubprocessError, AttributeError, ImportError):
        return False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"), validate=True)


def password_key(password: str) -> bytes:
    """User-requested deterministic transform: NFC -> UTF-8 -> zero-pad/truncate to 32 bytes."""
    raw = unicodedata.normalize("NFC", password).encode("utf-8")
    return raw[:32].ljust(32, b"\x00")


def validate_password(password: str) -> None:
    if len(password) != 8:
        raise HTTPException(400, "Password must contain exactly 8 Unicode characters.")
    if not any(c.isupper() for c in password):
        raise HTTPException(400, "Password must include an uppercase character.")
    if not any(c.islower() for c in password):
        raise HTTPException(400, "Password must include a lowercase character.")
    if not any(c.isdigit() for c in password):
        raise HTTPException(400, "Password must include a number.")
    if not any(not c.isalnum() and not c.isspace() for c in password):
        raise HTTPException(400, "Password must include a special character.")


def encrypt_bytes(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def decrypt_bytes(key: bytes, blob: bytes, aad: bytes) -> bytes:
    if len(blob) < 29:
        raise ValueError("Encrypted data is incomplete.")
    return AESGCM(key).decrypt(blob[:12], blob[12:], aad)


def encrypt_json(key: bytes, value: Any, aad: bytes) -> bytes:
    return encrypt_bytes(key, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), aad)


def decrypt_json(key: bytes, blob: bytes, aad: bytes) -> Any:
    return json.loads(decrypt_bytes(key, blob, aad).decode("utf-8"))


def manifest_path(root: Path) -> Path:
    return root / MANIFEST_NAME


def save_manifest() -> None:
    if not STATE["unlocked"] or STATE["root"] is None or STATE["key"] is None:
        raise HTTPException(423, "Vault is locked.")
    blob = encrypt_json(STATE["key"], STATE["manifest"], b"mps:manifest:v1")
    atomic_write(manifest_path(STATE["root"]), blob)


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-" + secrets.token_hex(5))
    try:
        with open(temp, "xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def recover_password_change_transaction() -> None:
    """Resolve an interrupted password-change transaction before serving requests."""
    if not PASSWORD_CHANGE_JOURNAL.exists():
        return
    try:
        journal = json.loads(PASSWORD_CHANGE_JOURNAL.read_text("utf-8"))
        phase = journal.get("phase")
        records = journal.get("vaults", [])
        if phase == "registry_committed":
            # New key and all new vaults were committed; only cleanup remains.
            for record in records:
                shutil.rmtree(record.get("backup", ""), ignore_errors=True)
                shutil.rmtree(record.get("stage", ""), ignore_errors=True)
        else:
            for record in reversed(records):
                root = Path(record["root"])
                backup = Path(record["backup"])
                stage = Path(record["stage"])
                if backup.exists():
                    if root.exists():
                        failed = root.parent / (".mps-recovery-failed-" + secrets.token_hex(5))
                        shutil.move(str(root), str(failed))
                        shutil.move(str(backup), str(root))
                        shutil.rmtree(failed, ignore_errors=True)
                    else:
                        shutil.move(str(backup), str(root))
                shutil.rmtree(stage, ignore_errors=True)
            config_backup = journal.get("config_backup")
            if config_backup and Path(config_backup).is_file():
                atomic_write(CONFIG_PATH, Path(config_backup).read_bytes())
        config_backup = journal.get("config_backup")
        if config_backup:
            Path(config_backup).unlink(missing_ok=True)
        PASSWORD_CHANGE_JOURNAL.unlink(missing_ok=True)
    except Exception:
        # Fail closed: leave journal and backups for recovery; do not start with a possibly mixed registry.
        raise RuntimeError("An interrupted main-password transaction could not be recovered. Preserve the password-change journal and backup directories and inspect them before restarting.")

recover_password_change_transaction()

LOGIN_STATE.update(_load_login_state_startup())

def save_config(key: bytes, config: dict[str, Any]) -> None:
    """Persist the encrypted shared-password registry; never persist passwords or keys."""
    blob = encrypt_json(key, config, b"mps:config:v1")
    atomic_write(CONFIG_PATH, blob)


def normalize_config(config: dict[str, Any]) -> dict[str, Any]:
    """Validate and canonicalize the current multi-vault registry format."""
    if config.get("version") != 2 or not isinstance(config.get("vaults"), list):
        raise ValueError("Unsupported configuration format")
    seen_ids, seen_labels = set(), set()
    vaults = []
    for v in config["vaults"]:
        if not isinstance(v, dict): raise ValueError("Invalid vault registry entry")
        vid, label, location = v.get("id"), v.get("label"), v.get("location")
        if not all(isinstance(x, str) and x.strip() for x in (vid, label, location)): raise ValueError("Vault ID, label and location are required")
        norm = label.strip().casefold()
        if vid in seen_ids or norm in seen_labels: raise ValueError("Vault IDs and labels must be unique")
        seen_ids.add(vid); seen_labels.add(norm)
        prefix = v.get("prefix", "")
        if not isinstance(prefix, str) or (prefix and not __import__("re").fullmatch(r"[A-Za-z0-9_-]+", prefix)):
            raise ValueError("Invalid vault prefix")
        # Missing visibility settings in older config.me files mean opt-out.
        # Preserve absence on read; opening an old registry must not rewrite it.
        manage_visibility = v.get("manage_visibility", False)
        if not isinstance(manage_visibility, bool):
            raise ValueError("Invalid vault visibility setting")
        vault_type = v.get("type", "file")
        if vault_type not in {"file", "password"}:
            raise ValueError("Invalid vault type")
        normalized = {"id": vid, "label": label.strip(), "location": str(Path(location).expanduser().resolve()), "type": vault_type, **({"prefix": prefix} if prefix else {})}
        if "manage_visibility" in v:
            normalized["manage_visibility"] = manage_visibility
        vaults.append(normalized)
    if not vaults: raise ValueError("No vaults are registered")
    for index, current in enumerate(vaults):
        current_path = Path(current["location"]).resolve()
        for other in vaults[index + 1:]:
            other_path = Path(other["location"]).resolve()
            try: same = os.path.samefile(current_path, other_path)
            except OSError: same = current_path == other_path
            if same or current_path in other_path.parents or other_path in current_path.parents:
                raise ValueError("Registered vault directories must not overlap")
    last = config.get("last_used_vault")
    if last not in seen_ids: last = vaults[0]["id"]
    return {"version": 2, "vaults": vaults, "last_used_vault": last}


def require_unlocked() -> tuple[Path, bytes, dict[str, Any]]:
    if STATE.get("unlocked") and STATE.get("last_activity") is not None and time.monotonic() - STATE["last_activity"] >= IDLE_TIMEOUT_SECONDS:
        expire_session()
    if not STATE["unlocked"] or STATE["root"] is None or STATE["key"] is None or STATE["manifest"] is None:
        raise HTTPException(423, "Vault is locked. Enter the password to continue.")
    # Protected API access must enforce the idle deadline, not silently extend it.
    # The explicit /api/activity endpoint is the only source of activity heartbeats.
    return STATE["root"], STATE["key"], STATE["manifest"]


def entry_path(entry_id: str, manifest: dict[str, Any] | None = None, root: Path | None = None) -> Path:
    if manifest is None:
        manifest = STATE["manifest"]
    if root is None:
        root = STATE["root"]
    if entry_id not in manifest["entries"]:
        raise HTTPException(404, "Item not found.")
    entry = manifest["entries"][entry_id]
    parts = [entry_id]
    parent_id = entry.get("parent_id")
    seen = {entry_id}
    while parent_id is not None:
        if parent_id in seen or parent_id not in manifest["entries"]:
            raise HTTPException(500, "Vault hierarchy is invalid.")
        seen.add(parent_id)
        parts.append(parent_id)
        parent_id = manifest["entries"][parent_id].get("parent_id")
    path = root
    for part in reversed(parts):
        path = path / part
    return path


def allocate_id(manifest: dict[str, Any]) -> str:
    value = int(manifest.get("next_id", 1))
    manifest["next_id"] = value + 1
    return f"{manifest.get('_prefix', '')}{value:04d}"


def active_entry(entry: dict[str, Any]) -> bool:
    return not entry.get("deleted", False)


def descendants(manifest: dict[str, Any], parent_id: str) -> list[str]:
    result: list[str] = []
    todo = [parent_id]
    while todo:
        current = todo.pop()
        children = [eid for eid, e in manifest["entries"].items() if e.get("parent_id") == current]
        result.extend(children)
        todo.extend(children)
    return result


def has_locked_ancestor(manifest: dict[str, Any], entry: dict[str, Any]) -> bool:
    parent_id = entry.get("parent_id")
    while parent_id is not None:
        parent = manifest["entries"].get(parent_id)
        if not parent:
            break
        if parent.get("locked"):
            return True
        parent_id = parent.get("parent_id")
    return False


def public_tree(manifest: dict[str, Any]) -> dict[str, Any]:
    entries = manifest["entries"]
    def build(parent_id: str | None) -> list[dict[str, Any]]:
        result = []
        for eid, entry in entries.items():
            if entry.get("parent_id") != parent_id or not active_entry(entry):
                continue
            if has_locked_ancestor(manifest, entry):
                continue
            item = {"id": eid, "name": entry["name"], "type": entry["type"],
                    "locked": bool(entry.get("locked")), "mime": entry.get("mime", "application/octet-stream"),
                    "size": entry.get("size", 0), "children": []}
            if entry["type"] == "folder" and not entry.get("locked"):
                item["children"] = build(eid)
            result.append(item)
        return sorted(result, key=lambda x: (x["type"] != "folder", x["name"].casefold()))
    return {"items": build(None), "trash_count": sum(1 for e in entries.values() if e.get("deleted")), "vault_type": manifest.get("vault_type", "file")}


def check_password_key(password: str) -> bytes:
    if len(password) != 8:
        raise HTTPException(400, "Enter the same 8-character password used to initialize the vault.")
    return password_key(password)


@app.middleware("http")
async def local_api_guard(request: Request, call_next):
    host = request.headers.get("host", "").split(":")[0].strip("[]").lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        return JSONResponse({"detail": "This application is available only through localhost."}, status_code=403)
    if request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin:
            expected = f"http://{request.headers.get('host')}"
            if origin.rstrip("/").lower() != expected.lower():
                return JSONResponse({"detail": "Cross-origin request blocked."}, status_code=403)
        token = request.headers.get("x-mps-token")
        if token != API_TOKEN:
            return JSONResponse({"detail": "Invalid local session token."}, status_code=403)
        if STATE.get("key") is not None and request.url.path not in {"/api/status", "/api/unlock", "/api/setup"}:
            if STATE.get("last_activity") is not None and time.monotonic() - STATE["last_activity"] >= IDLE_TIMEOUT_SECONDS:
                expire_session()
            # Do not refresh the idle deadline for arbitrary API traffic. Client-side
            # user-activity events report explicitly through /api/activity.
    return await call_next(request)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={"api_token": API_TOKEN, "app_name": APP_NAME})


@app.get("/api/status")
async def status():
    # Status is used during page bootstrap, so it must not revive an expired session.
    if (STATE.get("unlocked") and STATE.get("last_activity") is not None
            and time.monotonic() - STATE["last_activity"] >= IDLE_TIMEOUT_SECONDS):
        expire_session()
    idle_remaining = 0
    if STATE.get("unlocked") and STATE.get("last_activity") is not None:
        idle_remaining = max(0, int(IDLE_TIMEOUT_SECONDS - (time.monotonic() - STATE["last_activity"])))
    return {"configured": CONFIG_PATH.exists(), "unlocked": bool(STATE["unlocked"]), "app_name": APP_NAME, "lockout_remaining": login_lockout_remaining(), "idle_remaining": idle_remaining}


@app.post("/api/activity")
def session_activity():
    if STATE.get("key") is None:
        raise HTTPException(423, "Session expired. Enter the main password to continue.")
    touch_session()
    return {"ok": True}


class SetupRequest(BaseModel):
    target_directory: str = Field(min_length=1, max_length=4096)
    label: str = Field(min_length=1, max_length=80)
    prefix: str = Field(min_length=1, max_length=32)
    manage_visibility: bool = False
    vault_type: str = "file"
    password: str
    confirm_password: str


@app.post("/api/setup")
def setup(payload: SetupRequest):
    with MUTATION_LOCK:
        if CONFIG_PATH.exists():
            raise HTTPException(409, "Configuration already exists. Unlock the existing vault instead.")
        if payload.password != payload.confirm_password:
            raise HTTPException(400, "Passwords do not match.")
        validate_password(payload.password)
        label = payload.label.strip()
        if not label: raise HTTPException(400, "Vault label is required.")
        prefix = payload.prefix.strip()
        if not __import__("re").fullmatch(r"[A-Za-z0-9_-]+", prefix): raise HTTPException(400, "Prefix may contain only letters, digits, hyphens, and underscores.")
        vault_type = payload.vault_type
        if vault_type not in {"file", "password"}:
            raise HTTPException(400, "Choose either a file vault or a password vault.")
        root = Path(payload.target_directory).expanduser().resolve()
        if not root.exists() or not root.is_dir():
            raise HTTPException(400, "Choose an existing directory for the vault.")
        if not os.access(root, os.W_OK):
            raise HTTPException(400, "The selected directory is not writable.")
        # macOS Finder may create .DS_Store in an otherwise empty folder.
        # Ignore only this harmless Finder metadata file; reject all other contents.
        existing_items = [item for item in root.iterdir() if item.name != ".DS_Store"]
        if existing_items:
            names = ", ".join(item.name for item in existing_items[:3])
            suffix = "…" if len(existing_items) > 3 else ""
            raise HTTPException(
                409,
                f"Choose an empty directory. Found existing item(s): {names}{suffix}. "
                "The vault must not be mixed with your other files."
            )
        # Remove Finder metadata before creating the vault if present.
        (root / ".DS_Store").unlink(missing_ok=True)
        key = password_key(payload.password)
        manifest = {"version": 1, "vault_type": vault_type, "next_id": 1, "created_at": now_iso(), "entries": {}}
        blob = encrypt_json(key, manifest, b"mps:manifest:v1")
        atomic_write(manifest_path(root), blob)
        initial_vault = {"id": "vault-" + secrets.token_hex(8), "label": label, "location": str(root), "prefix": prefix, "type": vault_type, "manage_visibility": payload.manage_visibility}
        # The first vault is immediately opened after setup, so persist it as
        # the last-used vault for the first manual/timeout unlock as well.
        initial_config = {"version": 2, "vaults": [initial_vault], "last_used_vault": initial_vault["id"]}
        try:
            save_config(key, initial_config)
            if payload.manage_visibility:
                visibility_result = set_directory_hidden(root, True)
                if visibility_result is not True:
                    raise RuntimeError("Folder visibility management is unavailable on this platform or the folder could not be hidden. Disable the option or check filesystem permissions.")
        except Exception as exc:
            CONFIG_PATH.unlink(missing_ok=True)
            manifest_path(root).unlink(missing_ok=True)
            raise HTTPException(500, f"Vault setup could not be completed safely: {exc}")
        config = normalize_config(decrypt_json(key, CONFIG_PATH.read_bytes(), b"mps:config:v1"))
        manifest["_prefix"] = prefix
        STATE.update(root=root, key=key, manifest=manifest, unlocked=True, vaults=config["vaults"], active_vault_id=config["vaults"][0]["id"], active_vault_label=label, active_vault_type=vault_type, pending_config=None, last_activity=time.monotonic())
        return {"ok": True, "message": "Vault created.", "vault_label": label, "vault_type": vault_type, "vaults": config["vaults"]}


class PasswordRequest(BaseModel):
    password: str
    resume_last_used: bool = False


@app.post("/api/unlock")
def unlock(payload: PasswordRequest):
    with MUTATION_LOCK:
        check_login_lockout()
        if not CONFIG_PATH.exists(): raise HTTPException(409, "Initial setup is required.")
        try:
            key = check_password_key(payload.password)
        except HTTPException:
            record_auth_failure()
            raise
        try:
            raw_config = decrypt_json(key, CONFIG_PATH.read_bytes(), b"mps:config:v1")
            config = normalize_config(raw_config)
            # Resume the last-used vault after a manual or inactivity lock.
            # The vault picker is only needed when there is no valid last-used
            # selection (for example, on first login to a multi-vault registry).
            last_used_id = config.get("last_used_vault")
            v = next((item for item in config["vaults"] if item["id"] == last_used_id), None) if payload.resume_last_used else None
            # Older registries may not have a valid last-used vault recorded.
            # After a lock, resume a valid registered vault instead of leaving
            # the user on the vault-picker path.
            if payload.resume_last_used and v is None and config["vaults"]:
                v = config["vaults"][0]
            if v is not None:
                root = Path(v["location"]).expanduser().resolve()
                if not root.is_dir(): raise HTTPException(404, "The configured vault directory is unavailable. Locate the vault folder before continuing.")
                manifest = decrypt_json(key, manifest_path(root).read_bytes(), b"mps:manifest:v1")
                if manifest.get("version") != 1 or not isinstance(manifest.get("entries"), dict): raise ValueError("Invalid manifest format")
                manifest_type = manifest.get("vault_type", "file")
                if manifest_type != v.get("type", "file"):
                    raise ValueError("Vault type does not match its registry entry")
                config["last_used_vault"] = v["id"]
                if raw_config != config: save_config(key, config)
                manifest["_prefix"] = v.get("prefix", "")
                STATE.update(root=root, key=key, manifest=manifest, unlocked=True, vaults=config["vaults"], active_vault_id=v["id"], active_vault_label=v["label"], active_vault_type=manifest_type, pending_config=None, last_activity=time.monotonic())
                record_auth_success()
                return {"ok": True, "selected": True, "vault_label": v["label"], "vault_type": manifest_type, "vaults": config["vaults"]}
            STATE.update(root=None, key=key, manifest=None, unlocked=False, vaults=config["vaults"], active_vault_id=None, active_vault_label=None, active_vault_type="file", pending_config=config, last_activity=time.monotonic())
            record_auth_success()
            return {"ok": True, "selected": False, "vaults": [{"id": v["id"], "label": v["label"], "location": v["location"], "type": v.get("type", "file")} for v in config["vaults"]]}
        except HTTPException: raise
        except Exception:
            record_auth_failure()
            raise HTTPException(401, "Password incorrect, or the configuration/vault is damaged.")


class SelectVaultRequest(BaseModel):
    vault_id: str = Field(min_length=1, max_length=128)


@app.post("/api/vaults/select")
def select_vault(payload: SelectVaultRequest):
    """Select a vault after login or switch vaults without asking for the password again."""
    with MUTATION_LOCK:
        key = STATE.get("key")
        if key is None:
            raise HTTPException(423, "Enter the main password first.")
        config = STATE.get("pending_config")
        if config is None:
            try:
                config = normalize_config(decrypt_json(key, CONFIG_PATH.read_bytes(), b"mps:config:v1"))
            except Exception:
                raise HTTPException(500, "The vault registry could not be read.")
        vault = next((v for v in config["vaults"] if v["id"] == payload.vault_id), None)
        if not vault:
            raise HTTPException(404, "Vault not found in registry.")
        root = Path(vault["location"]).expanduser().resolve()
        try:
            if not root.is_dir(): raise HTTPException(404, f"Vault '{vault['label']}' is unavailable. Locate or restore its folder.")
            manifest = decrypt_json(key, manifest_path(root).read_bytes(), b"mps:manifest:v1")
            if manifest.get("version") != 1 or not isinstance(manifest.get("entries"), dict): raise ValueError("Invalid manifest")
            manifest_type = manifest.get("vault_type", "file")
            if manifest_type != vault.get("type", "file"):
                raise ValueError("Vault type does not match its registry entry")
        except HTTPException: raise
        except Exception: raise HTTPException(400, f"Vault '{vault['label']}' is invalid or damaged; no files were changed.")
        config["last_used_vault"] = vault["id"]
        save_config(key, config)
        manifest["_prefix"] = vault.get("prefix", "")
        STATE.update(root=root, key=key, manifest=manifest, unlocked=True, vaults=config["vaults"], active_vault_id=vault["id"], active_vault_label=vault["label"], active_vault_type=manifest_type, pending_config=None, last_activity=time.monotonic())
        return {"ok": True, "vault_label": vault["label"], "vault_type": manifest_type, "vaults": config["vaults"]}


@app.post("/api/vaults/remove")
def remove_vault(payload: SelectVaultRequest):
    """Unregister a vault without deleting its encrypted directory or contents."""
    with MUTATION_LOCK:
        key = STATE.get("key")
        if key is None:
            raise HTTPException(423, "Enter the main password first.")
        try:
            config = normalize_config(decrypt_json(key, CONFIG_PATH.read_bytes(), b"mps:config:v1"))
        except Exception:
            raise HTTPException(500, "The vault registry could not be read.")
        vault = next((v for v in config["vaults"] if v["id"] == payload.vault_id), None)
        if not vault:
            raise HTTPException(404, "Vault not found in registry.")
        # Any registered vault can be removed, including the active one. If the
        # active vault is removed while others remain, move the session to a
        # valid remaining vault before committing the registry update.
        remaining_vaults = [v for v in config["vaults"] if v["id"] != payload.vault_id]
        fallback_vault = None
        fallback_root = None
        fallback_manifest = None
        removing_active = payload.vault_id == STATE.get("active_vault_id")
        if removing_active and remaining_vaults:
            preferred_id = config.get("last_used_vault")
            fallback_vault = next((v for v in remaining_vaults if v["id"] == preferred_id), remaining_vaults[0])
            fallback_root = Path(fallback_vault["location"]).expanduser().resolve()
            try:
                if not fallback_root.is_dir():
                    raise ValueError("Vault directory is unavailable")
                fallback_manifest = decrypt_json(key, manifest_path(fallback_root).read_bytes(), b"mps:manifest:v1")
                if fallback_manifest.get("version") != 1 or not isinstance(fallback_manifest.get("entries"), dict):
                    raise ValueError("Invalid manifest")
            except Exception:
                raise HTTPException(400, f"Cannot remove the active vault because remaining vault '{fallback_vault['label']}' is unavailable or damaged.")
        unhide_result = None
        if vault.get("manage_visibility", False):
            unhide_result = set_directory_hidden(Path(vault["location"]), False)
            if unhide_result is not True:
                raise HTTPException(500, "This vault's visibility is managed by My Private Space, but its directory could not be made visible. The vault remains registered; check platform support and filesystem permissions.")
        if len(config["vaults"]) == 1:
            # Unregister the final vault by removing the encrypted registry only;
            # its encrypted directory and contents remain available for recovery.
            try:
                CONFIG_PATH.unlink(missing_ok=False)
            except Exception:
                if unhide_result is True:
                    set_directory_hidden(Path(vault["location"]), True)
                raise HTTPException(500, "The vault could not be unregistered because the registry could not be removed.")
            expire_session()
            return {"ok": True, "vaults": [], "removed_label": vault["label"], "directory_preserved": True, "requires_setup": True}
        config["vaults"] = remaining_vaults
        if removing_active and fallback_vault:
            config["last_used_vault"] = fallback_vault["id"]
        elif config.get("last_used_vault") == payload.vault_id:
            config["last_used_vault"] = STATE.get("active_vault_id") or config["vaults"][0]["id"]
        try:
            save_config(key, config)
        except Exception:
            # Registry update failed: restore the previous visual state where
            # supported, so a still-registered vault does not become visible.
            if unhide_result is True:
                set_directory_hidden(Path(vault["location"]), True)
            raise
        STATE["vaults"] = config["vaults"]
        if removing_active and fallback_vault:
            fallback_manifest["_prefix"] = fallback_vault.get("prefix", "")
            STATE.update(root=fallback_root, manifest=fallback_manifest, unlocked=True,
                         active_vault_id=fallback_vault["id"], active_vault_label=fallback_vault["label"],
                         active_vault_type=fallback_manifest.get("vault_type", "file"), pending_config=None, last_activity=time.monotonic())
        if STATE.get("pending_config") is not None:
            STATE["pending_config"] = config
        return {"ok": True, "vaults": config["vaults"], "removed_label": vault["label"],
                "directory_preserved": True, "active_vault_label": STATE.get("active_vault_label"),
                "active_vault_changed": bool(removing_active and fallback_vault)}


class CreateVaultRequest(BaseModel):
    target_directory: str = Field(min_length=1, max_length=4096)
    label: str = Field(min_length=1, max_length=80)
    prefix: str = Field(min_length=1, max_length=32)
    convert_existing: bool = False
    manage_visibility: bool = False
    vault_type: str = "file"


@app.post("/api/vaults/create")
def create_vault(payload: CreateVaultRequest):
    with MUTATION_LOCK:
        key = STATE.get("key")
        if key is None: raise HTTPException(423, "Enter the main password first.")
        label = payload.label.strip()
        if not label: raise HTTPException(400, "Vault label is required.")
        prefix = payload.prefix.strip()
        if not __import__("re").fullmatch(r"[A-Za-z0-9_-]+", prefix): raise HTTPException(400, "Prefix may contain only letters, digits, hyphens, and underscores.")
        vault_type = payload.vault_type
        if vault_type not in {"file", "password"}: raise HTTPException(400, "Choose either a file vault or a password vault.")
        if vault_type == "password" and payload.convert_existing:
            raise HTTPException(400, "Ordinary folder conversion is only available for file vaults.")
        config = normalize_config(decrypt_json(key, CONFIG_PATH.read_bytes(), b"mps:config:v1"))
        if any(v["label"].casefold() == label.casefold() for v in config["vaults"]): raise HTTPException(409, "A vault with this label already exists.")
        root = Path(payload.target_directory).expanduser().resolve()
        if not root.is_dir(): raise HTTPException(400, "Choose an existing destination directory.")
        if not os.access(root, os.W_OK): raise HTTPException(400, "The selected directory is not writable.")
        # Never initialize or re-register a directory that is already in use by
        # any registered vault. samefile() also catches aliases/symlinks and
        # path spellings that differ only by case on case-insensitive filesystems.
        for registered in config["vaults"]:
            registered_root = Path(registered["location"]).expanduser().resolve()
            try:
                same_directory = os.path.samefile(root, registered_root)
            except OSError:
                same_directory = root == registered_root
            overlaps = (root == registered_root
                        or root in registered_root.parents
                        or registered_root in root.parents)
            if same_directory or overlaps:
                raise HTTPException(409, "This directory overlaps with an already registered vault. Choose a separate directory.")

        manifest_file = manifest_path(root)
        existing_items = [x for x in root.iterdir() if x.name != ".DS_Store"]
        created_new_manifest = False
        conversion_backup: Path | None = None
        if not existing_items:
            # New vault: initialize only when the directory is genuinely empty.
            (root / ".DS_Store").unlink(missing_ok=True)
            manifest = {"version": 1, "vault_type": vault_type, "next_id": 1, "created_at": now_iso(), "entries": {}}
            atomic_write(manifest_file, encrypt_json(key, manifest, b"mps:manifest:v1"))
            created_new_manifest = True
        else:
            # Re-register a previously removed vault without overwriting its encrypted data.
            if not manifest_file.is_file():
                if not payload.convert_existing:
                    if vault_type == "password":
                        raise HTTPException(409, "A new password vault must use an empty directory, or select an existing password-vault directory.")
                    raise HTTPException(409, "This folder contains ordinary files. Confirm conversion to encrypted vault storage to continue; originals are preserved until verification.")
                manifest = {"version": 1, "vault_type": "file", "next_id": 1, "created_at": now_iso(), "entries": {}}
                stage = root.parent / (".mps-convert-" + secrets.token_hex(8))
                backup = root.parent / (".mps-original-" + secrets.token_hex(8))
                try:
                    stage.mkdir()
                    manifest["_prefix"] = prefix
                    for source in sorted(root.rglob("*")):
                        if source == stage or stage in source.parents or source == backup or backup in source.parents:
                            continue
                        if source.name == ".DS_Store": continue
                        rel = source.relative_to(root)
                        if source.is_symlink(): raise ValueError("Symbolic links are not supported during folder conversion")
                        parent_id = None
                        for folder_name in rel.parts[:-1]:
                            found = next((eid for eid,e in manifest["entries"].items() if e.get("parent_id")==parent_id and e.get("name")==folder_name and e.get("type")=="folder"), None)
                            if found is None:
                                found = allocate_id(manifest); manifest["entries"][found] = {"name":folder_name,"type":"folder","parent_id":parent_id,"mime":"inode/directory","size":0,"created_at":now_iso(),"deleted":False,"locked":False}
                                entry_path(found, manifest, stage).mkdir(parents=True, exist_ok=True)
                            parent_id = found
                        if source.is_dir():
                            found = next((eid for eid,e in manifest["entries"].items() if e.get("parent_id")==parent_id and e.get("name")==source.name and e.get("type")=="folder"), None)
                            if found is None:
                                found=allocate_id(manifest); manifest["entries"][found]={"name":source.name,"type":"folder","parent_id":parent_id,"mime":"inode/directory","size":0,"created_at":now_iso(),"deleted":False,"locked":False}
                            entry_path(found, manifest, stage).mkdir(parents=True, exist_ok=True)
                            continue
                        eid=allocate_id(manifest); content=source.read_bytes(); mime=mimetypes.guess_type(source.name)[0] or "application/octet-stream"
                        manifest["entries"][eid]={"name":source.name,"type":"file","parent_id":parent_id,"mime":mime,"size":len(content),"created_at":now_iso(),"deleted":False,"locked":False}
                        physical=entry_path(eid, manifest, stage)
                        physical.parent.mkdir(parents=True, exist_ok=True)
                        atomic_write(physical, encrypt_bytes(key, content, f"mps:file:{eid}:v1".encode()))
                    for eid,e in manifest["entries"].items():
                        if e["type"]=="folder": entry_path(eid, manifest, stage).mkdir(parents=True, exist_ok=True)
                    atomic_write(stage / MANIFEST_NAME, encrypt_json(key, {k:v for k,v in manifest.items() if k != "_prefix"}, b"mps:manifest:v1"))
                    verified=decrypt_json(key,(stage/MANIFEST_NAME).read_bytes(),b"mps:manifest:v1")
                    if verified != {k:v for k,v in manifest.items() if k != "_prefix"}: raise ValueError("Staged manifest verification failed")
                    for eid,e in manifest["entries"].items():
                        if e["type"]=="file": decrypt_bytes(key,entry_path(eid, manifest, stage).read_bytes(),f"mps:file:{eid}:v1".encode())
                    shutil.move(str(root),str(backup)); shutil.move(str(stage),str(root))
                    conversion_backup = backup
                    created_new_manifest=True
                except Exception as exc:
                    if stage.exists(): shutil.rmtree(stage, ignore_errors=True)
                    if backup.exists() and not root.exists(): shutil.move(str(backup),str(root))
                    raise HTTPException(500, f"Folder conversion failed safely: {exc}")
            else:
                try:
                    manifest = decrypt_json(key, manifest_file.read_bytes(), b"mps:manifest:v1")
                    if (not isinstance(manifest, dict) or manifest.get("version") != 1
                            or not isinstance(manifest.get("entries"), dict)
                            or not isinstance(manifest.get("next_id"), int)):
                        raise ValueError("Invalid manifest structure")
                    manifest_type = manifest.get("vault_type", "file")
                    if manifest_type != vault_type:
                        raise ValueError("Requested vault type does not match existing vault")
                    manifest["vault_type"] = manifest_type
                    entries = manifest["entries"]
                    expected_top = {eid for eid, entry in entries.items()
                                    if isinstance(entry, dict) and entry.get("parent_id") is None}
                    allowed = {MANIFEST_NAME, ".DS_Store"} | expected_top
                    actual = {x.name for x in root.iterdir()}
                    if actual - allowed:
                        raise ValueError("Unexpected files beside the vault manifest")
                    for eid in expected_top:
                        entry = entries[eid]
                        physical = root / eid
                        if not physical.exists() or (entry.get("type") == "folder") != physical.is_dir():
                            raise ValueError("Vault content does not match its manifest")
                    allowed_entry_types = {"file", "folder"} if vault_type == "file" else {"password"}
                    if any(not isinstance(eid, str) or not __import__("re").fullmatch(r"[A-Za-z0-9_-]+", eid) or not isinstance(entry, dict)
                           or entry.get("type") not in allowed_entry_types
                           for eid, entry in entries.items()):
                        raise ValueError("Invalid entry metadata")
                    for eid, entry in entries.items():
                        physical = entry_path(eid, manifest, root)
                        if entry["type"] == "folder":
                            if not physical.is_dir(): raise ValueError("Missing physical folder")
                        else:
                            if not physical.is_file(): raise ValueError("Missing physical file")
                            if not entry.get("locked") and not entry.get("hidden_by"):
                                aad = f"mps:password:{eid}:v1".encode() if entry.get("type") == "password" else f"mps:file:{eid}:v1".encode()
                                decrypt_bytes(key, physical.read_bytes(), aad)
                except Exception:
                    raise HTTPException(409, "This folder contains data that could not be verified as a vault for the current main password. Nothing was changed.")

        vault = {"id": "vault-" + secrets.token_hex(8), "label": label, "location": str(root), "prefix": prefix, "type": vault_type, "manage_visibility": payload.manage_visibility}
        config["vaults"].append(vault); config["last_used_vault"] = vault["id"]
        try:
            save_config(key, config)
            if payload.manage_visibility:
                visibility_result = set_directory_hidden(root, True)
                if visibility_result is not True:
                    raise RuntimeError("Folder visibility management is unavailable on this platform or the folder could not be hidden. Disable the option or check filesystem permissions.")
        except Exception:
            if conversion_backup is not None and conversion_backup.exists():
                try:
                    failed_conversion = root.parent / (".mps-conversion-failed-" + secrets.token_hex(5))
                    if root.exists(): shutil.move(str(root), str(failed_conversion))
                    shutil.move(str(conversion_backup), str(root))
                    shutil.rmtree(failed_conversion, ignore_errors=True)
                except Exception:
                    # Keep both locations for manual recovery rather than deleting either copy.
                    pass
            elif created_new_manifest:
                manifest_file.unlink(missing_ok=True)
            # Restore the prior registry if the save succeeded but visibility
            # control failed. Keep the original config's missing flags missing.
            try:
                save_config(key, {"version": 2, "vaults": [v for v in config["vaults"] if v["id"] != vault["id"]], "last_used_vault": STATE.get("active_vault_id") or config.get("last_used_vault")})
            except Exception:
                pass
            raise
        if conversion_backup is not None:
            shutil.rmtree(conversion_backup, ignore_errors=True)
        manifest["_prefix"] = prefix
        STATE.update(root=root, key=key, manifest=manifest, unlocked=True, vaults=config["vaults"], active_vault_id=vault["id"], active_vault_label=label, active_vault_type=vault_type, pending_config=None, last_activity=time.monotonic())
        return {"ok": True, "vault_label": label, "vault_type": vault_type, "vaults": config["vaults"], "reused_existing_vault": not created_new_manifest}


@app.post("/api/lock")
def lock_vault():
    expire_session()
    return {"ok": True}


@app.get("/api/tree")
def get_tree():
    _, _, manifest = require_unlocked()
    return public_tree(manifest)


@app.get("/api/trash")
def get_trash():
    _, _, manifest = require_unlocked()
    items = []
    for eid, entry in manifest["entries"].items():
        if entry.get("deleted") and entry.get("deleted_root", eid) == eid:
            items.append({"id": eid, "name": entry.get("name", "Deleted item"), "type": entry["type"], "deleted_at": entry.get("deleted_at")})
    return {"items": sorted(items, key=lambda x: x.get("deleted_at", ""), reverse=True)}


@app.get("/api/entries/{entry_id}/preview")
def preview(entry_id: str):
    root, key, manifest = require_unlocked()
    entry = manifest["entries"].get(entry_id)
    if not entry or entry.get("deleted"):
        raise HTTPException(404, "Item not found.")
    if entry["type"] != "file":
        raise HTTPException(400, "Only files can use the file preview endpoint.")
    if entry.get("locked") or has_locked_ancestor(manifest, entry):
        raise HTTPException(423, "This item is locked.")
    try:
        data = decrypt_bytes(key, entry_path(entry_id, manifest, root).read_bytes(), f"mps:file:{entry_id}:v1".encode())
    except Exception:
        raise HTTPException(500, "The file could not be decrypted. The vault may be damaged.")
    mime = entry.get("mime") or "application/octet-stream"
    suffix = Path(entry.get("name", "")).suffix.lower()
    # Browsers do not consistently decode HEIC/HEIF. Convert decrypted image bytes
    # to JPEG for preview only; the encrypted original remains unchanged in the vault.
    if suffix in {".heic", ".heif"} or mime.lower() in {"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"}:
        if not HEIF_PREVIEW_AVAILABLE:
            raise HTTPException(415, "HEIC/HEIF preview requires the pillow-heif package. Install the application dependencies and restart My Private Space.")
        try:
            with Image.open(io.BytesIO(data)) as source_image:
                image = source_image.convert("RGB")
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=92, optimize=True)
                data = output.getvalue()
            mime = "image/jpeg"
        except Exception:
            raise HTTPException(415, "This HEIC/HEIF image could not be decoded for preview. The encrypted original is unchanged.")
    # Never render active HTML or SVG as same-origin active content.
    if mime in {"text/html", "application/xhtml+xml", "image/svg+xml"}:
        mime = "text/plain; charset=utf-8"
    headers = {"Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; sandbox"}
    return Response(content=data, media_type=mime, headers=headers)


@app.post("/api/import/files")
async def import_files(parent_id: str = Form(default=""), relative_paths: str = Form(default="[]"), files: list[UploadFile] = File(...)):
    with MUTATION_LOCK:
        root, key, manifest = require_unlocked()
        if manifest.get("vault_type", "file") != "file":
            raise HTTPException(400, "File and folder imports are available only in file vaults.")
        parent = parent_id or None
        if parent is not None:
            p = manifest["entries"].get(parent)
            if not p or p["type"] != "folder" or p.get("deleted") or p.get("locked") or has_locked_ancestor(manifest, p):
                raise HTTPException(400, "Choose an accessible, unlocked destination folder.")
        try:
            paths = json.loads(relative_paths)
            if not isinstance(paths, list) or len(paths) != len(files):
                paths = [f.filename or "Imported file" for f in files]
        except Exception:
            paths = [f.filename or "Imported file" for f in files]
        # Plan the hierarchy first. Every mutation is persisted only after the complete import succeeds.
        old_manifest = json.loads(json.dumps(manifest))
        created_paths: list[Path] = []
        folder_ids: dict[tuple[str | None, str], str] = {}
        try:
            for upload, rel in zip(files, paths):
                rel_path = Path(str(rel).replace("\\", "/"))
                safe_parts = [part for part in rel_path.parts if part not in {"", ".", "..", "/"}]
                if not safe_parts:
                    safe_parts = [Path(upload.filename or "Imported file").name or "Imported file"]
                current_parent = parent
                for folder_name in safe_parts[:-1]:
                    folder_key = (current_parent, folder_name)
                    if folder_key not in folder_ids:
                        existing = next((eid for eid, e in manifest["entries"].items() if e.get("parent_id") == current_parent and e.get("name") == folder_name and e["type"] == "folder" and not e.get("deleted")), None)
                        if existing:
                            current_parent = existing
                        else:
                            eid = allocate_id(manifest)
                            entry = {"name": folder_name, "type": "folder", "parent_id": current_parent, "mime": "inode/directory", "size": 0, "created_at": now_iso(), "deleted": False, "locked": False}
                            manifest["entries"][eid] = entry
                            path = entry_path(eid, manifest, root)
                            path.mkdir(parents=True, exist_ok=False)
                            created_paths.append(path)
                            folder_ids[folder_key] = eid
                            current_parent = eid
                    else:
                        current_parent = folder_ids[folder_key]
                name = Path(safe_parts[-1]).name
                content = await upload.read()
                eid = allocate_id(manifest)
                mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                if Path(name).suffix.lower() == ".heic":
                    mime = "image/heic"
                elif Path(name).suffix.lower() == ".heif":
                    mime = "image/heif"
                entry = {"name": name, "type": "file", "parent_id": current_parent, "mime": mime, "size": len(content), "created_at": now_iso(), "deleted": False, "locked": False}
                manifest["entries"][eid] = entry
                path = entry_path(eid, manifest, root)
                path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(path, encrypt_bytes(key, content, f"mps:file:{eid}:v1".encode()))
                created_paths.append(path)
            save_manifest()
        except Exception as exc:
            STATE["manifest"] = old_manifest
            for path in reversed(created_paths):
                try:
                    if path.is_dir(): shutil.rmtree(path)
                    else: path.unlink(missing_ok=True)
                except OSError:
                    pass
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(500, f"Import failed and was rolled back: {exc}")
        return {"ok": True, "imported": len(files)}


class PasswordEntryRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    value: str = Field(min_length=1, max_length=10000)


def require_password_vault() -> tuple[Path, bytes, dict[str, Any]]:
    root, key, manifest = require_unlocked()
    if manifest.get("vault_type", "file") != "password":
        raise HTTPException(400, "Password entries are available only in password vaults.")
    return root, key, manifest


def require_password_entry(entry_id: str, manifest: dict[str, Any]) -> dict[str, Any]:
    entry = manifest["entries"].get(entry_id)
    if not entry or entry.get("deleted") or entry.get("type") != "password":
        raise HTTPException(404, "Password entry not found.")
    return entry


@app.post("/api/passwords")
def create_password_entry(payload: PasswordEntryRequest):
    with MUTATION_LOCK:
        root, key, manifest = require_password_vault()
        name = payload.name.strip()
        if not name or not payload.value:
            raise HTTPException(400, "A name and password value are required.")
        old_manifest = json.loads(json.dumps(manifest))
        entry_id = allocate_id(manifest)
        entry = {"name": name, "type": "password", "parent_id": None, "mime": "application/x-mps-password", "size": len(payload.value.encode("utf-8")), "created_at": now_iso(), "deleted": False, "locked": False}
        manifest["entries"][entry_id] = entry
        path = entry_path(entry_id, manifest, root)
        try:
            atomic_write(path, encrypt_bytes(key, payload.value.encode("utf-8"), f"mps:password:{entry_id}:v1".encode()))
            save_manifest()
        except Exception as exc:
            STATE["manifest"] = old_manifest
            path.unlink(missing_ok=True)
            if isinstance(exc, HTTPException): raise
            raise HTTPException(500, f"Could not save password entry: {exc}")
        return {"ok": True, "id": entry_id, "name": name}


@app.get("/api/passwords/{entry_id}/reveal")
def reveal_password_entry(entry_id: str):
    root, key, manifest = require_password_vault()
    entry = require_password_entry(entry_id, manifest)
    try:
        value = decrypt_bytes(key, entry_path(entry_id, manifest, root).read_bytes(), f"mps:password:{entry_id}:v1".encode()).decode("utf-8")
    except Exception:
        raise HTTPException(500, "This password entry could not be decrypted; the vault may be damaged.")
    return JSONResponse({"id": entry_id, "name": entry["name"], "value": value}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@app.put("/api/passwords/{entry_id}")
def update_password_entry(entry_id: str, payload: PasswordEntryRequest):
    with MUTATION_LOCK:
        root, key, manifest = require_password_vault()
        entry = require_password_entry(entry_id, manifest)
        name = payload.name.strip()
        if not name or not payload.value:
            raise HTTPException(400, "A name and password value are required.")
        path = entry_path(entry_id, manifest, root)
        old_blob = path.read_bytes()
        old_name, old_size = entry["name"], entry.get("size", 0)
        try:
            atomic_write(path, encrypt_bytes(key, payload.value.encode("utf-8"), f"mps:password:{entry_id}:v1".encode()))
            entry["name"] = name
            entry["size"] = len(payload.value.encode("utf-8"))
            save_manifest()
        except Exception as exc:
            atomic_write(path, old_blob)
            entry["name"], entry["size"] = old_name, old_size
            if isinstance(exc, HTTPException): raise
            raise HTTPException(500, f"Could not update password entry: {exc}")
        return {"ok": True, "id": entry_id, "name": name}


class EntryAction(BaseModel):
    password: str | None = None
    destination_parent_id: str | None = None
    confirm: bool = False


def reencrypt_entry_file(root: Path, old_key: bytes, new_key: bytes, entry_id: str, manifest: dict[str, Any]) -> None:
    entry = manifest["entries"][entry_id]
    if entry["type"] not in {"file", "password"}:
        return
    path = entry_path(entry_id, manifest, root)
    aad = f"mps:password:{entry_id}:v1".encode() if entry["type"] == "password" else f"mps:file:{entry_id}:v1".encode()
    plain = decrypt_bytes(old_key, path.read_bytes(), aad)
    atomic_write(path, encrypt_bytes(new_key, plain, aad))


@app.post("/api/entries/{entry_id}/lock")
def lock_entry(entry_id: str, payload: EntryAction):
    with MUTATION_LOCK:
        root, main_key, manifest = require_unlocked()
        entry = manifest["entries"].get(entry_id)
        if not entry or entry.get("deleted"):
            raise HTTPException(404, "Item not found.")
        if entry.get("type") == "password":
            raise HTTPException(400, "Password entries are protected by the main vault password and cannot use secondary item locks.")
        if entry.get("locked") or has_locked_ancestor(manifest, entry):
            raise HTTPException(409, "Item is already locked or inside a locked folder.")
        if not payload.password or len(payload.password) != 8:
            raise HTTPException(400, "Enter a secondary password of exactly 8 characters.")
        if entry["type"] == "folder":
            affected = [entry_id] + descendants(manifest, entry_id)
            if any(manifest["entries"][x].get("locked") or manifest["entries"][x].get("locked_meta") for x in affected):
                raise HTTPException(409, "Unlock nested items before locking this folder.")
        else:
            affected = [entry_id]
        secondary_key = password_key(payload.password)
        old_manifest = json.loads(json.dumps(manifest))
        changed_files: list[tuple[Path, bytes]] = []
        try:
            for eid in affected:
                item = manifest["entries"][eid]
                metadata = {"name": item["name"], "mime": item.get("mime", "application/octet-stream"), "size": item.get("size", 0)}
                item["locked_meta"] = b64(encrypt_json(secondary_key, metadata, f"mps:locked-meta:{eid}:v1".encode()))
                item["name"] = "Locked folder" if item["type"] == "folder" and eid == entry_id else ("Locked file" if item["type"] == "file" and eid == entry_id else "Locked item")
                item["mime"] = "application/octet-stream"
                if eid != entry_id:
                    item["hidden_by"] = entry_id
                if item["type"] == "file":
                    path = entry_path(eid, manifest, root)
                    old_blob = path.read_bytes()
                    changed_files.append((path, old_blob))
                    plain = decrypt_bytes(main_key, old_blob, f"mps:file:{eid}:v1".encode())
                    atomic_write(path, encrypt_bytes(secondary_key, plain, f"mps:file:{eid}:v1".encode()))
            entry["locked"] = True
            entry["lock_scope"] = affected
            save_manifest()
        except Exception as exc:
            STATE["manifest"] = old_manifest
            for path, blob in changed_files:
                try: atomic_write(path, blob)
                except OSError: pass
            if isinstance(exc, HTTPException): raise
            raise HTTPException(500, f"Could not lock item: {exc}")
        return {"ok": True}


@app.post("/api/entries/{entry_id}/unlock")
def unlock_entry(entry_id: str, payload: EntryAction):
    with MUTATION_LOCK:
        check_login_lockout()
        root, main_key, manifest = require_unlocked()
        entry = manifest["entries"].get(entry_id)
        if not entry or entry.get("deleted") or not entry.get("locked"):
            raise HTTPException(404, "Locked item not found.")
        if not payload.password or len(payload.password) != 8:
            raise HTTPException(400, "Enter the secondary password of exactly 8 characters.")
        secondary_key = password_key(payload.password)
        affected = entry.get("lock_scope", [entry_id])
        old_manifest = json.loads(json.dumps(manifest))
        changed_files: list[tuple[Path, bytes]] = []
        try:
            # Validate the password against the locked entry metadata before changing anything.
            root_meta = decrypt_json(secondary_key, unb64(entry["locked_meta"]), f"mps:locked-meta:{entry_id}:v1".encode())
            for eid in affected:
                item = manifest["entries"][eid]
                metadata = decrypt_json(secondary_key, unb64(item["locked_meta"]), f"mps:locked-meta:{eid}:v1".encode())
                if item["type"] == "file":
                    path = entry_path(eid, manifest, root)
                    old_blob = path.read_bytes()
                    changed_files.append((path, old_blob))
                    plain = decrypt_bytes(secondary_key, old_blob, f"mps:file:{eid}:v1".encode())
                    atomic_write(path, encrypt_bytes(main_key, plain, f"mps:file:{eid}:v1".encode()))
                item["name"] = metadata["name"]
                item["mime"] = metadata["mime"]
                item["size"] = metadata["size"]
                item.pop("locked_meta", None)
                item.pop("hidden_by", None)
            entry["locked"] = False
            entry.pop("lock_scope", None)
            entry.pop("lock_scope", None)
            save_manifest()
        except Exception as exc:
            STATE["manifest"] = old_manifest
            for path, blob in changed_files:
                try: atomic_write(path, blob)
                except OSError: pass
            record_auth_failure()
            raise HTTPException(401, "Secondary password incorrect, or locked data is damaged.")
        record_auth_success()
        return {"ok": True, "name": root_meta.get("name")}


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: str):
    with MUTATION_LOCK:
        _, _, manifest = require_unlocked()
        entry = manifest["entries"].get(entry_id)
        if not entry or entry.get("deleted"):
            raise HTTPException(404, "Item not found.")
        ids = [entry_id] + descendants(manifest, entry_id) if entry["type"] == "folder" else [entry_id]
        stamp = now_iso()
        for eid in ids:
            manifest["entries"][eid]["deleted"] = True
            manifest["entries"][eid]["deleted_at"] = stamp
            manifest["entries"][eid]["deleted_root"] = entry_id
        save_manifest()
        return {"ok": True}


class ExportRequest(BaseModel):
    destination_directory: str = Field(min_length=1, max_length=4096)
    overwrite_existing: bool = False
    delete_from_vault: bool = False


def _safe_export_name(name: str) -> str:
    # Names are metadata, never allow path traversal outside the chosen destination.
    cleaned = str(name).replace("\\", "/").split("/")[-1]
    if cleaned in {"", ".", ".."} or "\x00" in cleaned:
        raise HTTPException(400, "An item has an invalid name and cannot be restored.")
    return cleaned


def _export_plan(entry_id: str, manifest: dict[str, Any], root: Path, key: bytes, stage_root: Path) -> list[tuple[Path, Path, str]]:
    """Decrypt an entry/subtree into a private staging directory before touching destination."""
    planned: list[tuple[Path, Path, str]] = []
    ids = [entry_id] + descendants(manifest, entry_id) if manifest["entries"][entry_id]["type"] == "folder" else [entry_id]
    base_entry = manifest["entries"][entry_id]
    if base_entry.get("locked") or has_locked_ancestor(manifest, base_entry):
        raise HTTPException(423, "Unlock this item and any locked parent before restoring it.")
    stage_base = stage_root / _safe_export_name(base_entry["name"])
    for eid in ids:
        item = manifest["entries"][eid]
        if item.get("deleted") and item.get("deleted_root", eid) != entry_id:
            continue
        if item.get("locked") or has_locked_ancestor(manifest, item):
            raise HTTPException(423, "Unlock all locked items in this folder before restoring it.")
        relative_parts = []
        current = item
        while current.get("parent_id") is not None and current.get("parent_id") != manifest["entries"][entry_id].get("parent_id"):
            relative_parts.append(_safe_export_name(current["name"]))
            current = manifest["entries"].get(current.get("parent_id"), {})
            if not current:
                raise HTTPException(500, "Vault hierarchy is invalid.")
        if eid == entry_id:
            rel = Path()
        else:
            rel = Path(*reversed(relative_parts))
        staged = stage_base / rel if rel != Path() else stage_base
        if item["type"] == "folder":
            staged.mkdir(parents=True, exist_ok=True)
            planned.append((staged, Path(), "folder"))
        else:
            staged.parent.mkdir(parents=True, exist_ok=True)
            try:
                plain = decrypt_bytes(key, entry_path(eid, manifest, root).read_bytes(), f"mps:file:{eid}:v1".encode())
            except Exception:
                raise HTTPException(500, f"Could not decrypt '{item.get('name', 'file')}'. No vault items were removed.")
            atomic_write(staged, plain)
            planned.append((staged, rel, "file"))
    return planned


@app.post("/api/entries/{entry_id}/export")
def export_entry(entry_id: str, payload: ExportRequest):
    """Restore decrypted copy outside the vault, with conflict handling and optional source removal."""
    with MUTATION_LOCK:
        root, key, manifest = require_unlocked()
        entry = manifest["entries"].get(entry_id)
        if not entry or entry.get("deleted"):
            raise HTTPException(404, "Active vault item not found.")
        if entry.get("type") == "password":
            raise HTTPException(400, "Password entries cannot be exported as files.")
        destination = Path(payload.destination_directory).expanduser().resolve()
        if not destination.exists() or not destination.is_dir():
            raise HTTPException(400, "Choose an existing destination directory.")
        if not os.access(destination, os.W_OK):
            raise HTTPException(400, "The destination directory is not writable.")
        try:
            if destination == root or root in destination.parents or destination in root.parents:
                raise HTTPException(400, "Choose a destination outside the vault directory.")
        except OSError:
            raise HTTPException(400, "The destination directory is invalid.")
        # Use a temporary staging directory so all vault data is decrypted and validated first.
        stage = destination / (".mps-restore-" + secrets.token_hex(8))
        target = destination / _safe_export_name(entry["name"])
        ids = [entry_id] + descendants(manifest, entry_id) if entry["type"] == "folder" else [entry_id]
        try:
            stage.mkdir(mode=0o700)
            _export_plan(entry_id, manifest, root, key, stage)
            staged_root = stage / _safe_export_name(entry["name"])
            if target.exists() and not payload.overwrite_existing:
                raise HTTPException(409, f"'{target.name}' already exists. Enable 'Overwrite existing' to replace conflicting items.")
            # Preflight all conflicts before changing the destination. For folder-to-folder
            # restores, merge recursively so unrelated destination files are preserved.
            conflicts: list[Path] = []
            def scan_conflicts(src: Path, dst: Path) -> None:
                if not dst.exists():
                    return
                if src.is_dir() and dst.is_dir():
                    for child in src.iterdir(): scan_conflicts(child, dst / child.name)
                else:
                    conflicts.append(dst)
            scan_conflicts(staged_root, target)
            if conflicts and not payload.overwrite_existing:
                first = conflicts[0]
                raise HTTPException(409, f"'{first.name}' already exists. Enable 'Overwrite existing' to replace conflicting items.")
            backup_root = stage / "__previous_destination__"
            backups: list[tuple[Path, Path]] = []
            created: list[Path] = []
            def merge_restore(src: Path, dst: Path, relative: Path = Path()) -> None:
                if src.is_dir():
                    if dst.exists() and not dst.is_dir():
                        backup = backup_root / relative
                        backup.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(dst, backup); backups.append((backup, dst))
                    if not dst.exists():
                        dst.mkdir(parents=True, exist_ok=False); created.append(dst)
                    for child in src.iterdir():
                        merge_restore(child, dst / child.name, relative / child.name)
                else:
                    if dst.exists():
                        backup = backup_root / relative
                        backup.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(dst, backup); backups.append((backup, dst))
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(src, dst); created.append(dst)
            try:
                merge_restore(staged_root, target, Path(target.name))
            except Exception:
                for path in reversed(created):
                    try:
                        if path.is_dir(): path.rmdir()
                        else: path.unlink(missing_ok=True)
                    except OSError: pass
                for backup, original in reversed(backups):
                    try:
                        original.parent.mkdir(parents=True, exist_ok=True)
                        if original.exists() and original.is_dir(): shutil.rmtree(original)
                        elif original.exists(): original.unlink()
                        os.replace(backup, original)
                    except OSError: pass
                raise
            if payload.delete_from_vault:
                # This option is recoverable: mark the encrypted source as deleted so
                # it appears in Deleted Items, rather than physically deleting it.
                old_manifest = json.loads(json.dumps(manifest))
                stamp = now_iso()
                try:
                    for eid in ids:
                        manifest["entries"][eid]["deleted"] = True
                        manifest["entries"][eid]["deleted_at"] = stamp
                        manifest["entries"][eid]["deleted_root"] = entry_id
                    save_manifest()
                except Exception:
                    STATE["manifest"] = old_manifest
                    raise HTTPException(500, "Files were restored, but moving the vault copy to Deleted Items failed. The encrypted vault copy was preserved; verify the vault before retrying.")
            return {"ok": True, "destination": str(target), "moved_to_trash": payload.delete_from_vault}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(500, f"Restore failed: {exc}")
        finally:
            shutil.rmtree(stage, ignore_errors=True)


@app.post("/api/entries/{entry_id}/restore")
def restore_entry(entry_id: str, payload: EntryAction):
    with MUTATION_LOCK:
        _, _, manifest = require_unlocked()
        entry = manifest["entries"].get(entry_id)
        if not entry or not entry.get("deleted") or entry.get("deleted_root", entry_id) != entry_id:
            raise HTTPException(404, "Deleted item not found.")
        explicit_destination = payload.destination_parent_id is not None
        destination = payload.destination_parent_id if explicit_destination else entry.get("parent_id")
        if destination is not None:
            parent = manifest["entries"].get(destination)
            parent_is_usable = bool(parent and parent.get("type") == "folder" and not parent.get("deleted") and not parent.get("locked") and not has_locked_ancestor(manifest, parent))
            if not parent_is_usable:
                if explicit_destination:
                    raise HTTPException(400, "Choose an existing, active, unlocked destination folder.")
                destination = None  # Original parent is unavailable; restore to vault root.
        ids = [entry_id] + descendants(manifest, entry_id) if entry["type"] == "folder" else [entry_id]
        entry["parent_id"] = destination
        for eid in ids:
            manifest["entries"][eid]["deleted"] = False
            manifest["entries"][eid].pop("deleted_at", None)
            manifest["entries"][eid].pop("deleted_root", None)
        save_manifest()
        return {"ok": True}


@app.delete("/api/trash/{entry_id}")
def permanently_delete(entry_id: str, confirm: bool = False):
    with MUTATION_LOCK:
        root, _, manifest = require_unlocked()
        entry = manifest["entries"].get(entry_id)
        if not entry or not entry.get("deleted") or entry.get("deleted_root", entry_id) != entry_id:
            raise HTTPException(404, "Deleted item not found.")
        if not confirm:
            raise HTTPException(400, "Explicit confirmation is required.")
        ids = [entry_id] + descendants(manifest, entry_id) if entry["type"] == "folder" else [entry_id]
        # Delete physical paths deepest-first, then commit manifest.
        for eid in sorted(ids, key=lambda x: len(entry_path(x, manifest, root).parts), reverse=True):
            path = entry_path(eid, manifest, root)
            try:
                if path.is_dir(): shutil.rmtree(path)
                else: path.unlink(missing_ok=True)
            except OSError as exc:
                raise HTTPException(500, f"Could not permanently delete item: {exc}")
        for eid in ids:
            manifest["entries"].pop(eid, None)
        save_manifest()
        return {"ok": True}


@app.get("/api/settings")
def get_settings():
    root, _, manifest = require_unlocked()
    return {"theme": "light-navy", "target_directory": str(root), "vault_label": STATE.get("active_vault_label", ""), "vault_type": manifest.get("vault_type", "file"), "prefix": next((v.get("prefix", "") for v in STATE.get("vaults", []) if v["id"] == STATE.get("active_vault_id")), ""), "vaults": STATE.get("vaults", [])}


class TargetDirectoryRequest(BaseModel):
    target_directory: str = Field(min_length=1, max_length=4096)


@app.post("/api/settings/target")
def change_target_directory(payload: TargetDirectoryRequest):
    with MUTATION_LOCK:
        old_root, key, manifest = require_unlocked()
        destination = Path(payload.target_directory).expanduser().resolve()
        if not destination.exists() or not destination.is_dir():
            raise HTTPException(400, "Choose an existing destination directory.")
        if destination == old_root:
            return {"ok": True, "message": "Vault location is unchanged."}
        if old_root in destination.parents or destination in old_root.parents:
            raise HTTPException(400, "The source and destination vault directories cannot contain one another.")
        try:
            registry = normalize_config(decrypt_json(key, CONFIG_PATH.read_bytes(), b"mps:config:v1"))
        except Exception:
            raise HTTPException(500, "The vault registry could not be read; relocation was not started.")
        for registered in registry["vaults"]:
            if registered["id"] == STATE.get("active_vault_id"):
                continue
            other_root = Path(registered["location"]).resolve()
            if destination == other_root or destination in other_root.parents or other_root in destination.parents:
                raise HTTPException(409, "The destination overlaps another registered vault directory.")
        if any(destination.iterdir()):
            raise HTTPException(409, "Choose an empty destination directory.")
        staging = destination.parent / (".mps-copy-" + secrets.token_hex(8))
        try:
            shutil.copytree(old_root, staging)
            # Byte-for-byte verification, followed by authenticated manifest verification.
            source_files = sorted(p.relative_to(old_root).as_posix() for p in old_root.rglob("*") if p.is_file())
            copied_files = sorted(p.relative_to(staging).as_posix() for p in staging.rglob("*") if p.is_file())
            if source_files != copied_files:
                raise RuntimeError("Copied vault file list does not match the source.")
            for rel in source_files:
                if (old_root / rel).read_bytes() != (staging / rel).read_bytes():
                    raise RuntimeError(f"Verification failed for {rel}.")
            copied_manifest = decrypt_json(key, manifest_path(staging).read_bytes(), b"mps:manifest:v1")
            if copied_manifest != manifest:
                raise RuntimeError("Copied manifest does not match the active vault.")
            for child in list(staging.iterdir()):
                target = destination / child.name
                if target.exists():
                    raise RuntimeError(f"Destination collision: {child.name}")
                shutil.move(str(child), str(target))
            staging.rmdir()
            # Switch the encrypted bootstrap config only after the copy is verified.
            config = normalize_config(decrypt_json(key, CONFIG_PATH.read_bytes(), b"mps:config:v1"))
            active_vault = next((v for v in config["vaults"] if v["id"] == STATE.get("active_vault_id")), None)
            if active_vault is None:
                raise RuntimeError("The active vault is missing from the registry.")
            if active_vault.get("manage_visibility", False):
                visibility_result = set_directory_hidden(destination, True)
                if visibility_result is not True:
                    raise RuntimeError("This vault is configured to manage folder visibility, but the destination could not be hidden.")
            for v in config["vaults"]:
                if v["id"] == STATE.get("active_vault_id"): v["location"] = str(destination)
            save_config(key, config)
            STATE["root"] = destination
            STATE["vaults"] = config["vaults"]
        except Exception as exc:
            try:
                if staging.exists(): shutil.rmtree(staging)
            except OSError:
                pass
            raise HTTPException(500, f"Vault copy/verification failed; the original vault remains configured: {exc}")
        return {"ok": True, "message": "Vault copied, verified and activated. The original remains intact."}


class SettingsRequest(BaseModel):
    theme: str = "light-navy"


@app.put("/api/settings")
def put_settings(payload: SettingsRequest):
    require_unlocked()
    if payload.theme not in {"light-navy", "dark"}:
        raise HTTPException(400, "Unsupported theme.")
    # Theme preference is returned to the UI and saved in browser localStorage; no secret is stored.
    return {"ok": True, "theme": payload.theme}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
    confirm_password: str


@app.post("/api/settings/password")
def change_password(payload: ChangePasswordRequest):
    with MUTATION_LOCK:
        check_login_lockout()
        root, old_key, active_manifest = require_unlocked()
        try:
            supplied_current_key = check_password_key(payload.current_password)
        except HTTPException:
            record_auth_failure()
            raise
        if supplied_current_key != old_key:
            record_auth_failure()
            raise HTTPException(401, "Current password is incorrect.")
        record_auth_success()
        if payload.new_password != payload.confirm_password:
            raise HTTPException(400, "New passwords do not match.")
        validate_password(payload.new_password)
        new_key = password_key(payload.new_password)
        try:
            config = normalize_config(decrypt_json(old_key, CONFIG_PATH.read_bytes(), b"mps:config:v1"))
        except Exception as exc:
            raise HTTPException(500, f"Cannot read the vault registry; no changes made: {exc}")
        staged: list[dict[str, Any]] = []
        committed: list[dict[str, Any]] = []
        journal = PASSWORD_CHANGE_JOURNAL
        config_backup = APP_HOME / ("config.me.password-backup-" + secrets.token_hex(6))
        config_backup_created = False
        try:
            # Preflight and stage every registered vault, including inactive vaults.
            for vault in config["vaults"]:
                vroot = Path(vault["location"]).resolve()
                if not vroot.is_dir(): raise ValueError(f"Vault '{vault['label']}' is missing or inaccessible")
                old_manifest_blob = manifest_path(vroot).read_bytes()
                vm = decrypt_json(old_key, old_manifest_blob, b"mps:manifest:v1")
                if not isinstance(vm, dict) or vm.get("version") != 1 or not isinstance(vm.get("entries"), dict): raise ValueError(f"Vault '{vault['label']}' has an invalid manifest")
                stage = vroot.parent / (".mps-password-stage-" + secrets.token_hex(8))
                backup = vroot.parent / (".mps-password-backup-" + secrets.token_hex(8))
                shutil.copytree(vroot, stage)
                staged_item = {"vault":vault,"root":vroot,"stage":stage,"backup":backup,"manifest":vm,"old_manifest":old_manifest_blob}
                staged.append(staged_item)
                files_backup: list[tuple[str, bytes]] = []
                allowed_types = {"file", "folder"} if vm.get("vault_type", "file") == "file" else {"password"}
                for eid, entry in vm["entries"].items():
                    if not isinstance(eid, str) or not __import__("re").fullmatch(r"[A-Za-z0-9_-]+", eid) or not isinstance(entry, dict) or entry.get("type") not in allowed_types:
                        raise ValueError(f"Vault '{vault['label']}' contains invalid entry metadata")
                    path = entry_path(eid, vm, vroot)
                    if entry.get("type") == "folder":
                        if not path.is_dir(): raise ValueError(f"Vault '{vault['label']}' is missing folder {eid}")
                        continue
                    if not path.is_file(): raise ValueError(f"Vault '{vault['label']}' is missing entry data {eid}")
                    blob = path.read_bytes()
                    if entry.get("locked") or entry.get("hidden_by"): continue
                    aad = f"mps:password:{eid}:v1".encode() if entry.get("type") == "password" else f"mps:file:{eid}:v1".encode()
                    plain = decrypt_bytes(old_key, blob, aad)
                    staged_path = entry_path(eid, vm, stage)
                    atomic_write(staged_path, encrypt_bytes(new_key, plain, aad))
                    files_backup.append((eid, blob))
                atomic_write(manifest_path(stage), encrypt_json(new_key, vm, b"mps:manifest:v1"))
                check = decrypt_json(new_key, manifest_path(stage).read_bytes(), b"mps:manifest:v1")
                if check != vm: raise ValueError(f"Vault '{vault['label']}' staged manifest verification failed")
                for eid, entry in vm["entries"].items():
                    if entry.get("type") in {"file", "password"}:
                        staged_blob = entry_path(eid, vm, stage).read_bytes()
                        if entry.get("locked") or entry.get("hidden_by"):
                            if staged_blob != entry_path(eid, vm, vroot).read_bytes(): raise ValueError("Secondary-locked content changed during staging")
                        else:
                            aad = f"mps:password:{eid}:v1".encode() if entry.get("type") == "password" else f"mps:file:{eid}:v1".encode()
                            decrypt_bytes(new_key, staged_blob, aad)
            atomic_write(config_backup, CONFIG_PATH.read_bytes())
            config_backup_created = True
            journal_records = [{"root":str(x["root"]),"stage":str(x["stage"]),"backup":str(x["backup"])} for x in staged]
            atomic_write(journal, json.dumps({"phase":"staged","config_backup":str(config_backup),"vaults":journal_records}).encode())
            # Commit each staged vault with original kept as a rollback backup.
            for item in staged:
                shutil.move(str(item["root"]), str(item["backup"]))
                try: shutil.move(str(item["stage"]), str(item["root"]))
                except Exception:
                    shutil.move(str(item["backup"]), str(item["root"]))
                    raise
                committed.append(item)
                atomic_write(journal, json.dumps({"phase":"committing","config_backup":str(config_backup),"committed":[str(x["root"]) for x in committed],"vaults":journal_records}).encode())
            save_config(new_key, config)
            atomic_write(journal, json.dumps({"phase":"registry_committed","config_backup":str(config_backup),"vaults":journal_records}).encode())
            for item in committed: shutil.rmtree(item["backup"], ignore_errors=True)
            config_backup.unlink(missing_ok=True)
            try: journal.unlink(missing_ok=True)
            except OSError: pass
        except Exception as exc:
            # Restore every already-swapped vault from its original directory. Registry remains old unless final write succeeded.
            for item in reversed(committed):
                try:
                    failed = item["root"].parent / (".mps-password-failed-" + secrets.token_hex(5))
                    if item["root"].exists(): shutil.move(str(item["root"]), str(failed))
                    if item["backup"].exists(): shutil.move(str(item["backup"]), str(item["root"]))
                    shutil.rmtree(failed, ignore_errors=True)
                except Exception: pass
            for item in staged:
                shutil.rmtree(item["stage"], ignore_errors=True)
            if config_backup_created and config_backup.exists():
                try: atomic_write(CONFIG_PATH, config_backup.read_bytes())
                except Exception: pass
                config_backup.unlink(missing_ok=True)
            journal.unlink(missing_ok=True)
            raise HTTPException(500, f"Password change failed; rollback attempted and originals retained where possible: {exc}")
        STATE["key"] = new_key
        # Refresh active manifest from the now-committed directory and preserve in-memory prefix.
        STATE["manifest"] = decrypt_json(new_key, manifest_path(root).read_bytes(), b"mps:manifest:v1")
        STATE["manifest"]["_prefix"] = next((v.get("prefix", "") for v in config["vaults"] if v["id"] == STATE.get("active_vault_id")), "")
        STATE["vaults"] = config["vaults"]
        return {"ok": True, "vaults_updated": len(config["vaults"])}


@app.get("/api/health")
def health():
    return {"ok": True, "version": "0.1.0"}


def main() -> None:
    import uvicorn
    host, port = "127.0.0.1", int(os.environ.get("MPS_PORT", "8765"))
    url = f"http://{host}:{port}/"
    # Delay browser opening until the server is listening.
    def open_browser():
        import time
        for _ in range(50):
            try:
                with socket.create_connection((host, port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        webbrowser.open(url)
    threading.Thread(target=open_browser, daemon=True).start()
    uvicorn.run(app, host=host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
