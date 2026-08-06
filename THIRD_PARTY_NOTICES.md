# Third-Party Notices

## FFmpeg

Caevir includes executables from the FFmpeg project and invokes them as separate processes for local media metadata extraction and thumbnail generation.

This software uses code of [FFmpeg](https://ffmpeg.org/) licensed under the [GNU Lesser General Public License, version 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html).

- Distributed build: FFmpeg 8.1, Windows x64, LGPL static variant
- Binary build project: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
- Corresponding FFmpeg source: the exact source commit URL is recorded in the bundled `FFmpeg-BUILD.txt`; stable release sources are available from [FFmpeg 8.1 source archive](https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz)
- FFmpeg license information: [FFmpeg Legal](https://ffmpeg.org/legal.html)

FFmpeg is not owned by the Caevir project. The bundled runtime is kept under its original name and license. The build-time preparation script verifies the SHA-256 checksum published with the BtbN release before the runtime is packaged.

## Python

Caevir includes the official Windows embeddable distribution of Python 3.12.6 to run the local background-removal module. Python is distributed under the Python Software Foundation License Version 2. The complete license text is included in the prepared runtime as `LICENSE.txt`; source and release files are available from [Python 3.12.6](https://www.python.org/downloads/release/python-3126/).

## rembg and BiRefNet

Caevir invokes [rembg](https://github.com/danielgatis/rembg) as a local Python library for image background removal. rembg is licensed under the MIT License. Its installed distribution metadata and license are included with the bundled Python runtime.

The selectable BiRefNet models are based on [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), licensed under the MIT License. Model files are not shipped in the installer; rembg downloads the selected ONNX model on first use and stores it in the user's Caevir application-data directory.

The bundled Python runtime also contains rembg's runtime dependencies, including ONNX Runtime and Pillow. Their package metadata and license files are retained under `Lib/site-packages`.
