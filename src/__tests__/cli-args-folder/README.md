# cli-args-folder (Issue #45)

BDD coverage for parsing absolute existing-directory paths from `process.argv`, supporting packaged mode (`skipFirstArg=false`) and dev mode (`skipFirstArg=true`, where `argv[1]='.'` is ignored). `skipAll` disables parsing entirely so launcher/test argv cannot accidentally enter dock mode.
