import json
import os
import tempfile
from pathlib import Path

os.environ["MPS_HOME"] = tempfile.mkdtemp(prefix="mps-config-test-")

from fastapi.testclient import TestClient
from app.main import app, API_TOKEN, STATE
from app import main as main_module

client = TestClient(app, base_url="http://127.0.0.1:8765")
H = {"X-MPS-Token": API_TOKEN}


def test_homepage_renders_template():
    response = client.get("/")
    assert response.status_code == 200
    assert "My Private Space" in response.text
    assert 'name="mps-token"' in response.text
    assert "Open Source Project" in response.text
    assert "Powered by" in response.text and "Osama Oransa" in response.text
    assert 'id="aboutButton"' in response.text
    assert 'id="setupVaultLabel"' in response.text
    assert 'Create New Vault' in response.text
    assert 'id="sidebarVaultLabel"' in response.text
    assert 'id="switchVaultButton"' in response.text
    assert 'id="switchVaultDialog"' in response.text


def test_vault_flow(monkeypatch):
    with tempfile.TemporaryDirectory(prefix="mps-vault-test-") as tmp:
        root = Path(tmp) / "vault"
        root.mkdir()
        # Startup intentionally creates a five-minute lockout when state.me is absent.
        # This functional flow begins after that startup lockout has elapsed.
        main_module.LOGIN_STATE.update(failed_attempts=0, locked_until=0)
        main_module._write_login_state(main_module.LOGIN_STATE)
        r = client.post("/api/setup", headers=H, json={"label": "Personal", "prefix": "personal-", "target_directory": str(root), "password": "Abc@1234", "confirm_password": "Abc@1234"})
        assert r.status_code == 200, r.text
        assert (root / "manifest.enc").exists()
        # A missing flag is backward-compatible and must not trigger visibility changes.
        initial_config = main_module.normalize_config(main_module.decrypt_json(
            main_module.password_key("Abc@1234"), main_module.CONFIG_PATH.read_bytes(), b"mps:config:v1"))
        assert initial_config["vaults"][0].get("manage_visibility", False) is False
        assert initial_config["last_used_vault"] == initial_config["vaults"][0]["id"]

        # The first manual/timeout lock after setup should resume directly into
        # the vault rather than showing the vault picker message.
        client.post("/api/lock", headers=H)
        first_resume = client.post("/api/unlock", headers=H, json={"password": "Abc@1234", "resume_last_used": True})
        assert first_resume.status_code == 200 and first_resume.json()["selected"] is True
        assert first_resume.json()["vault_label"] == "Personal"

        # Older registries with no last-used ID should still resume a vault
        # after a lock rather than returning selected=False.
        legacy_config = main_module.normalize_config(main_module.decrypt_json(
            main_module.password_key("Abc@1234"), main_module.CONFIG_PATH.read_bytes(), b"mps:config:v1"))
        legacy_config["last_used_vault"] = None
        main_module.save_config(main_module.password_key("Abc@1234"), legacy_config)
        client.post("/api/lock", headers=H)
        legacy_resume = client.post("/api/unlock", headers=H, json={"password": "Abc@1234", "resume_last_used": True})
        assert legacy_resume.status_code == 200 and legacy_resume.json()["selected"] is True

        visibility_calls = []
        monkeypatch.setattr(main_module, "set_directory_hidden", lambda path, hidden: visibility_calls.append((Path(path), hidden)) or True)

        # Import one file and a nested folder hierarchy.
        files = [
            ("files", ("hello.txt", b"hello private world", "text/plain")),
            ("files", ("nested.txt", b"nested secret", "text/plain")),
        ]
        r = client.post("/api/import/files", headers=H, data={"parent_id": "", "relative_paths": json.dumps(["hello.txt", "folder/nested.txt"])}, files=files)
        assert r.status_code == 200, r.text
        tree = client.get("/api/tree", headers=H).json()["items"]
        assert {x["name"] for x in tree} == {"hello.txt", "folder"}
        file_entry = next(x for x in tree if x["name"] == "hello.txt")
        assert file_entry["id"].startswith("personal-")
        preview = client.get(f"/api/entries/{file_entry['id']}/preview", headers=H)
        assert preview.status_code == 200 and preview.content == b"hello private world"

        # HEIC preview converts a decrypted image to JPEG for browsers that do not
        # natively support HEIC. Mock the decoder so this test does not need a HEIC fixture.
        class FakeImage:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def convert(self, mode):
                assert mode == "RGB"
                return self
            def save(self, output, format, quality, optimize):
                assert format == "JPEG"
                output.write(b"jpeg-preview")
        monkeypatch.setattr(main_module, "HEIF_PREVIEW_AVAILABLE", True)
        monkeypatch.setattr(main_module.Image, "open", lambda source: FakeImage())
        heic = client.post("/api/import/files", headers=H, data={"parent_id": "", "relative_paths": json.dumps(["sample.heic"])}, files=[("files", ("sample.heic", b"fake-heic-content", "application/octet-stream"))])
        assert heic.status_code == 200, heic.text
        tree = client.get("/api/tree", headers=H).json()["items"]
        heic_entry = next(x for x in tree if x["name"] == "sample.heic")
        heic_preview = client.get(f"/api/entries/{heic_entry['id']}/preview", headers=H)
        assert heic_preview.status_code == 200
        assert heic_preview.headers["content-type"].startswith("image/jpeg")
        assert heic_preview.content == b"jpeg-preview"
        # The preview endpoint emits converted bytes only; vault storage is untouched.

        # Secondary file lock encrypts the file under the secondary password.
        r = client.post(f"/api/entries/{file_entry['id']}/lock", headers=H, json={"password": "Sec@1234"})
        assert r.status_code == 200, r.text
        tree = client.get("/api/tree", headers=H).json()["items"]
        assert next(x for x in tree if x["id"] == file_entry["id"])["name"] == "Locked file"
        assert client.get(f"/api/entries/{file_entry['id']}/preview", headers=H).status_code == 423
        assert client.post(f"/api/entries/{file_entry['id']}/unlock", headers=H, json={"password": "badpass1"}).status_code == 401
        assert client.post(f"/api/entries/{file_entry['id']}/unlock", headers=H, json={"password": "Sec@1234"}).status_code == 200
        assert client.get(f"/api/entries/{file_entry['id']}/preview", headers=H).content == b"hello private world"

        # Folder lock conceals children and protects file contents with its secondary password.
        tree = client.get("/api/tree", headers=H).json()["items"]
        folder = next(x for x in tree if x["name"] == "folder")
        assert len(folder["children"]) == 1
        child_id = folder["children"][0]["id"]
        assert client.post(f"/api/entries/{folder['id']}/lock", headers=H, json={"password": "Fold@123"}).status_code == 200
        tree = client.get("/api/tree", headers=H).json()["items"]
        locked_folder = next(x for x in tree if x["id"] == folder["id"])
        assert locked_folder["name"] == "Locked folder" and locked_folder["children"] == []
        assert client.post(f"/api/entries/{folder['id']}/unlock", headers=H, json={"password": "Fold@123"}).status_code == 200
        tree = client.get("/api/tree", headers=H).json()["items"]
        folder = next(x for x in tree if x["id"] == folder["id"])
        assert folder["children"][0]["id"] == child_id

        # Recoverable delete and restore.
        assert client.delete(f"/api/entries/{file_entry['id']}", headers=H).status_code == 200
        assert any(x["id"] == file_entry["id"] for x in client.get("/api/trash", headers=H).json()["items"])
        assert client.post(f"/api/entries/{file_entry['id']}/restore", headers=H, json={}).status_code == 200

        # Change the main password, lock the vault, and unlock with the new password.
        r = client.post("/api/settings/password", headers=H, json={"current_password": "Abc@1234", "new_password": "Xyz#9876", "confirm_password": "Xyz#9876"})
        assert r.status_code == 200, r.text
        client.post("/api/lock", headers=H)
        assert client.post("/api/unlock", headers=H, json={"password": "Abc@1234"}).status_code == 401
        single_login = client.post("/api/unlock", headers=H, json={"password": "Xyz#9876"})
        assert single_login.status_code == 200 and single_login.json()["selected"] is False
        personal_id = single_login.json()["vaults"][0]["id"]
        assert client.post("/api/vaults/select", headers=H, json={"vault_id": personal_id}).status_code == 200
        client.post("/api/lock", headers=H)
        resumed = client.post("/api/unlock", headers=H, json={"password":"Xyz#9876", "resume_last_used":True})
        assert resumed.status_code == 200 and resumed.json()["selected"] is True
        assert resumed.json()["vault_label"] == "Personal"
        assert client.get(f"/api/entries/{file_entry['id']}/preview", headers=H).content == b"hello private world"

        # Relocation copies and verifies before switching config.
        destination = Path(tmp) / "vault-copy"
        destination.mkdir()
        r = client.post("/api/settings/target", headers=H, json={"target_directory": str(destination)})
        assert r.status_code == 200, r.text
        assert (destination / "manifest.enc").exists()
        assert (root / "manifest.enc").exists()  # original remains intact
        assert client.get(f"/api/entries/{file_entry['id']}/preview", headers=H).content == b"hello private world"


        # Restore decrypted copies outside the vault with original names and optional source removal.
        export_dir = Path(tmp) / "restored"
        export_dir.mkdir()
        r = client.post(f"/api/entries/{file_entry['id']}/export", headers=H, json={"destination_directory": str(export_dir)})
        assert r.status_code == 200, r.text
        assert (export_dir / "hello.txt").read_bytes() == b"hello private world"
        r = client.post(f"/api/entries/{file_entry['id']}/export", headers=H, json={"destination_directory": str(export_dir)})
        assert r.status_code == 409
        r = client.post(f"/api/entries/{file_entry['id']}/export", headers=H, json={"destination_directory": str(export_dir), "overwrite_existing": True})
        assert r.status_code == 200, r.text

        # Folder restore preserves nested hierarchy.
        tree = client.get("/api/tree", headers=H).json()["items"]
        folder = next(x for x in tree if x["name"] == "folder")
        r = client.post(f"/api/entries/{folder['id']}/export", headers=H, json={"destination_directory": str(export_dir)})
        assert r.status_code == 200, r.text
        assert (export_dir / "folder" / "nested.txt").read_bytes() == b"nested secret"

        # Explicit delete-from-vault occurs only after successful restore.
        r = client.post(f"/api/entries/{file_entry['id']}/export", headers=H, json={"destination_directory": str(export_dir), "overwrite_existing": True, "delete_from_vault": True})
        assert r.status_code == 200, r.text
        assert (export_dir / "hello.txt").read_bytes() == b"hello private world"
        assert client.get(f"/api/entries/{file_entry['id']}/preview", headers=H).status_code == 404
        # Restoring with the move-to-Deleted-Items option must remain recoverable.
        trash_items = client.get("/api/trash", headers=H).json()["items"]
        assert any(x["id"] == file_entry["id"] for x in trash_items)
        assert (root / file_entry["id"]).exists() or (destination / file_entry["id"]).exists()

        # Multi-vault: create a second vault with the shared main password, lock,
        # authenticate once, choose a label, and verify the active label is returned.
        second_root = Path(tmp) / "work-vault"
        second_root.mkdir()
        r = client.post("/api/vaults/create", headers=H, json={"label": "Work", "prefix": "work-", "target_directory": str(second_root)})
        assert r.status_code == 200, r.text
        assert r.json()["vault_label"] == "Work"
        assert (second_root / "manifest.enc").exists()
        # A new vault must never be initialized in a directory already used by
        # a registered vault, even when the requested label is different.
        same_existing = client.post("/api/vaults/create", headers=H,
                                    json={"label": "Work Copy", "prefix": "copy-", "target_directory": str(second_root)})
        assert same_existing.status_code == 409
        assert (second_root / "manifest.enc").exists()
        assert len(client.get("/api/settings", headers=H).json()["vaults"]) == 2
        duplicate = Path(tmp) / "duplicate-vault"
        duplicate.mkdir()
        r = client.post("/api/vaults/create", headers=H, json={"label": " work ", "prefix": "dup-", "target_directory": str(duplicate)})
        assert r.status_code == 409
        assert not (duplicate / "manifest.enc").exists()
        invalid_prefix_root = Path(tmp) / "invalid-prefix"
        invalid_prefix_root.mkdir()
        invalid_prefix = client.post("/api/vaults/create", headers=H, json={"label":"Invalid Prefix", "prefix":"../escape", "target_directory":str(invalid_prefix_root)})
        assert invalid_prefix.status_code == 400
        assert not (invalid_prefix_root / "manifest.enc").exists()
        client.post("/api/lock", headers=H)
        r = client.post("/api/unlock", headers=H, json={"password": "Xyz#9876"})
        assert r.status_code == 200, r.text
        assert r.json()["selected"] is False
        assert {v["label"] for v in r.json()["vaults"]} == {"Personal", "Work"}
        r = client.post("/api/vaults/select", headers=H, json={"vault_id": next(v["id"] for v in r.json()["vaults"] if v["label"] == "Personal")})
        assert r.status_code == 200 and r.json()["vault_label"] == "Personal"
        assert client.get("/api/tree", headers=H).status_code == 200

        # Switching while unlocked works without re-entering the main password.
        work_id = next(v["id"] for v in client.get("/api/settings", headers=H).json()["vaults"] if v["label"] == "Work")
        r = client.post("/api/vaults/select", headers=H, json={"vault_id": work_id})
        assert r.status_code == 200 and r.json()["vault_label"] == "Work"
        assert client.get("/api/tree", headers=H).status_code == 200

        # A non-active vault can be unregistered, but its encrypted directory is preserved.
        personal_id = next(v["id"] for v in client.get("/api/settings", headers=H).json()["vaults"] if v["label"] == "Personal")
        r = client.post("/api/vaults/remove", headers=H, json={"vault_id": personal_id})
        assert r.status_code == 200 and r.json()["directory_preserved"] is True
        assert (destination / "manifest.enc").exists()  # copied/active Work vault is intact
        assert (root / "manifest.enc").exists()  # unregistered Personal vault data is not deleted
        assert {v["label"] for v in client.get("/api/settings", headers=H).json()["vaults"]} == {"Work"}

        # Removing a vault unregisters it only; its existing encrypted directory can
        # be registered again later without reinitializing or losing its contents.
        archive_root = Path(tmp) / "archive-vault"
        archive_root.mkdir()
        r = client.post("/api/vaults/create", headers=H, json={"label": "Archive", "prefix": "archive-", "target_directory": str(archive_root)})
        assert r.status_code == 200 and r.json()["reused_existing_vault"] is False, r.text
        r = client.post("/api/import/files", headers=H,
                        data={"parent_id": "", "relative_paths": json.dumps(["kept.txt"])},
                        files=[("files", ("kept.txt", b"preserved encrypted content", "text/plain"))])
        assert r.status_code == 200, r.text
        archive_id = next(v["id"] for v in client.get("/api/settings", headers=H).json()["vaults"] if v["label"] == "Archive")
        r = client.post("/api/vaults/select", headers=H, json={"vault_id": work_id})
        assert r.status_code == 200, r.text
        r = client.post("/api/vaults/remove", headers=H, json={"vault_id": archive_id})
        assert r.status_code == 200 and (archive_root / "manifest.enc").exists()
        r = client.post("/api/vaults/create", headers=H, json={"label": "Archive", "prefix": "archive-", "target_directory": str(archive_root)})
        assert r.status_code == 200 and r.json()["reused_existing_vault"] is True, r.text
        tree = client.get("/api/tree", headers=H).json()["items"]
        kept = next(item for item in tree if item["name"] == "kept.txt")
        assert client.get(f"/api/entries/{kept['id']}/preview", headers=H).content == b"preserved encrypted content"
        kept_original_id = kept["id"]
        assert client.post(f"/api/entries/{kept['id']}/lock", headers=H, json={"password":"Arc@1234"}).status_code == 200

        # A non-vault directory containing unrelated files is still rejected safely.
        unrelated = Path(tmp) / "unrelated"
        unrelated.mkdir()
        (unrelated / "important.txt").write_text("leave me alone")
        r = client.post("/api/vaults/create", headers=H, json={"label": "Unrelated", "prefix": "unrel-", "target_directory": str(unrelated)})
        assert r.status_code == 409
        assert (unrelated / "important.txt").read_text() == "leave me alone"

        # Global password changes must preflight inactive vaults before changing any data.
        assert client.post("/api/vaults/select", headers=H, json={"vault_id":work_id}).status_code == 200
        archive_manifest = archive_root / "manifest.enc"
        hidden_manifest = archive_root / "manifest.enc.test-hold"
        archive_manifest.rename(hidden_manifest)
        preflight_failure = client.post("/api/settings/password", headers=H, json={"current_password":"Xyz#9876", "new_password":"New#5678", "confirm_password":"New#5678"})
        assert preflight_failure.status_code == 500
        hidden_manifest.rename(archive_manifest)
        assert client.get("/api/tree", headers=H).status_code == 200

        # Inject a registry commit failure and verify the original password/data remain usable.
        original_save_config = main_module.save_config
        def fail_registry_commit(key, config):
            if key == main_module.password_key("New#5678"):
                raise OSError("injected registry commit failure")
            return original_save_config(key, config)
        monkeypatch.setattr(main_module, "save_config", fail_registry_commit)
        failed_change = client.post("/api/settings/password", headers=H, json={"current_password":"Xyz#9876", "new_password":"New#5678", "confirm_password":"New#5678"})
        assert failed_change.status_code == 500
        monkeypatch.setattr(main_module, "save_config", original_save_config)
        assert client.get("/api/tree", headers=H).status_code == 200
        changed = client.post("/api/settings/password", headers=H, json={"current_password":"Xyz#9876", "new_password":"New#5678", "confirm_password":"New#5678"})
        assert changed.status_code == 200, changed.text
        assert changed.json()["vaults_updated"] == 2
        client.post("/api/lock", headers=H)
        assert client.post("/api/unlock", headers=H, json={"password":"Xyz#9876"}).status_code == 401
        new_login = client.post("/api/unlock", headers=H, json={"password":"New#5678"})
        assert new_login.status_code == 200 and new_login.json()["selected"] is False
        archive_vault_id = next(v["id"] for v in new_login.json()["vaults"] if v["label"] == "Archive")
        assert client.post("/api/vaults/select", headers=H, json={"vault_id":archive_vault_id}).status_code == 200
        archive_tree = client.get("/api/tree", headers=H).json()["items"]
        locked_kept = next(item for item in archive_tree if item["name"] == "Locked file")
        assert client.post(f"/api/entries/{locked_kept['id']}/unlock", headers=H, json={"password":"Arc@1234"}).status_code == 200
        archive_tree = client.get("/api/tree", headers=H).json()["items"]
        kept = next(item for item in archive_tree if item["name"] == "kept.txt")
        assert client.get(f"/api/entries/{kept['id']}/preview", headers=H).content == b"preserved encrypted content"

        # Ordinary-folder conversion requires confirmation, then encrypts and preserves hierarchy.
        conversion = Path(tmp) / "conversion"
        (conversion / "nested").mkdir(parents=True)
        (conversion / "nested" / "secret.txt").write_text("convert me")
        rejected = client.post("/api/vaults/create", headers=H, json={"label":"Converted", "prefix":"conv-", "target_directory":str(conversion)})
        assert rejected.status_code == 409 and (conversion / "nested" / "secret.txt").read_text() == "convert me"
        converted = client.post("/api/vaults/create", headers=H, json={"label":"Converted", "prefix":"conv-", "target_directory":str(conversion), "convert_existing":True})
        assert converted.status_code == 200, converted.text
        assert not (conversion / "nested").exists() and (conversion / "manifest.enc").exists()
        converted_tree = client.get("/api/tree", headers=H).json()["items"]
        nested_folder = next(item for item in converted_tree if item["name"] == "nested")
        converted_file = nested_folder["children"][0]
        assert converted_file["id"].startswith("conv-")
        assert client.get(f"/api/entries/{converted_file['id']}/preview", headers=H).content == b"convert me"

        # Conversion encryption failure leaves the ordinary source tree untouched and unregistered.
        failed_conversion = Path(tmp) / "conversion-failure"
        failed_conversion.mkdir()
        (failed_conversion / "original.txt").write_text("recoverable original")
        original_encrypt = main_module.encrypt_bytes
        monkeypatch.setattr(main_module, "encrypt_bytes", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("injected encryption failure")))
        failed_result = client.post("/api/vaults/create", headers=H, json={"label":"Conversion Failure", "prefix":"fail-", "target_directory":str(failed_conversion), "convert_existing":True})
        monkeypatch.setattr(main_module, "encrypt_bytes", original_encrypt)
        assert failed_result.status_code == 500
        assert (failed_conversion / "original.txt").read_text() == "recoverable original"
        assert not (failed_conversion / "manifest.enc").exists()
        assert all(v["label"] != "Conversion Failure" for v in client.get("/api/settings", headers=H).json()["vaults"])

        # Three failed main-password attempts persist a lockout; a valid attempt cannot bypass it.
        client.post("/api/lock", headers=H)
        main_module.LOGIN_STATE.update(failed_attempts=0, locked_until=0)
        main_module._write_login_state(main_module.LOGIN_STATE)
        for _ in range(3):
            assert client.post("/api/unlock", headers=H, json={"password":"Bad!1234"}).status_code == 401
        blocked = client.post("/api/unlock", headers=H, json={"password":"New#5678"})
        assert blocked.status_code == 429
        assert main_module.STATE["unlocked"] is False

        # A normal login must show the vault picker even when only one vault is registered.
        main_module.LOGIN_STATE.update(failed_attempts=0, locked_until=0)
        main_module._write_login_state(main_module.LOGIN_STATE)
        login = client.post("/api/unlock", headers=H, json={"password":"New#5678"})
        assert login.status_code == 200 and login.json()["selected"] is False
        vaults = login.json()["vaults"]
        assert len(vaults) >= 1
        selected_id = vaults[0]["id"]
        assert client.post("/api/vaults/select", headers=H, json={"vault_id":selected_id}).status_code == 200

        # Any vault can be removed, including the active one. Removing an active
        # vault switches the unlocked session to another registered vault; removing
        # the final vault returns the app to setup. Encrypted directories are kept.
        current = client.get("/api/settings", headers=H).json()
        preserved_paths = [Path(v["location"]) for v in current["vaults"]]
        for vault in list(current["vaults"]):
            current_vaults = client.get("/api/settings", headers=H).json()["vaults"]
            if not any(v["id"] == vault["id"] for v in current_vaults):
                continue
            removed = client.post("/api/vaults/remove", headers=H, json={"vault_id":vault["id"]})
            assert removed.status_code == 200, removed.text
            if removed.json().get("requires_setup"):
                break
            assert client.get("/api/settings", headers=H).status_code == 200
        assert not main_module.CONFIG_PATH.exists()
        assert not main_module.CONFIG_PATH.exists()
        assert main_module.STATE["key"] is None and main_module.STATE["unlocked"] is False
        assert all(path.joinpath("manifest.enc").exists() for path in preserved_paths)
        assert client.get("/api/status", headers=H).json()["configured"] is False


