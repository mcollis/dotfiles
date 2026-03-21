# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

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

# --- Aliases ---
alias v="nvim"
alias c="clear"

# --- Functions ---

kill-vscode-watchers() {
    for pid in $(ps aux | grep "vscode.*fileWatcher" | grep -v grep | awk '{print $2}'); do
        echo "Killing file watcher PID $pid"
        kill "$pid"
    done
}

# --- Powerlevel10k ---
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
