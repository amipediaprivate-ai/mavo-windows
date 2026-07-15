# Project workflow constraints

- The desktop application must never open, flash, or expose a system command-line or console window while users are running Mavo. Every runtime child process on Windows must be created without a console window.
- If a workflow requires user-visible command interaction, progress, logs, or output, implement it as a dedicated module embedded in the Mavo frontend instead of launching an external terminal window.
- After modifying any source code, configuration, or build-related file, force-stop every running `mavo.exe` process before rebuilding.
- Perform a complete desktop application rebuild after the process has stopped. A frontend-only build is not sufficient.
- Do not report the change as complete unless the desktop rebuild succeeds.
- Never leave a pre-change Mavo process running after making modifications.
- At the end of every conversation, commit the completed work and push it to the configured Git remote. If pushing fails, report the failure and its cause explicitly.
