# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# --- Oh My Zsh ---
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="powerlevel10k/powerlevel10k"
plugins=(git zsh-autosuggestions zsh-syntax-highlighting)
source $ZSH/oh-my-zsh.sh

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
