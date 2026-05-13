if test -n "$_CONTINUO_USER_FISH_CONFIG"; and test -f "$_CONTINUO_USER_FISH_CONFIG"
  source "$_CONTINUO_USER_FISH_CONFIG"
end

function _continuo_osc7 --on-variable PWD
  printf '\e]7;file://%s%s\a' (hostname) "$PWD"
end

_continuo_osc7
