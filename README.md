 <div align="center">

# <img width="243" height="55" alt="My Private Space" src="https://github.com/user-attachments/assets/997e9af3-3f97-4a64-a080-d36b3a4f038b" />

### Your files. Your passwords. Your machine. Your private space.

A local-first encrypted vault application with file and password vaults, multi-vault management, drag-and-drop imports, and recoverable operations — powered by Python, FastAPI, and vanilla JavaScript.

**Version 1.0 Beta** · Runs locally

</div>

---

## At a glance

- **Local-first:** Runs on your computer and binds to `127.0.0.1`.
- **Two vault types:** Choose between a File Vault for files and folders or a Password Vault for storing sensitive password entries.
- **Encrypted storage:** Protects file contents, password entries, vault manifests, and the application registry using authenticated encryption.
- **Multiple vaults:** Manage separate vaults with one main password, switch between them, and store them in independent directories.
- **Drag-and-drop imports:** Add files and folders by dragging them into the application, with the destination determined by the drop target.
- **Password management:** Add, view, copy, update, and delete password entries. Passwords remain masked by default.
- **Visibility management:** Optionally let My Private Space hide a vault directory when registered and make it visible when unregistered, without renaming the directory.
- **Familiar interface:** Browse folders, preview supported files, play supported media, and use light or dark themes in a desktop browser.
- **Recoverable deletion:** Move supported items to Deleted Items and restore them before permanent deletion.
- **Independent secondary locks:** Protect selected files and folders with separate passwords.
- **Session protection:** Persistent login-attempt lockout and automatic locking after five minutes of inactivity.
- **Simple technology stack:** Python backend and plain HTML, CSS, and JavaScript frontend. No Node.js or cloud service required.

## Contents

