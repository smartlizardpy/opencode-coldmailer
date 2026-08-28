#!/usr/bin/env bash
# coldcall installer - macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/smartlizardpy/opencode-coldmailer/main/install.sh | bash
#
# Installs to ~/.coldcall, never touches system Node, never asks for sudo.
set -euo pipefail

REPO="${COLDCALL_REPO:-smartlizardpy/opencode-coldmailer}"
REF="${COLDCALL_REF:-main}"
HOME_DIR="${COLDCALL_HOME:-$HOME/.coldcall}"
APP_DIR="$HOME_DIR/app"
BIN_DIR="$HOME/.local/bin"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13
NODE_VERSION="${COLDCALL_NODE_VERSION:-v24.11.0}"

say()  { printf '\033[32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn\033[0m %s\n' "$*"; }
die()  { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }

for cmd in curl tar; do command -v "$cmd" >/dev/null || die "$cmd is required but not installed"; done

# Declared up front: the EXIT trap references both, and `set -u` would abort on an unset one.
TMP=""; TMP2=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; [ -n "$TMP2" ] && rm -rf "$TMP2"; return 0; }
trap cleanup EXIT

OS="$(uname -s)"
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)
    # A Rosetta shell on Apple Silicon reports x86_64; ask the kernel what we really are.
    if [ "$OS" = "Darwin" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
case "$OS" in Darwin) NODE_OS=darwin ;; Linux) NODE_OS=linux ;; *) die "unsupported OS: $OS" ;; esac

