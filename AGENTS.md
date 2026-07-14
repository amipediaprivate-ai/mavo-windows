# Project workflow constraints

- After modifying any source code, configuration, or build-related file, force-stop every running `mavo.exe` process before rebuilding.
- Perform a complete desktop application rebuild after the process has stopped. A frontend-only build is not sufficient.
- Do not report the change as complete unless the desktop rebuild succeeds.
- Never leave a pre-change Mavo process running after making modifications.
- At the end of every conversation, commit the completed work and push it to the configured Git remote. If pushing fails, report the failure and its cause explicitly.
