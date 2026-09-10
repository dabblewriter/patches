# Changelog

## [0.31.1](https://github.com/dabblewriter/patches/compare/v0.31.0...v0.31.1) (2026-09-10)


### Bug Fixes

* **client:** count live outbox rows when a reload asks for pending work beyond the confirmed batch (DAB-1340) ([6883c26](https://github.com/dabblewriter/patches/commit/6883c26d6d451978c2f26c6d624892c50dea63df))
* **ot:** cap the catch-up a commit echoes and answer docReloadRequired past it (DAB-1340) ([fa10cd8](https://github.com/dabblewriter/patches/commit/fa10cd8268a9434d1461019040b2dc4295bb4ccf))

## [0.31.0](https://github.com/dabblewriter/patches/compare/v0.30.2...v0.31.0) (2026-09-09)


### Features

* **client:** send store-refused changes from memory through an outbox (storage hardening A1) ([d8488e5](https://github.com/dabblewriter/patches/commit/d8488e54738a3a7ccef6a1884a040a5298c85e17))
* **client:** send store-refused changes from memory through an outbox (storage hardening A1) ([f8fa9c8](https://github.com/dabblewriter/patches/commit/f8fa9c8b4d45be4ac81a0ef805d96f9402d76e4b))


### Bug Fixes

* **client:** keep a confirmed outbox row as a stub until the doc covers its rev; never freeze over in-frame pending rows (review round 3) ([d376104](https://github.com/dabblewriter/patches/commit/d3761047084f7653e452b06d8581b2c254512a72))
* **client:** keep outbox rows in frame across rebuilds and reloads, re-mint accepted rows once the queue drains (review) ([f592469](https://github.com/dabblewriter/patches/commit/f5924695c25b2e78fe79da30ac859d7a3a140646))
* **client:** send outbox rows at their own frame, walk frozen rows forward, confirm from the response, bound the outbox (review round 2) ([05c8b20](https://github.com/dabblewriter/patches/commit/05c8b20a4f569154826b134a24003e097b5ef546))
* **client:** walk rows queued during the span read; drop refused rows from the doc instead of re-driving them raw (review round 4) ([5e90702](https://github.com/dabblewriter/patches/commit/5e907022f84aa69a1809d9b2a53b6dcf354c7858))
* **sync:** tell the app before wiping a remotely deleted doc's rows (review round 2) ([6771795](https://github.com/dabblewriter/patches/commit/6771795652153b4a067f1451d8e96331390dbea6))
* **sync:** wipe a remotely deleted doc's local data, not just its tracking row (DAB-1141) ([a24b4ee](https://github.com/dabblewriter/patches/commit/a24b4ee8e06ea94073bd64eb85df6be88bbc94f1))
* **sync:** wipe a remotely deleted doc's local data, not just its tracking row (DAB-1141) ([26b86a1](https://github.com/dabblewriter/patches/commit/26b86a182dc702a3ad1a0b2d54eecc0437018d2a))

## [0.30.2](https://github.com/dabblewriter/patches/compare/v0.30.1...v0.30.2) (2026-09-04)


### Bug Fixes

* **ot:** reconstruct a poison's mint frame from in-frame predecessors only (DAB-1028) ([96056d9](https://github.com/dabblewriter/patches/commit/96056d9c687b72a7265af3065a39390afffa396b))
* **ot:** reconstruct a poison's mint frame from in-frame predecessors only (DAB-1028) ([8cfbebb](https://github.com/dabblewriter/patches/commit/8cfbebbdb626ca7874f2b0a41290c9d4dfca1993))
