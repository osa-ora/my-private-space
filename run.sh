#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

# Reconcile dependencies on every launch. This is normally a no-op when the
# environment is current, and repairs an existing .venv missing new packages.
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
fi
.venv/bin/python -m pip install -r requirements.txt
exec .venv/bin/python run.py
