#!/bin/bash
# Setup script for a Claude Code cloud environment.
#
# Paste this into the environment's "Setup script" field at claude.ai/code so
# every session starts with what the portal and certificate stages need.
# Without it, LibreOffice can convert nothing (the base image ships the
# LibreOffice core without the Writer module) and Playwright has no browser.

apt-get update -qq || true
apt-get install -y -qq libreoffice-writer || true

pip install -e ".[dev,portal]" || true

# Playwright's own browser download is unnecessary when the image already has
# one; src/tegg/browser.py finds it. This is a no-op fallback.
python -m playwright install chromium || true

exit 0
