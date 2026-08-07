# Third-Party Notices

## FFmpeg

Caevir includes executables from the FFmpeg project and invokes them as separate processes for local media metadata extraction and thumbnail generation.

This software uses code of [FFmpeg](https://ffmpeg.org/) licensed under the [GNU Lesser General Public License, version 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html).

- Distributed build: FFmpeg 8.1, Windows x64, LGPL static variant
- Binary build project: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
- Corresponding FFmpeg source: the exact source commit URL is recorded in the bundled `FFmpeg-BUILD.txt`; stable release sources are available from [FFmpeg 8.1 source archive](https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz)
- FFmpeg license information: [FFmpeg Legal](https://ffmpeg.org/legal.html)

FFmpeg is not owned by the Caevir project. The bundled runtime is kept under its original name and license. The build-time preparation script verifies the SHA-256 checksum published with the BtbN release before the runtime is packaged.

## vgmstream

Caevir includes the Windows x64 `vgmstream-cli` runtime and invokes it as a separate local process to decode FSB game-audio banks to WAV.

[vgmstream](https://github.com/vgmstream/vgmstream) is distributed under the BSD 3-Clause License. The prepared runtime retains the upstream `COPYING` file and accompanying codec libraries. The build preparation script pins release `r2117` and verifies the SHA-256 digest published by GitHub before packaging.

## Python

Caevir includes the official Windows embeddable distribution of Python 3.12.6 to run the local background-removal module. Python is distributed under the Python Software Foundation License Version 2. The complete license text is included in the prepared runtime as `LICENSE.txt`; source and release files are available from [Python 3.12.6](https://www.python.org/downloads/release/python-3126/).

## rembg and BiRefNet

Caevir invokes [rembg](https://github.com/danielgatis/rembg) as a local Python library for image background removal. rembg is licensed under the MIT License. Its installed distribution metadata and license are included with the bundled Python runtime.

The selectable BiRefNet models are based on [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), licensed under the MIT License. Model files are not shipped in the installer; rembg downloads the selected ONNX model on first use and stores it in the user's Caevir application-data directory.

The bundled Python runtime also contains rembg's runtime dependencies, including ONNX Runtime and Pillow. Their package metadata and license files are retained under `Lib/site-packages`.

## pngquant / libimagequant

Caevir uses [libimagequant](https://pngquant.org/lib/), the official quantization engine behind [pngquant](https://pngquant.org/), for optional lossy PNG compression. The integrated Rust crate version is 4.4.1.

libimagequant is dual-licensed. Free and open-source use is available under the GNU General Public License version 3 or later; closed-source distribution, App Store distribution, and other non-GPL uses require a commercial license from the copyright holder. Distributors of Caevir are responsible for selecting and complying with the license appropriate to their distribution model.

- Source: [ImageOptim/libimagequant](https://github.com/ImageOptim/libimagequant)
- License and commercial licensing information: [libimagequant licensing](https://pngquant.org/lib/)

## OxiPNG

Caevir uses [OxiPNG](https://github.com/oxipng/oxipng) 10.1.1 for lossless PNG optimization. OxiPNG is licensed under the MIT License. Pixel-preserving mode disables alpha optimization and 16-bit scaling so decoded pixel values are not changed.