def test_state_me_encoding_and_idle_expiration(monkeypatch):
    from app import main as m
    import time
    original_path = m.STATE_PATH
    with tempfile.TemporaryDirectory(prefix="mps-state-test-") as td:
        monkeypatch.setattr(m, "STATE_PATH", Path(td) / "state.me")
        sample = {"failed_attempts": 2, "locked_until": time.time() + 123}
        m._write_login_state(sample)
        assert m.STATE_PATH.exists()
        raw = m.STATE_PATH.read_bytes()
        assert b'"failed_attempts"' not in raw
        decoded = json.loads(m._xor_state(__import__("base64").b64decode(raw)).decode())
        assert decoded == sample
        assert m._load_login_state_startup() == sample  # persisted state survives a reload
        m.STATE_PATH.write_bytes(b"malformed state")
        malformed = m._load_login_state_startup()
        assert malformed["locked_until"] > time.time() + 290
        assert m.STATE_PATH.read_bytes() != b"malformed state"
        m.STATE_PATH.unlink()
        missing = m._load_login_state_startup()
        assert missing["locked_until"] > time.time() + 290 and m.STATE_PATH.exists()
    monkeypatch.setattr(m, "IDLE_TIMEOUT_SECONDS", 1)
    m.STATE.update(root=Path("/tmp"), key=b"x"*32, manifest={"entries":{}}, unlocked=True, last_activity=time.monotonic()-2)
    from fastapi import HTTPException
    try:
        m.require_unlocked()
        assert False, "expired session should be rejected"
    except HTTPException as exc:
        assert exc.status_code == 423
    assert m.STATE["key"] is None and m.STATE["manifest"] is None
    monkeypatch.setattr(m, "STATE_PATH", original_path)


