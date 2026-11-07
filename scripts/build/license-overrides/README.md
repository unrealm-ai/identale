# Version-specific license supplements

The installed packages below omit a standalone license file. These supplements
are selected only when the exact package name, version, declared license and
lockfile integrity match `manifest.json`. They are not generic fallbacks for
other dependencies or versions. Every build verifies the text's SHA-256.
Unrecognized missing licenses stop the build.

## css-render 0.15.14 family

`css-render`, `@css-render/plugin-bem`, and `@css-render/vue3-ssr` at 0.15.14
declare MIT but omit the repository's root license from their npm packages.
`css-render-0.15.14-LICENSE.txt` is the complete, unchanged upstream license:

- [License at commit 4fd3b95ecedb17bffafabc00e93ce6eab843e716](https://github.com/07akioni/css-render/blob/4fd3b95ecedb17bffafabc00e93ce6eab843e716/LICENSE)
- Same-commit package metadata: [css-render](https://github.com/07akioni/css-render/blob/4fd3b95ecedb17bffafabc00e93ce6eab843e716/packages/css-render/package.json), [plugin-bem](https://github.com/07akioni/css-render/blob/4fd3b95ecedb17bffafabc00e93ce6eab843e716/packages/plugin-bem/package.json), [vue3-ssr](https://github.com/07akioni/css-render/blob/4fd3b95ecedb17bffafabc00e93ce6eab843e716/packages/vue3-ssr/package.json).

All three manifests at that commit specify 0.15.14. The commit message says
0.15.4; the actual manifests, rather than that apparent typo, were checked.
No author or copyright year was inferred from the repository owner.

## vdirs 0.1.8: unresolved upstream attribution

The installed 0.1.8 package declares `license: MIT` and `author: 07akioni`, but
contains no license text or copyright notice. Its published JavaScript and
README contain none either. The inspected [upstream source](https://github.com/07akioni/vdirs/tree/8a95663e628030c6d014b8a3aa51df3c267e739b)
has no LICENSE file and its package.json still says 0.1.7. It cannot be treated
as exact-version copyright evidence for 0.1.8.

`vdirs-0.1.8-MIT-terms.txt` preserves all operative terms of the
[SPDX MIT template](https://github.com/spdx/license-list-data/blob/main/text/MIT.txt),
retrieved 2026-11-07, Git blob `d817195dad53ec992418c28ffca5fbd1cd86502a`.
Only its `Copyright (c) <year> <copyright holders>` placeholder line is omitted.
It is **not** represented as an original upstream license. The build logs,
distribution notice and manifest explicitly retain this evidence gap and the
published author metadata, without asserting a copyright holder or year.

This makes the current build usable but does not establish complete upstream
copyright provenance. Before claiming a fully verified public redistribution,
the maintainer must obtain the missing notice or choose an authorized dependency
replacement. No message has been sent to upstream maintainers by this change.

## NOTICE handling

The collector copies every matching LICENSE / LICENCE / COPYING / COPYRIGHT /
NOTICE / third-party license or notice file in each installed package, excluding
nested `node_modules` and dot-directories. It reports whether standalone NOTICE
files were actually found. For `@juggle/resize-observer@3.4.0`, the complete
installed Apache-2.0 LICENSE includes `Copyright 2019 JUGGLE LTD`; its package
contains no separate NOTICE. Absence is recorded, not replaced with invented
attribution. Upstream license files can include notices for bundled code and are
kept in full rather than reduced to an SPDX identifier.