# ---------------------------------------------------------------- Node
node_ok() {
  local n="$1"
  [ -x "$n" ] || return 1
  local v; v="$("$n" -p 'process.versions.node' 2>/dev/null)" || return 1
  local maj="${v%%.*}"; local rest="${v#*.}"; local min="${rest%%.*}"
  [ "$maj" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$maj" -eq "$NODE_MIN_MAJOR" ] && [ "$min" -ge "$NODE_MIN_MINOR" ] && return 0
  return 1
}

NODE_BIN=""
if command -v node >/dev/null && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
  say "using your Node $("$NODE_BIN" -p process.versions.node)"
elif node_ok "$HOME_DIR/runtime/bin/node"; then
  NODE_BIN="$HOME_DIR/runtime/bin/node"
  say "using the Node we installed earlier"
else
  # node:sqlite is unflagged from 22.13.0, which is why that is the floor. We install a private
  # runtime rather than telling a non-developer to go and set up nvm first.
  say "installing a private Node $NODE_VERSION (your system Node is untouched)"
  TARBALL="node-$NODE_VERSION-$NODE_OS-$ARCH.tar.gz"
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$TMP/node.tar.gz" \
    || die "could not download Node $NODE_VERSION for $NODE_OS-$ARCH"
  if curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" 2>/dev/null; then
    EXPECTED="$(grep " $TARBALL\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
    if [ -n "$EXPECTED" ]; then
      if command -v shasum >/dev/null; then ACTUAL="$(shasum -a 256 "$TMP/node.tar.gz" | awk '{print $1}')"
      else ACTUAL="$(sha256sum "$TMP/node.tar.gz" | awk '{print $1}')"; fi
      [ "$EXPECTED" = "$ACTUAL" ] || die "Node download failed its checksum - refusing to install it"
      say "checksum verified"
    fi
  else
    warn "could not fetch Node checksums; continuing without verification"
  fi
  rm -rf "$HOME_DIR/runtime"; mkdir -p "$HOME_DIR/runtime"
  tar -xzf "$TMP/node.tar.gz" -C "$HOME_DIR/runtime" --strip-components=1
  NODE_BIN="$HOME_DIR/runtime/bin/node"
  # Never assume it will run: Gatekeeper and quarantine are real on macOS.
  if ! "$NODE_BIN" -e 'process.exit(0)' 2>/dev/null; then
    xattr -dr com.apple.quarantine "$HOME_DIR/runtime" 2>/dev/null || true
    "$NODE_BIN" -e 'process.exit(0)' 2>/dev/null || die "the downloaded Node will not run on this machine"
  fi
  say "Node ready: $("$NODE_BIN" -p process.versions.node)"
fi

# ------------------------------------------------------------- opencode
OPENCODE=""
for c in "$HOME/.opencode/bin/opencode" /opt/homebrew/bin/opencode /usr/local/bin/opencode "$HOME/.bun/bin/opencode"; do
  [ -x "$c" ] && OPENCODE="$c" && break
done
[ -z "$OPENCODE" ] && command -v opencode >/dev/null && OPENCODE="$(command -v opencode)"
if [ -z "$OPENCODE" ]; then
  say "installing opencode"
  curl -fsSL https://opencode.ai/install | bash || warn "opencode install failed - coldcall will still start and show you how to fix it"
  [ -x "$HOME/.opencode/bin/opencode" ] && OPENCODE="$HOME/.opencode/bin/opencode"
fi
[ -n "$OPENCODE" ] && say "opencode: $OPENCODE ($("$OPENCODE" --version 2>/dev/null || echo '?'))"

# ------------------------------------------------------------ the app
say "downloading coldcall"
TMP2="$(mktemp -d)"
# Three ways in, in order of preference:
#   1. an explicit tarball URL (used by the install tests)
#   2. the gh CLI, which works for a PRIVATE repo using your existing auth
#   3. a plain public download
if [ -n "${COLDCALL_TARBALL_URL:-}" ]; then
  curl -fsSL "$COLDCALL_TARBALL_URL" -o "$TMP2/app.tar.gz" \
    || die "could not download coldcall from $COLDCALL_TARBALL_URL"
elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  say "downloading via gh (works for a private repo)"
  gh api "repos/$REPO/tarball/$REF" > "$TMP2/app.tar.gz" \
    || die "gh could not download $REPO@$REF - check you have access"
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$TMP2/app.tar.gz" \
    || die "could not download $REPO@$REF. If the repo is private, install the GitHub CLI and run: gh auth login"
fi
rm -rf "$APP_DIR.partial"; mkdir -p "$APP_DIR.partial"
tar -xzf "$TMP2/app.tar.gz" -C "$APP_DIR.partial" --strip-components=1
[ -f "$APP_DIR.partial/bin/coldcall.js" ] || die "the downloaded archive does not look like coldcall"

say "installing dependencies"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || die "npm not found next to $NODE_BIN and not on PATH"
( cd "$APP_DIR.partial" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error ) \
  || die "dependency install failed"

# Swap only once everything above succeeded, so an interrupted install leaves the old one working.
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.partial" "$APP_DIR"
rm -rf "$APP_DIR.old"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/coldcall" <<SHIM
#!/bin/sh
exec "$NODE_BIN" "$APP_DIR/bin/coldcall.js" "\$@"
SHIM
chmod +x "$BIN_DIR/coldcall"

# ------------------------------------------------------------------ PATH
add_path_line() {
  local rc="$1"
  [ -f "$rc" ] || touch "$rc"
  grep -q '# >>> coldcall >>>' "$rc" && return 0
  printf '\n# >>> coldcall >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< coldcall <<<\n' >> "$rc"
  say "added ~/.local/bin to PATH in $rc"
}
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0
     case "${SHELL:-}" in *zsh) add_path_line "$HOME/.zshrc" ;; *bash) add_path_line "$HOME/.bashrc" ;;
       *) add_path_line "$HOME/.zshrc" ;; esac ;;
esac

mkdir -p "$HOME_DIR"; chmod 700 "$HOME_DIR"

echo
say "coldcall is installed."
echo
[ "$ON_PATH" = "0" ] && printf '  For this terminal, run:\n    export PATH="$HOME/.local/bin:$PATH"\n\n'
printf '  Then start it with:\n    coldcall\n\n'
if [ -n "$OPENCODE" ]; then
  if ! "$OPENCODE" auth list 2>/dev/null | grep -qiE 'credential|oauth|api'; then
    printf '  First, sign in to a model provider (free options available):\n    opencode auth login\n\n'
  fi
else
  printf '  opencode is not installed yet. Install it with:\n    curl -fsSL https://opencode.ai/install | bash\n\n'
fi
printf '  Your data lives in %s and is never uploaded anywhere.\n' "$HOME_DIR"
