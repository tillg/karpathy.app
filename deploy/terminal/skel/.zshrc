# The app's terminal (#175): zsh with oh-my-zsh and powerlevel10k, like the Mac. Copied into the home volume once,
# when it had no .zshrc: edit it freely, deploys leave it alone (delete it to get the image's again).

# powerlevel10k's instant prompt: keep at the top.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# oh-my-zsh and the theme live in the image (pinned in deploy/terminal/Dockerfile); its caches in the home.
export ZSH=/usr/share/oh-my-zsh
ZSH_CUSTOM=/usr/share/oh-my-zsh-custom
ZSH_CACHE_DIR="$HOME/.cache/oh-my-zsh"
ZSH_COMPDUMP="$ZSH_CACHE_DIR/.zcompdump"
ZSH_THEME="powerlevel10k/powerlevel10k"
POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true
zstyle ':omz:update' mode disabled
plugins=(git)

HISTFILE="$HOME/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000

mkdir -p "$ZSH_CACHE_DIR/completions"
source "$ZSH/oh-my-zsh.sh"

# The prompt's look: `p10k configure` rewrites this file.
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh
