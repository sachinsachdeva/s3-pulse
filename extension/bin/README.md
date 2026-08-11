# Bundled backend binaries

Place release binaries at these exact paths before packaging:

```text
bin/darwin-arm64/s3pulse
bin/darwin-x64/s3pulse
bin/linux-arm64/s3pulse
bin/linux-x64/s3pulse
bin/win32-arm64/s3pulse.exe
bin/win32-x64/s3pulse.exe
```

Unix executables must have mode `0755`. The extension never invokes a shell.

`npm run stage-backend` copies a local build into the path for the current
platform, defaulting to the debug profile. Pass `--release` before packaging, so
a development build is never bundled into a VSIX.
