# OpenNBS interoperability fixture

`open-nbs-nyan-cat-v6.nbs.base64` is a byte-for-byte Base64 encoding of
OpenNBS's compact bundled demo song `datafiles/Songs/Nyan Cat.nbs`.
Tests decode it locally; they never access the network.

- Upstream: <https://github.com/OpenNBS/NoteBlockStudio>
- Development commit: `abbf7d52c279e08ce8f12799495bfbfb882280c2`
- Source: <https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/datafiles/Songs/Nyan%20Cat.nbs>
- Git blob SHA-1: `0fcb3660be64c5ff0e1ed824affb0719c995b230`
- Decoded byte length: `10845`
- Decoded SHA-256: `94b0e69270e0bce404d0d49f00c1c94568229e0eb76d7ba32e1fde5e31291973`
- Format: NBS v6
- Transformation: Base64 encoding only

## Independent reference reader

Interop tests use the official, dependency-free `@nbsjs/core` package at the
exact version `6.1.0` (upstream Git commit
`8d5a01c3398726163a112443b89f9e9827a3029a`). The package tarball is pinned in
`package-lock.json` with integrity
`sha512-mc9Y810VOa2+ioKD/jNPsBsbWj0ZfGCWNlrbpFddgbjviXj2SIzfpuaWAFghe/rELHDYZZfWGkfx5TguTLk1Iw==`.
The test suite reads only the checked-in fixture and installed package; it does
not fetch data at test time.

The fixture is redistributed under the upstream MIT license:

> MIT License
>
> Copyright (c) 2026 OpenNBS
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
