#!/usr/bin/env zsh
set -euo pipefail

# Update these revisions deliberately after testing the new versions locally.
readonly OH_MY_ZSH_REVISION="98fe9b81a62ed75baf25cf23aa41e338a83bec6d"
readonly AUTOSUGGESTIONS_REVISION="85919cd1ffa7d2d5412f6d3fe437ebdbeeec4fc5"
readonly SYNTAX_HIGHLIGHTING_REVISION="1d85c692615a25fe2293bdd44b34c217d5d2bf04"

install_dependencies() {
  case "$OSTYPE" in
    darwin*)
      command -v brew >/dev/null 2>&1 || {
        print -u2 "Homebrew is required on macOS: https://brew.sh"
        return 1
      }
      brew install zsh fzf fd zoxide
      "$(brew --prefix fzf)/install" --key-bindings --completion --no-update-rc
      ;;
    linux-gnu*)
      [[ -r /etc/os-release ]] || {
        print -u2 "Only Debian/Ubuntu Linux is supported."
        return 1
      }
      source /etc/os-release
      [[ " ${ID_LIKE:-} ${ID:-} " == *" debian "* ]] || {
        print -u2 "Only Debian/Ubuntu Linux is supported."
        return 1
      }
      sudo apt-get update
      sudo apt-get install -y zsh fzf fd-find zoxide
      ;;
    *)
      print -u2 "Unsupported platform: $OSTYPE"
      return 1
      ;;
  esac
}

checkout_pinned_repository() {
  local repository=$1
  local destination=$2
  local revision=$3

  if [[ -e "$destination" && ! -d "$destination/.git" ]]; then
    print -u2 "Refusing to replace non-Git path: $destination"
    return 1
  fi

  if [[ ! -d "$destination/.git" ]]; then
    git clone "$repository" "$destination"
  fi

  git -C "$destination" fetch origin "$revision"
  git -C "$destination" checkout --detach "$revision"
}

install_dependencies

ZSH_DIR="${ZSH:-$HOME/.oh-my-zsh}"
checkout_pinned_repository "https://github.com/ohmyzsh/ohmyzsh.git" "$ZSH_DIR" "$OH_MY_ZSH_REVISION"
checkout_pinned_repository "https://github.com/zsh-users/zsh-autosuggestions.git" "$ZSH_DIR/custom/plugins/zsh-autosuggestions" "$AUTOSUGGESTIONS_REVISION"
checkout_pinned_repository "https://github.com/zsh-users/zsh-syntax-highlighting.git" "$ZSH_DIR/custom/plugins/zsh-syntax-highlighting" "$SYNTAX_HIGHLIGHTING_REVISION"

print "Shell dependencies installed. Restart your shell to load them."