- [Features](#features)
- [Get started](#get-started)
- [How vaults work](#how-vaults-work)
- [Password vaults](#password-vaults)
- [Security model and limitations](#security-model-and-limitations)
- [Backups and recovery](#backups-and-recovery)
- [Development and tests](#development-and-tests)
- [Project structure](#project-structure)

## Features

| Area | Capabilities |
|---|---|
| Vault types | Create File Vaults or Password Vaults during initial setup or when creating additional vaults |
| Vault management | Create, select, switch, lock, relocate, register, and unregister vaults |
| Vault setup | Create a vault in an empty directory, register an existing valid vault, or explicitly convert an ordinary folder into a File Vault |
| Encrypted files | Encrypt file contents and maintain the vault hierarchy in an encrypted manifest |
| Drag-and-drop | Import files and folders by dropping them into the tree or designated import area |
| Import destinations | Detect the destination from the selected folder or drop target, including nested folders |
| Password entries | Add, view, copy, update, and delete password entries in Password Vaults |
| Masked passwords | Display stored password values as `***` by default, with an explicit Show action |
| Organization | Browse nested folders and import files and folders recursively |
| Previews and media | View supported images, PDFs, text, and Markdown; play supported audio and video |
| Archive and document previews | Display appropriate icons and guidance for file types that cannot be previewed directly, such as ZIP and DOCX |
| Secondary locks | Protect individual files or folders with independent passwords |
| Deleted Items | Restore deleted content or permanently remove it |
| Visibility management | Choose whether the application controls a vault directory's visibility |
| Session protection | Persistent login lockout and automatic locking after five minutes of inactivity |
| Main password | Change the shared main password across registered vaults using staged updates and recovery support |
| Storage IDs | Configure a prefix for new physical IDs in each new vault, such as `work-0001` |
| Appearance | Light and dark themes |

## Get started

### Requirements

- Python **3.11 or newer**
- A modern desktop browser
- Internet access on the first launch to install Python dependencies, unless they are already available locally

### macOS and Linux

1. Download and extract this repository.
2. Open a terminal in the project directory.
3. Run the launcher:

   ```bash
   chmod +x run.sh
   ./run.sh
   ```

4. Open [http://127.0.0.1:8765/](http://127.0.0.1:8765/) if the application does not open automatically.
5. On first run, choose the vault type, vault label, storage prefix, vault directory, and main password as requested by the setup screen.

For a **File Vault**, you can then add files and folders to the vault, either by drag and drop or by clicking on the Add files or folder button.

<img width="1705" height="714" alt="My Private Space file vault interface" src="https://github.com/user-attachments/assets/9dda66da-9b4d-4299-bf10-12fd7d65bf75" />

You can create multiple vaults and switch between them or unregister a vault when it is no longer needed.

<img width="1718" height="850" alt="Screenshot 2026-10-23 at 8 45 04 AM" src="https://github.com/user-attachments/assets/4041698b-f36a-4b2e-b844-17aa09457c74" />

For a **Password Vault**, select that type during setup or vault creation. The interface provides password-entry management instead of file and folder imports.

<img width="1712" height="843" alt="Screenshot 2026-10-23 at 8 45 46 AM" src="https://github.com/user-attachments/assets/fc1a834e-505f-4ae4-9d09-0388db916f64" />

Stop the server with `Ctrl+C` in the terminal.

### Windows

1. Install Python 3.11 or newer and ensure the Python launcher (`py`) is available.
2. Extract the repository.
3. Double-click `run.bat`, or run it from Command Prompt.
4. Open [http://127.0.0.1:8765/](http://127.0.0.1:8765/) if needed.

Stop the server with `Ctrl+C` or close its terminal window.

### Use a different port

The default port is `8765`. Set `MPS_PORT` before launching if that port is already in use.

**macOS/Linux**

```bash
MPS_PORT=8766 ./run.sh
```

**Windows Command Prompt**

```bat
set MPS_PORT=8766
run.bat
```

## How vaults work

### File Vault and Password Vault

My Private Space supports two vault types.

**File Vault**

A File Vault stores files and folders. Its interface supports:

- Creating and navigating nested folders.
- Adding files and folders through the import interface or drag-and-drop.
- Importing content into the root or a nested folder.
- Previewing supported file types and playing supported media.
- Using Deleted Items to recover supported deleted content.
- Applying independent secondary passwords to selected files and folders.

**Password Vault**

A Password Vault stores password entries rather than files. Its interface provides:

- Adding password entries.
- Browsing saved entries in the side navigator.
- Displaying password values as `***` by default.
- Revealing a password using **Show**, with the ability to hide it again.
- Copying a password using **Copy**.
- Updating or deleting an entry using its contextual menu.

File and folder import operations are not available in a Password Vault. The interface is designed around password entries rather than a filesystem tree.

A vault has a type, and the application must treat it consistently when opening and operating on that vault. Existing vaults created before vault types were introduced default to the File Vault type for backward compatibility.

### One main password, multiple vaults

The main password unlocks the registered-vault registry. If only one vault is registered, it opens directly. If several are registered, choose one after authentication without entering the password again.

Locking returns the application to the login screen.

Unregistering a vault removes its registry entry; it **does not delete the encrypted vault directory**. To use that vault again, register its existing valid directory.

### Create, register, or convert a vault

My Private Space supports three directory scenarios:

- **Empty directory:** Create a new vault there.
- **Existing valid vault:** Register it without reorganizing its contents or changing existing physical IDs.
- **Ordinary non-empty directory:** Explicitly confirm conversion to encrypted File Vault storage.

Conversion stages and verifies the data before committing and keeps the original data recoverable during the process. Do not deliberately interrupt conversion or modify its source directory while conversion is running.

If an operation is interrupted, preserve any original, staging, backup, and recovery directories until you have established which copy contains the complete data.

### Drag-and-drop imports

File Vaults support drag-and-drop imports.

- Dropping files or folders onto a folder targets that folder.
- Dropping onto a file targets the file's parent folder.
- Dropping onto a nested folder targets that nested folder.
- The import interface displays the target location so that you can verify where content will be added.

The target is determined from the drop destination and current selection, according to the interface's targeting rules. Review the displayed destination before confirming an import.

When importing a directory, its contained files and subdirectories are imported recursively, preserving the directory hierarchy within the selected destination.

Drag-and-drop is a File Vault feature; it does not add files to a Password Vault.

### Manage folder visibility

When creating or registering a vault, you can choose whether My Private Space should manage the directory's visibility.

**Let My Private Space manage this folder's visibility**

- **Enabled:** The application hides the directory after successful registration and makes it visible before unregistering the vault.
- **Disabled:** The application leaves the directory's visibility unchanged.
- **Existing vaults:** If the visibility setting is absent from the registry, it defaults to disabled. Existing folders are not automatically hidden or unhidden.
- **Switching, locking, or restarting:** These operations do not change directory visibility.

The application uses native filesystem attributes where supported: the hidden flag on macOS and the Hidden attribute on Windows. Linux does not provide a universal hidden-directory attribute, so visibility management is unsupported there rather than renaming the directory.

Folder hiding is a convenience, **not a security boundary**. It does not encrypt data further or prevent someone with filesystem access from discovering the directory.

### Storage ID prefixes

Each new vault requires a prefix containing only ASCII letters, digits, hyphens, or underscores.

For example, the prefix `work-` can produce IDs such as:

```text
work-0001
work-0002
work-0003
```

A prefix is immutable in this version. Existing vaults without prefixes retain their current IDs and are not reorganized to introduce a prefix. Do not rename physical ID directories manually.

### Secondary passwords

A file or folder can have a password independent of the main password. Secondary-password-protected content remains protected by its separate password when the main password changes.

Keep secondary passwords safe: the application cannot recover them for you.

### Automatic locking and login protection

- The application locks an unlocked vault after **300 seconds without user activity**.
- The backend enforces session expiration before protected API operations.
- The login protection imposes a five-minute lockout after three consecutive failed password-authentication attempts.
- Login lockout state persists across application restarts.

Inactivity locking and failed-login lockout are separate protections. Locking an unlocked vault does not reset or bypass the login lockout.

## Password vaults

### Add and manage password entries

A Password Vault is intended for storing password values separately from files and folders. Select the Password Vault type when creating a vault.

The password-entry workflow supports:

1. **Add password:** Create a new password entry.
2. **Select an entry:** View its details in the preview panel.
3. **Show / Hide:** Reveal the password when needed or return it to its masked state.
4. **Copy:** Copy the password to the clipboard for use in another application.
5. **Update:** Modify an existing entry.
6. **Delete:** Remove an entry through its contextual menu.

Password values are masked by default in the preview. The user must explicitly choose to reveal a password.

### Password handling and privacy

Password masking protects against casual viewing of the preview panel; it does not encrypt the value a second time or prevent someone with access to the unlocked application from revealing it.

Copying a password places it on the system clipboard. Other applications or clipboard-management tools may be able to access clipboard contents. Avoid leaving sensitive values copied longer than necessary.

Lock the application when leaving the computer unattended, and do not treat a masked preview as a substitute for encryption or operating-system security.

### Password vault backups

Back up the application configuration directory and the directories containing all registered vaults. A recoverable backup requires the relevant registry and vault data to be consistent with each other.

Do not edit encrypted password-vault data or manifest files manually. If a vault is lost, corrupted, or no longer recognized, preserve the original directory and any available backups before attempting recovery.

## Security model and limitations

My Private Space is intended for local use, but **local-first does not mean security-audited**. Review these limitations before storing sensitive data.

- **Password-to-key handling:** The current implementation normalizes the entered password using Unicode NFC, encodes it as UTF-8, truncates bytes after byte 32 or zero-pads shorter byte sequences to 32 bytes, and uses the result directly as an AES-256-GCM key. This is a deterministic transformation, not a password-based key derivation function. Password rules require eight Unicode code points and uppercase, lowercase, digit, and special-character categories. Keep the password and its exact processing rules stable; changing the implementation can make existing vaults inaccessible.
- **Local computer access:** A person or process controlling the computer may be able to inspect application memory, capture decrypted content, or access files and revealed passwords while the vault is unlocked.
- **Visible physical structure:** Physical directory names and file-versus-folder structure are visible on disk. Original names and file contents are represented through the encrypted metadata and storage format.
- **Password visibility:** Password entries are masked in the interface by default, but a user can reveal or copy them while authenticated. Masking is a UI safeguard, not an encryption mechanism.
- **Clipboard exposure:** Copied passwords may be accessible to other applications or clipboard managers.
- **Folder visibility:** Hiding a directory does not protect it from discovery or unauthorized access. Filesystem permissions and encryption remain separate concerns.
- **Login state obfuscation:** `state.me` uses JSON, a fixed reversible transformation, and Base64. This is obfuscation only—not encryption, integrity protection, or tamper resistance. It does not contain passwords or derived secrets.
- **Session clearing:** The application expires unlocked sessions after five minutes of inactivity and clears UI previews when locking. This cannot erase screenshots, operating-system captures, clipboard copies, or copies made elsewhere.
- **Transaction recovery:** Password changes, relocation, and conversion use staging, verification, and recovery mechanisms, but these paths have not been exhaustively tested under every power-loss or filesystem-failure condition.
- **Local API:** The server binds to loopback and uses host/origin and per-process API-token protections. These controls are not a substitute for an independent security review.

Use a strong, unique main password, keep your operating system updated, and lock the vault when leaving the computer unattended.

## Backups and recovery

Back up the application configuration directory and **all registered vault directories together**. Keep an additional copy somewhere protected and separate from the computer running the application.

The configuration directory is:

- **macOS/Linux:** `~/.my-private-space/`
- **Windows:** `%USERPROFILE%\.my-private-space\`

Important files include:

| Item | Purpose |
|---|---|
| `config.me` | Encrypted registry used to locate registered vaults and store vault configuration |
| `state.me` | Persistent failed-login and lockout state |
| Vault directories | Encrypted manifests and stored content, including password-vault data |
| Transaction journals and recovery artifacts | May be needed to recover an interrupted operation |

A valid vault can be registered again if the registry is lost, provided the vault directory and correct main password are available.

After a main-password change, restore a matching set of registry and vault backups. Restoring only an old registry may not match the current vault encryption state.

Never delete staging, backup, journal, or `.mps-original-*` recovery directories after an interrupted operation until you have established which copy contains the complete data.

**The application's recovery mechanisms are not a replacement for independent backups.**

### Configuration file examples

The examples below show the logical data structures for reference. **Do not copy these JSON snippets directly into the files:** `config.me` is encrypted, while `state.me` is encoded and obfuscated.

#### `config.me` — Vault registry

After decrypting the registry with the main password, its structure looks like this:

```json
{
  "version": 2,
  "vaults": [
    {
      "id": "vault-a1b2c3d4e5f60708",
      "label": "Work",
      "location": "/Users/example/Vaults/Work",
      "prefix": "work-",
      "type": "file",
      "manage_visibility": true
    },
    {
      "id": "vault-1029384756abcdef",
      "label": "Personal Passwords",
      "location": "/Users/example/Vaults/PersonalPasswords",
      "prefix": "personal-",
      "type": "password",
      "manage_visibility": false
    }
  ],
  "last_used_vault": "vault-a1b2c3d4e5f60708"
}
```

- `version`: Registry format version.
- `vaults`: Registered vaults and their settings.
- `id`: Unique registry identifier for a vault.
- `label`: Vault name displayed in the application.
- `location`: Absolute path to the vault directory.
- `prefix`: Prefix used for newly generated file identifiers. It may be absent for older vaults.
- `type`: Vault type: `file` for a File Vault or `password` for a Password Vault. Older entries without a type default to `file`.
- `manage_visibility`: Whether the application manages the folder's native hidden attribute. It may be absent in older registry entries; absence defaults to `false`.
- `last_used_vault`: Identifier of the last-used vault.

The application encrypts the registry before writing it to `config.me`. The example paths and identifiers are illustrative.

The vault's encrypted manifest also records its type so the application can verify that the registry and vault are consistent. Older manifests without a type are treated as File Vault manifests for backward compatibility.

#### `state.me` — Login lockout state

The logical JSON structure is:

```json
{
  "failed_attempts": 2,
  "locked_until": 1792660200.0
}
```

- `failed_attempts`: Number of consecutive failed authentication attempts.
- `locked_until`: Unix timestamp, in seconds, marking the end of the current lockout. A timestamp in the past means no active time-based lockout remains.

The application writes this data as JSON, applies a fixed reversible obfuscation transformation, and Base64-encodes the result. Consequently, the actual `state.me` file will not look like the JSON shown above.

The application creates or resets this state according to its startup and authentication rules. A missing or invalid state file triggers a five-minute lockout. Three consecutive failed authentication attempts also trigger a five-minute lockout.

**Important:** These formats document the application's current implementation; they are not intended as manual configuration interfaces.

## Development and tests

### Install dependencies

Create and activate a virtual environment if you prefer to manage setup manually, then install dependencies.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

On Windows, activate the environment using:

```bat
.venv\Scripts\activate
python -m pip install -r requirements.txt
```

### Run the application

```bash
python run.py
```

### Run automated tests

From the repository root:

```bash
PYTHONPATH=. pytest -q
```

### Run syntax checks

```bash
python -m py_compile app/main.py run.py
node --check app/static/js/app.js
```

Automated tests do not replace interactive browser testing or testing on each target operating system. Before using a new build with real data, exercise vault creation for both vault types, registration, conversion, visibility management, drag-and-drop imports, password creation and updates, clipboard operations, password changes, login lockout, inactivity expiration, Deleted Items restoration, and recovery using disposable directories.

## Project structure

```text
my-private-space/
├── app/
│   ├── main.py              # FastAPI backend and vault operations
│   ├── templates/
│   │   └── index.html       # Application page
│   └── static/
│       ├── css/app.css      # Styles and themes
│       └── js/app.js        # Browser interface and interactions
├── tests/
│   └── test_smoke.py        # Automated regression tests
├── README.md
├── requirements.txt
├── pyproject.toml
├── run.py
├── run.sh
└── run.bat
```

---

<div align="center">

**My Private Space · Version 1.0 Beta**

Built for local-first privacy. Back up first, and use the beta thoughtfully.

> [!WARNING]
> **Back up your data before use, test with disposable files first, and do not rely on this beta as the only copy of important or irreplaceable data.**

</div>
