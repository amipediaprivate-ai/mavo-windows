# Third-Party Notices

## FFmpeg

Mavo includes executables from the FFmpeg project and invokes them as separate processes for local media metadata extraction and thumbnail generation.

This software uses code of [FFmpeg](https://ffmpeg.org/) licensed under the [GNU Lesser General Public License, version 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html).

- Distributed build: FFmpeg 8.1, Windows x64, LGPL static variant
- Binary build project: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
- Corresponding FFmpeg source: the exact source commit URL is recorded in the bundled `FFmpeg-BUILD.txt`; stable release sources are available from [FFmpeg 8.1 source archive](https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz)
- FFmpeg license information: [FFmpeg Legal](https://ffmpeg.org/legal.html)

FFmpeg is not owned by the Mavo project. The bundled runtime is kept under its original name and license. The build-time preparation script verifies the SHA-256 checksum published with the BtbN release before the runtime is packaged.
