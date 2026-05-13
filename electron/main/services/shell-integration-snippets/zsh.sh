[ -f "$_CONTINUO_USER_ZDOTDIR/.zshrc" ] && source "$_CONTINUO_USER_ZDOTDIR/.zshrc"

_continuo_osc7() {
  printf '\e]7;file://%s%s\a' "${HOST:-}" "$PWD"
}

typeset -ag chpwd_functions
chpwd_functions+=(_continuo_osc7)
_continuo_osc7