def test_password_transaction_journal_recovery(monkeypatch):
    from app import main as m
    with tempfile.TemporaryDirectory(prefix="mps-journal-test-") as td:
        base = Path(td)
        root = base / "vault"
        backup = base / "vault-backup"
        stage = base / "vault-stage"
        root.mkdir(); backup.mkdir(); stage.mkdir()
        (root / "value.txt").write_text("new")
        (backup / "value.txt").write_text("old")
        (stage / "staged.txt").write_text("staged")
        config_path = base / "config.me"
        config_backup = base / "config.me.backup"
        config_path.write_bytes(b"new-config")
        config_backup.write_bytes(b"old-config")
        journal_path = base / "password-change-journal.json"
        journal_path.write_text(json.dumps({"phase":"committing", "config_backup":str(config_backup), "vaults":[{"root":str(root), "backup":str(backup), "stage":str(stage)}]}))
        monkeypatch.setattr(m, "CONFIG_PATH", config_path)
        monkeypatch.setattr(m, "PASSWORD_CHANGE_JOURNAL", journal_path)
        m.recover_password_change_transaction()
        assert (root / "value.txt").read_text() == "old"
        assert config_path.read_bytes() == b"old-config"
        assert not backup.exists() and not stage.exists() and not journal_path.exists()


