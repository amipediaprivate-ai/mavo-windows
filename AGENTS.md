# Project workflow constraints

- This directory is an independent Git repository for the Windows project. Its repository root must remain `mavo-windows`, and it must not be absorbed into a Git repository at the parent `mavo` directory.
- Keep this repository associated only with `amipediaprivate-ai/mavo-windows`. Do not change its remote to the Web repository or push Windows commits anywhere else.
- Before any Git write or remote operation, verify that `git rev-parse --show-toplevel` resolves to the `mavo-windows` directory.
- Never stage, commit, or push files from the parent workspace or from the sibling `mavo-web` project in this repository.
- Store Windows-specific Markdown documentation in `mavo-windows/docs/`. Cross-project documentation belongs in the parent `mavo/docs/` directory and must not be committed to this repository.
- The desktop application must never open, flash, or expose a system command-line or console window while users are running Caevir. Every runtime child process on Windows must be created without a console window.
- If a workflow requires user-visible command interaction, progress, logs, or output, implement it as a dedicated module embedded in the Caevir frontend instead of launching an external terminal window.
- After modifying any source code, configuration, or build-related file, force-stop every running `caevir.exe` process before rebuilding.
- Perform a complete desktop application rebuild after the process has stopped. A frontend-only build is not sufficient.
- Do not report the change as complete unless the desktop rebuild succeeds.
- Never leave a pre-change Caevir process running after making modifications.
- At the end of every conversation, commit the completed work and push it to the configured Git remote. If pushing fails, report the failure and its cause explicitly.
