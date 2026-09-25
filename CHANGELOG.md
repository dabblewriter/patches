# Changelog

## [0.32.2](https://github.com/dabblewriter/patches/compare/v0.32.1...v0.32.2) (2026-09-25)


### Bug Fixes

* **client:** settle flush() on a write-latched doc instead of spinning (DAB-1142) ([fe272f9](https://github.com/dabblewriter/patches/commit/fe272f9033613563533ff96d333a3e4c3b016ec2))
* **client:** settle flush() on a write-latched doc instead of spinning (DAB-1142) ([b9706b3](https://github.com/dabblewriter/patches/commit/b9706b38641f6924720fcdceb8fe70ec892bc93a))
* **sync:** close serialGate's re-entrancy window and await the queued pass (DAB-952) ([ab364ee](https://github.com/dabblewriter/patches/commit/ab364eeec5291b1e1e4942933feff7586298a557))
* **sync:** close serialGate's re-entrancy window and await the queued pass (DAB-952) ([248baba](https://github.com/dabblewriter/patches/commit/248babad3037adb6b15e60c8ac27a4b9b83684c2))
* **sync:** drain delete tombstones in the degraded-mode pass (DAB-1214) ([44e2b8a](https://github.com/dabblewriter/patches/commit/44e2b8ab9eb8ea030113b3106a402ad5dddc74d8))
* **sync:** drain delete tombstones in the degraded-mode pass (DAB-1214) ([80609c8](https://github.com/dabblewriter/patches/commit/80609c8acffd840ed093e7e0c61f42a6000304b2))
* **sync:** re-ask for subscriptions a failed subscribe left unregistered ([6b24f04](https://github.com/dabblewriter/patches/commit/6b24f0456578ee89d2c5d38ff687429ee361d453))
* **sync:** re-ask for subscriptions a failed subscribe left unregistered ([67994dc](https://github.com/dabblewriter/patches/commit/67994dcf0ec9873f9fb5b4664186f1eb8ba3a45e))
* **sync:** re-derive a flush's re-split when a receive made it stale (DAB-786) ([6b05fe4](https://github.com/dabblewriter/patches/commit/6b05fe4434008e4e490f1684c4ceb4129da72573))
* **sync:** re-derive a flush's re-split when a receive made it stale (DAB-786) ([9f6a4dc](https://github.com/dabblewriter/patches/commit/9f6a4dc3aec0031e80c4e6ce4be4728402c83bb6))

## [0.32.1](https://github.com/dabblewriter/patches/compare/v0.32.0...v0.32.1) (2026-09-24)


### Bug Fixes

* **sync:** keep a failed store read from stranding newly tracked docs (DAB-1558) ([777f189](https://github.com/dabblewriter/patches/commit/777f1898b812fc444597172c29eceb491b0e6e6f))
* **sync:** keep a failed store read from stranding newly tracked docs (DAB-1558) ([2f6e9ed](https://github.com/dabblewriter/patches/commit/2f6e9eda9b27b949134df625e9680c1b7bc1a29f))

## [0.32.0](https://github.com/dabblewriter/patches/compare/v0.31.3...v0.32.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* **client:** `BranchClientStore` gains a required `confirmPendingBranch(branch)` member; custom store implementations must add it. `updateBranch` now rejects for a locally deleted branch (`Branch <id> is deleted`) where it previously resolved and silently cancelled the delete.

### Features

* **client:** address review — drop quarantined rows from the torn-write report, [] on a missing snapshot, narrow the LWW contract ([c42f214](https://github.com/dabblewriter/patches/commit/c42f214ba37e7c5a5d57fc97f5ce59700e9e0001))
* **client:** stop a second context resurrecting an ejected change ([86ed326](https://github.com/dabblewriter/patches/commit/86ed326176b9b61d93020a4966ea7247566c406e))
* **client:** stop a second context resurrecting an ejected change ([a97ae9e](https://github.com/dabblewriter/patches/commit/a97ae9ec69cce4992cda77fe7afc8e29928273ad))


### Bug Fixes

* **client:** address review — declare the interface break, split the deleted-branch error, name 402 ([c28488a](https://github.com/dabblewriter/patches/commit/c28488a32fc26eb1566e639dee5509e30f47a876))
* **client:** clear a branch's pending flag on confirm, and stop dead rows wedging the pass ([d734835](https://github.com/dabblewriter/patches/commit/d73483525b8c59cf45a2035df86b7b122620e1f0))

## [0.31.3](https://github.com/dabblewriter/patches/compare/v0.31.2...v0.31.3) (2026-09-15)


### Bug Fixes

* **ot:** de-dup pending vs committed on every view rebuild, and adopt an own echo that beats its mint (DAB-1366) ([#175](https://github.com/dabblewriter/patches/issues/175)) ([aed03dd](https://github.com/dabblewriter/patches/commit/aed03dd4842c0603247764e0d153a9aee6fbd30c))
* **ot:** name the refused op in the root-replace guard message ([#176](https://github.com/dabblewriter/patches/issues/176)) ([cf79b8e](https://github.com/dabblewriter/patches/commit/cf79b8ec43589eebd737f14510cc237f55e9c7a8))

## [0.31.2](https://github.com/dabblewriter/patches/compare/v0.31.1...v0.31.2) (2026-09-11)


### Bug Fixes

* **ot:** apply a span before rebasing the queue, and walk outbox rows before the catch-up rebuild ([9c6fa31](https://github.com/dabblewriter/patches/commit/9c6fa3149122067bb56fe068145b84d68408362d))
* **ot:** hold a mint to the store's committed frame, not the open doc's ([82b89bd](https://github.com/dabblewriter/patches/commit/82b89bd933a916ac9840e4a70acad0d6127a052f))
* **ot:** hold a mint to the store's committed frame, not the open doc's ([b3c30f2](https://github.com/dabblewriter/patches/commit/b3c30f2c6e3fa78e24a5574ee359eed15128cb6c))

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
