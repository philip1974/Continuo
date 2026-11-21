# SDK Contract Shape Specs

Shape specs pin what plugin code can see before crossing into main-process
services.

- T1: Plugin SDK TypeScript method signatures stay compatible.
- T2: Runtime SDK objects expose the methods promised by the types.
- T3: ScopedApp permission proxy and token closure behavior stay stable.
- T4: `coApp.version` stays in sync with `package.json`.
- T5: In-repo web-compat patterns stay within the audited allowlist.

Detailed assertions are filled by Op3-Op6 specs.
