[ -n "$_CONTINUO_USER_BASH_RC" ] && [ -f "$_CONTINUO_USER_BASH_RC" ] && source "$_CONTINUO_USER_BASH_RC"

_continuo_osc7() {
  printf '\e]7;file://%s%s\a' "${HOSTNAME:-}" "$PWD"
}

if [ -n "${PROMPT_COMMAND:-}" ]; then
  PROMPT_COMMAND="_continuo_osc7; ${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="_continuo_osc7"
fi

_continuo_osc7