def test_idle_activity_is_explicit_and_status_does_not_revive_expired_session(monkeypatch):
    from app import main as m
    import time
    from fastapi import HTTPException

    monkeypatch.setattr(m, "IDLE_TIMEOUT_SECONDS", 2)
    # A legitimate activity heartbeat refreshes the backend's monotonic timestamp.
    m.STATE.update(root=Path("/tmp"), key=b"k" * 32, manifest={"entries": {}},
                   unlocked=True, vaults=[], active_vault_id="test", active_vault_label="Test",
                   pending_config=None, last_activity=time.monotonic() - 1)
    before = m.STATE["last_activity"]
    response = client.post("/api/activity", headers=H)
    assert response.status_code == 200, response.text
    assert m.STATE["last_activity"] >= before

    # Ordinary protected reads must not silently refresh inactivity time.
    old_activity = time.monotonic() - 1.5
    m.STATE["last_activity"] = old_activity
    response = client.get("/api/tree", headers=H)
    assert response.status_code == 200, response.text
    assert m.STATE["last_activity"] == old_activity

    # Status/bootstrap after expiration must clear the session, not restart its timer.
    m.STATE["last_activity"] = time.monotonic() - 3
    response = client.get("/api/status", headers=H)
    assert response.status_code == 200
    assert response.json()["unlocked"] is False
    assert m.STATE["key"] is None and m.STATE["manifest"] is None


