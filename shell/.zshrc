# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
typeset -g POWERLEVEL9K_INSTANT_PROMPT=quiet
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# --- PATH ---
[[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && PATH="$HOME/.local/bin:$PATH"
[[ -d /opt/nvim && ":$PATH:" != *":/opt/nvim:"* ]] && PATH="/opt/nvim:$PATH"
[[ ":$PATH:" != *":$HOME/.cargo/bin:"* ]] && PATH="$HOME/.cargo/bin:$PATH"

# --- Oh My Zsh ---
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="powerlevel10k/powerlevel10k"

plugins=(git zsh-autosuggestions zsh-syntax-highlighting fzf)
[[ -r "$ZSH/oh-my-zsh.sh" ]] && source "$ZSH/oh-my-zsh.sh"

# --- fzf ---
# herdr draws its own panes. When the herdr server is started from inside a
# tmux pane it leaks $TMUX/$TMUX_PANE into every pane it spawns, which makes
# fzf's __fzfcmd pick fzf-tmux and try to draw its popup in an invisible tmux
# pane -- Ctrl+R then hangs the herdr pane. Drop the stale vars in herdr panes.
[[ "$HERDR_ENV" == "1" ]] && unset TMUX TMUX_PANE

# fzf configuration
export FZF_TMUX_OPTS="-p80%,60%"  # Open in tmux popup (requires tmux 3.2+)
export FZF_DEFAULT_OPTS="--height 40% --layout=reverse --border --preview-window=right:50%"

# Use fd instead of find for better performance (if available)
if command -v fd &> /dev/null; then
  FZF_FD_COMMAND=fd
elif command -v fdfind &> /dev/null; then
  alias fd=fdfind
  FZF_FD_COMMAND=fdfind
fi
if [[ -n "${FZF_FD_COMMAND:-}" ]]; then
  export FZF_DEFAULT_COMMAND="$FZF_FD_COMMAND --type f --hidden --follow --exclude .git"
  export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
  export FZF_ALT_C_COMMAND="$FZF_FD_COMMAND --type d --hidden --follow --exclude .git"
fi

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# --- zoxide ---
command -v zoxide >/dev/null 2>&1 && eval "$(zoxide init zsh)"

# --- direnv ---
export HERDR_REMOTE_KEYBINDINGS=server
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
export PATH="$HOME/.opencode/bin:$PATH"

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi

# >>> portal PATH (clip shims) >>>
# Ensures portal's clipboard shims (~/.local/bin/xclip, wl-paste) win on PATH.
PATH="$HOME/.local/bin:$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$HOME/.local/bin" | paste -sd: -)"
export PATH
# <<< portal PATH (clip shims) <<<

[ -f ~/.config/portal/env.sh ] && . ~/.config/portal/env.sh
