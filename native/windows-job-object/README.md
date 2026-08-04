# OpenClaw Windows Job Object native bridge

This first-party Node-API addon is the native half of
`src/process/supervisor/windows-native-job-bridge.ts`. It intentionally has no shell or `taskkill`
fallback.

The addon:

- creates or opens named Job Objects;
- enables `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
- creates child processes with `CREATE_SUSPENDED`;
- exposes assignment, membership query, and resume as separate ABI calls so TypeScript enforces and
  tests their order;
- records process creation time in addition to PID;
- exposes exact job termination and process/job completion queries;
- returns CRT descriptors for captured stdin/stdout/stderr pipes.

Build on Windows with a Node.js distribution containing Node-API headers and `node-gyp`:

```powershell
cd native/windows-job-object
npm run build
```

The local build artifact is
`native/windows-job-object/build/Release/openclaw_windows_job_object.node`. An approved release must
copy the architecture-specific artifact to
`dist/native/windows-job-object/openclaw_windows_job_object.node`. Runtime loading accepts only that
package-relative built location and checks ABI version `1`; it never searches the working directory.
Packaging the artifact for supported Windows architectures requires dependency and release approval;
real Windows build/E2E evidence remains PSB-004.

ConPTY is not silently emulated. PTY launches fail closed until the first-party bridge grows a
ConPTY implementation with the same Job Object ownership guarantees.