def test_native_directory_hidden_flag_does_not_rename(monkeypatch, tmp_path):
    """macOS hiding uses chflags metadata and leaves the vault path untouched."""
    import subprocess
    from app import main as m

    folder = tmp_path / "vault-name"
    folder.mkdir()
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        return None

    monkeypatch.setattr(m.sys, "platform", "darwin")
    monkeypatch.setattr(m.subprocess, "run", fake_run)
    assert m.set_directory_hidden(folder, True) is True
    assert m.set_directory_hidden(folder, False) is True
    assert calls == [["chflags", "hidden", str(folder)], ["chflags", "nohidden", str(folder)]]
    assert folder.exists() and folder.name == "vault-name"


def test_directory_hidden_flag_failure_is_reported(monkeypatch, tmp_path):
    from app import main as m
    import subprocess

    folder = tmp_path / "vault-name"
    folder.mkdir()
    monkeypatch.setattr(m.sys, "platform", "darwin")
    def fail_run(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args[0], stderr=b"permission denied")
    monkeypatch.setattr(m.subprocess, "run", fail_run)
    assert m.set_directory_hidden(folder, True) is False
    assert folder.exists() and folder.name == "vault-name"


def test_linux_hidden_flag_is_safe_noop_without_rename(monkeypatch, tmp_path):
    from app import main as m
    folder = tmp_path / "vault-name"
    folder.mkdir()
    monkeypatch.setattr(m.sys, "platform", "linux")
    monkeypatch.setattr(m.os, "name", "posix")
    assert m.set_directory_hidden(folder, True) is None
    assert folder.exists() and folder.name == "vault-name"


