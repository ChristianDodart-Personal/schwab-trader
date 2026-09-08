"""Single source of truth for the app version.

Bump this when shipping a build — `build-installer.ps1` reads it and syncs
desktop/package.json (which names the installer and drives electron-updater),
so every artifact carries the same number. The UI reads it via /api/version,
which finally answers "which build am I running?".
"""
APP_VERSION = "0.94.0"
