# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
typeset -g POWERLEVEL9K_INSTANT_PROMPT=quiet
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# --- PATH ---
[[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && PATH="$HOME/.local/bin:$PATH"
[[ ":$PATH:" != *":/opt/nvim:"* ]] && PATH="/opt/nvim:$PATH"
[[ ":$PATH:" != *":$HOME/.cargo/bin:"* ]] && PATH="$HOME/.cargo/bin:$PATH"

# --- Oh My Zsh ---
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="powerlevel10k/powerlevel10k"

# Auto-install plugins if not present
if [[ ! -d "$ZSH/custom/plugins/zsh-autosuggestions" ]]; then
  git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH/custom/plugins/zsh-autosuggestions"
fi

if [[ ! -d "$ZSH/custom/plugins/zsh-syntax-highlighting" ]]; then
  git clone https://github.com/zsh-users/zsh-syntax-highlighting "$ZSH/custom/plugins/zsh-syntax-highlighting"
fi

plugins=(git zsh-autosuggestions zsh-syntax-highlighting fzf)
source $ZSH/oh-my-zsh.sh

# --- fzf ---
# herdr draws its own panes. When the herdr server is started from inside a
# tmux pane it leaks $TMUX/$TMUX_PANE into every pane it spawns, which makes
# fzf's __fzfcmd pick fzf-tmux and try to draw its popup in an invisible tmux
# pane -- Ctrl+R then hangs the herdr pane. Drop the stale vars in herdr panes.
[[ "$HERDR_ENV" == "1" ]] && unset TMUX TMUX_PANE

# Auto-install fzf if not present
if ! command -v fzf &> /dev/null; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "Installing fzf via Homebrew..."
    brew install fzf
    /opt/homebrew/opt/fzf/install --key-bindings --completion --no-update-rc
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux (Ubuntu/Debian)
    echo "Installing fzf via apt..."
    sudo apt-get update && sudo apt-get install -y fzf
  fi
fi

# Auto-install fd if not present (for better fzf performance)
if ! command -v fd &> /dev/null; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "Installing fd via Homebrew..."
    brew install fd
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux (Ubuntu/Debian)
    echo "Installing fd via apt..."
    sudo apt-get update && sudo apt-get install -y fd-find
    # Create symlink as Ubuntu installs it as 'fdfind'
    mkdir -p ~/.local/bin
    ln -sf $(which fdfind) ~/.local/bin/fd
  fi
fi

# fzf configuration
export FZF_TMUX_OPTS="-p80%,60%"  # Open in tmux popup (requires tmux 3.2+)
export FZF_DEFAULT_OPTS="--height 40% --layout=reverse --border --preview-window=right:50%"

# Use fd instead of find for better performance (if available)
if command -v fd &> /dev/null; then
  export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
  export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
  export FZF_ALT_C_COMMAND='fd --type d --hidden --follow --exclude .git'
fi

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# --- zoxide ---
# Auto-install zoxide if not present
if ! command -v zoxide &> /dev/null; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Installing zoxide via Homebrew..."
    brew install zoxide
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "Installing zoxide via apt..."
    sudo apt-get update && sudo apt-get install -y zoxide
  fi
fi

eval "$(zoxide init zsh)"

# --- direnv ---
export DIRENV_LOG_FORMAT=""
command -v direnv > /dev/null && eval "$(direnv hook zsh)"

# --- Aliases ---
alias v="nvim"
alias c="clear"

# --- Functions ---

# Fast-forward the current repo's HEAD branch from origin. Useful in a bare
# repo whose HEAD points at a base branch (e.g. release/<codename>) you never
# check out — keeps it in sync without needing a worktree.
gfh() {
    local hb
    hb=$(git symbolic-ref --short HEAD 2>/dev/null) || {
        echo "gfh: HEAD is detached" >&2
        return 1
    }
    git fetch origin "$hb:$hb"
}

kill-vscode-watchers() {
    for pid in $(ps aux | grep "vscode.*fileWatcher" | grep -v grep | awk '{print $2}'); do
        echo "Killing file watcher PID $pid"
        kill "$pid"
    done
}

# Tail the webpack-dev-server log. Path comes from $WEBPACK_LOG (set by direnv).
wptail() {
    if [ -z "${WEBPACK_LOG:-}" ]; then
        echo "wptail: \$WEBPACK_LOG not set — cd into a worktree with .envrc loaded" >&2
        return 1
    fi
    if [ ! -f "$WEBPACK_LOG" ]; then
        echo "wptail: no log at $WEBPACK_LOG (start webpack with /start-webpack in Claude)" >&2
        return 1
    fi
    echo "Tailing $WEBPACK_LOG"
    tail -F "$WEBPACK_LOG"
}

# --- Powerlevel10k ---
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# opencode
export PATH=/home/michaelco/.opencode/bin:$PATH

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi

# >>> portal PATH (clip shims) >>>
# Ensures portal's clipboard shims (~/.local/bin/xclip, wl-paste) win on PATH.
PATH="$HOME/.local/bin:$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$HOME/.local/bin" | paste -sd: -)"
export PATH
# <<< portal PATH (clip shims) <<<

[ -f ~/.config/portal/env.sh ] && . ~/.config/portal/env.sh