def test_visibility_flag_normalization_and_validation(tmp_path):
    from app import main as m
    legacy = {"version": 2, "vaults": [{"id": "v1", "label": "Legacy", "location": str(tmp_path)}], "last_used_vault": "v1"}
    normalized = m.normalize_config(legacy)
    assert normalized["vaults"][0].get("manage_visibility", False) is False
    assert "manage_visibility" not in normalized["vaults"][0]
    opted_in = {"version": 2, "vaults": [{"id": "v1", "label": "Managed", "location": str(tmp_path), "manage_visibility": True}], "last_used_vault": "v1"}
    assert m.normalize_config(opted_in)["vaults"][0]["manage_visibility"] is True
    opted_out = {"version": 2, "vaults": [{"id": "v1", "label": "Visible", "location": str(tmp_path), "manage_visibility": False}], "last_used_vault": "v1"}
    assert m.normalize_config(opted_out)["vaults"][0]["manage_visibility"] is False
    invalid = {"version": 2, "vaults": [{"id": "v1", "label": "Bad", "location": str(tmp_path), "manage_visibility": "yes"}], "last_used_vault": "v1"}
    try:
        m.normalize_config(invalid)
        assert False, "non-boolean visibility flag should be rejected"
    except ValueError as exc:
        assert "visibility" in str(exc).lower()
