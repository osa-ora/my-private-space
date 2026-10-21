<div align="center">

# <img width="243" height="55" alt="Screenshot 2026-10-22 at 12 26 19 AM" src="https://github.com/user-attachments/assets/997e9af3-3f97-4a64-a080-d36b3a4f038b" />

### Your files. Your machine. Your private space.

A local-first encrypted file vault with a clean browser interface, multi-vault management, and recoverable file operations — powered by Python, FastAPI, and vanilla JavaScript.

**Version 1.0 Beta** · Runs locally

</div>

---

## At a glance

- **Local-first:** the application binds to `127.0.0.1` and works with files on your own computer.
- **Encrypted storage:** file contents, the vault manifest, and the application registry are protected using authenticated encryption.
- **Multiple vaults:** manage separate vaults with one main password, switch between them, and keep each vault in its own directory.
- **Familiar interface:** browse folders, preview supported files, and use light or dark themes in a regular desktop browser.
- **Recoverable deletion:** move items to Deleted Items and restore them before permanent deletion.
- **Independent secondary locks:** add a separate password to protect selected files or folders.
- **Built for local use:** Python backend and plain HTML, CSS, and JavaScript frontend; no Node.js or cloud service required.

## Contents

- [Features](#features)
- [Get started](#get-started)
- [How vaults work](#how-vaults-work)
- [Security model and limitations](#security-model-and-limitations)
- [Backups and recovery](#backups-and-recovery)
- [Development and tests](#development-and-tests)
- [Project structure](#project-structure)

## Features

| Area | What you can do |
|---|---|
| Vault management | Create, select, switch, lock, relocate, register, and unregister vaults |
| Vault setup | Create a vault in an empty directory, register an existing valid vault, or explicitly convert an ordinary folder |
| Encrypted files | Store file contents encrypted at rest and keep the vault hierarchy in an encrypted manifest |
| Organization | Browse nested folders and import files and folders recursively without modifying the source files during import |
| Previews | View supported images, PDFs, text/Markdown, audio, and video; HTML/SVG are displayed as text rather than active documents |
| Secondary locks | Protect individual files or folders with independent passwords |
| Deleted Items | Restore deleted content or permanently remove it when intended |
| Session protection | Persistent login-attempt lockout and automatic locking after five minutes of inactivity |
| Main password | Change the shared main password across registered vaults with staged updates and recovery support |
| Storage IDs | Configure an immutable prefix for new physical IDs in each new vault, such as `work-0001` |
| Appearance | Light and dark themes |

## Get started

### Requirements

- Python **3.11 or newer**
- A modern desktop browser
- Internet access on the first launch to install Python dependencies, unless they are already available locally

Node.js is not required for running the application.

### macOS and Linux

1. Download and extract this repository.
2. Open a terminal in the project directory.
3. Make the launcher executable if needed, then run it:

   ```bash
   chmod +x run.sh
   ./run.sh
   ```

4. Open the local application at <http://127.0.0.1:8765/> if it does not open automatically.
5. On first run, choose a vault label, an ID prefix, a vault directory, and a main password.

Stop the server with `Ctrl+C` in the terminal.

### Windows

1. Install Python 3.11 or newer and ensure the Python launcher (`py`) is available.
2. Extract the repository.
3. Double-click `run.bat`, or run it from Command Prompt.
4. Open <http://127.0.0.1:8765/> if needed.

Stop the server with `Ctrl+C` or close its terminal window.

### Use a different port

The default port is `8765`. Set `MPS_PORT` before launching if that port is already in use.

macOS/Linux:

```bash
MPS_PORT=8766 ./run.sh
```

Windows Command Prompt:

```bat
set MPS_PORT=8766
run.bat
```

## How vaults work

### One main password, multiple vaults

The main password unlocks the registered-vault registry. If only one vault is registered, it opens directly; if several are registered, choose the vault after authentication. Switching vaults does not ask for the main password again. Locking returns the application to the login screen.

Unregistering a vault removes its registry entry; it **does not delete the encrypted vault directory**. To use that vault again, register the existing valid vault directory.

### Create, register, or convert

- **Empty directory:** create a new vault there.
- **Existing valid vault:** register it without reorganizing its contents or changing its existing physical IDs.
- **Ordinary non-empty directory:** confirm conversion to encrypt the contents into vault storage. Conversion stages and verifies data before committing and keeps the original data recoverable during the process.

Do not interrupt conversion deliberately or modify the source directory while conversion is running. If an operation is interrupted, preserve any original, staging, backup, or recovery directories until you have inspected and recovered the data.

### ID prefixes

Each new vault requires a prefix containing only ASCII letters, digits, hyphens, or underscores. For example, `work-` can produce IDs such as `work-0001`. A prefix is immutable in this version. Existing vaults without prefixes retain their current IDs; they are not reorganized just to add a prefix. Do not rename physical ID directories manually.

### Secondary passwords

A file or folder can have a password independent of the main password. Secondary-password-protected file content remains protected by that separate password when the main password changes. Keep secondary passwords safe: they are not recoverable by the application.

## Security model and limitations

My Private Space is intended for local use, but **local-first does not mean security-audited**. Review these limitations before storing sensitive data:

- **Password-to-key handling:** the current implementation normalizes the entered password using Unicode NFC, encodes it as UTF-8, truncates bytes after byte 32 or zero-pads shorter byte sequences to 32 bytes, and uses the result directly as an AES-256-GCM key. This is a deterministic transformation, not a password-based key derivation function. Password rules require eight Unicode code points and uppercase, lowercase, digit, and special-character categories. Keep the password and its exact processing rules stable; changing the implementation can make existing vaults inaccessible.
- **Local computer access:** a person or process controlling the computer may be able to inspect application memory, capture decrypted content, or access files while the vault is unlocked.
- **Visible physical structure:** physical directory names and file-versus-folder structure are visible on disk. Original names and file contents are represented through the vault's encrypted metadata and storage format.
- **Login state obfuscation:** `state.me` uses JSON, a fixed reversible transformation, and Base64. This is obfuscation only—not encryption, integrity protection, or tamper resistance. It does not contain passwords or derived secrets.
- **Session clearing:** the application expires unlocked sessions after five minutes of inactivity and clears UI previews when locking. This cannot erase screenshots, operating-system captures, or copies made elsewhere.
- **Beta transaction recovery:** password changes, relocation, and conversion use staging/verification and recovery mechanisms, but these paths have not been exhaustively tested under every power-loss or filesystem-failure condition.
- **Local API:** the server binds to loopback and uses host/origin and per-process API-token protections. These controls are not a substitute for an independent security review.

Use a strong, unique main password, keep your operating system updated, and lock the vault when leaving the computer unattended.

## Backups and recovery

Back up the application configuration directory and **all registered vault directories together**. Keep an additional copy somewhere protected and separate from the computer running the application.

The configuration directory is:

- macOS/Linux: `~/.my-private-space/`
- Windows: `%USERPROFILE%\.my-private-space\`

Important files include:

- `config.me` — the encrypted registry used to locate registered vaults.
- `state.me` — persistent failed-login and lockout state.
- Any transaction journal or recovery artifacts present after an interrupted operation.

A vault directory contains its encrypted manifest and stored content. A valid vault can be registered again when the registry is lost, provided the vault and the correct main password are available. After a main-password change, restore a matching set of registry and vault backups; restoring only an old registry may not match the current vault encryption state.

Never delete staging, backup, journal, or `.mps-original-*` recovery directories after an interrupted operation until you have established which copy contains the complete data. **Do not treat the application's recovery mechanisms as a replacement for independent backups.**

## Development and tests

Create and activate a virtual environment if you prefer to manage setup manually, then install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
```

Run the application:

```bash
python run.py
```

Run the automated test suite from the repository root:

```bash
PYTHONPATH=. pytest -q
```

Useful syntax checks:

```bash
python -m py_compile app/main.py run.py
node --check app/static/js/app.js
```

Tests do not replace interactive testing in a browser or testing on each target operating system. Before using a new build with real data, exercise vault creation, registration, conversion, password changes, lockout, inactivity expiration, trash restoration, and recovery using disposable directories.

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

Built for local-first file privacy. Back up first, and use the beta thoughtfully.

> [!WARNING]
> **Back up your data before use, test with disposable files first, and do not rely on this beta as the only copy of important or irreplaceable data.

</div>
