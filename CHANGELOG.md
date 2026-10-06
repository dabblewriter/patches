# Changelog

## [0.34.0](https://github.com/dabblewriter/patches/compare/v0.33.0...v0.34.0) (2026-10-06)


### Features

* **json-patch:** decide [@txt](https://github.com/txt) overrun padding per change, not per replay (DAB-1427) ([98b1b13](https://github.com/dabblewriter/patches/commit/98b1b138c39a09c50af8f19b4099bcadf44b6d94))
* **json-patch:** decide [@txt](https://github.com/txt) overrun padding per change, not per replay (DAB-1427) ([ea7e848](https://github.com/dabblewriter/patches/commit/ea7e848db9b4328ec71b9325029bc1e16686d1b0))


### Bug Fixes

* **client:** a no-error IndexedDB abort is an AbortError, not a StorageError (DAB-1741) ([a89a2ac](https://github.com/dabblewriter/patches/commit/a89a2ac1ffb2e20e4557cbab904deba63aec1bf2))
* **client:** address review — don't reuse an id-matched snapshot row in import's byte match (DAB-1409) ([65b56b7](https://github.com/dabblewriter/patches/commit/65b56b7a9b9eaae256915beee5d95cb02ef5f20c))
* **client:** never reject a transaction with a bare null error (DAB-1741) ([d4e80ca](https://github.com/dabblewriter/patches/commit/d4e80cafbef11e2ffd0c2bae75d5ece83b0e2939))
* **client:** never reject an IndexedDB request or transaction with a bare null (DAB-1741) ([21b473c](https://github.com/dabblewriter/patches/commit/21b473c714be9411c096aff455a6ae96cd849b58))
* **client:** recognise an own echo by its minted id, not its bytes (DAB-1409) ([931da5b](https://github.com/dabblewriter/patches/commit/931da5b04a06ccec172f202fcf4314b693844f5d))
* **client:** recognise an own echo by its minted id, not its bytes (DAB-1409) ([8defd54](https://github.com/dabblewriter/patches/commit/8defd5431db1a21b2e72fe4d7360338445607e83))
* **client:** say that a change dropped at hydration stays queued and is sent ([d00c9ac](https://github.com/dabblewriter/patches/commit/d00c9ac8117767944824705e6115194c7e0541f1))
* **client:** say that a change dropped at hydration stays queued and is sent ([7ad1579](https://github.com/dabblewriter/patches/commit/7ad1579768f78f3297fb19095c63349f0fe34d60))
* **ot:** drop the changes built on a pending change dropped at hydration ([7e7df1f](https://github.com/dabblewriter/patches/commit/7e7df1fb609e8d11d1a8449d8f440d5a7b11ee02))
* **ot:** drop the changes built on a pending change dropped at hydration ([7d50105](https://github.com/dabblewriter/patches/commit/7d501050d60b4b6a0882739511005a99007089ba))
* **ot:** hold out rows that need a deferred row, survive malformed rows in hydration salvage ([552a7a7](https://github.com/dabblewriter/patches/commit/552a7a7b0b92b841324394a401c1394a1268d37b))
* **ot:** replay held-out current-frame rows when checking what a later row needs ([7ea5f3c](https://github.com/dabblewriter/patches/commit/7ea5f3c83f6ef06a9d97cd9a62ebce2ea866cbd0))
* **sync:** don't rebase the shared store's pending queue across a batch the store already applied (DAB-1755) ([54f72ad](https://github.com/dabblewriter/patches/commit/54f72adab0bf241c413dae5f90811bc7ef6a7408))
* **sync:** don't rebase the shared store's pending queue across a batch the store already applied (DAB-1755) ([5063997](https://github.com/dabblewriter/patches/commit/50639978d734e3ceba79fe54686075dff99b750c))

## [0.33.0](https://github.com/dabblewriter/patches/compare/v0.32.3...v0.33.0) (2026-09-30)


### Features

* **lww:** read only the ops a commit can touch (DAB-1672) ([3b33226](https://github.com/dabblewriter/patches/commit/3b33226e3cb716f883f4cd2ac015b254edc73104))
* **lww:** read only the ops a commit can touch (DAB-1672) ([69938b2](https://github.com/dabblewriter/patches/commit/69938b24f79b5305562b05d85fadf8bc76d2fc08))


### Bug Fixes

* **ot:** read the outbox on both sides of the bulk pending store read ([794fb18](https://github.com/dabblewriter/patches/commit/794fb186210c592cf43d575f71c9bf46dae42170))
* **ot:** read the outbox on both sides of the bulk pending store read ([689900f](https://github.com/dabblewriter/patches/commit/689900f0e7477e07c061e5828d3967c84e3aa4d5))

## [0.32.3](https://github.com/dabblewriter/patches/compare/v0.32.2...v0.32.3) (2026-09-28)


### Bug Fixes

* **sync:** answer "which docs have pending work" in one query per store, not one per doc ([15c3b81](https://github.com/dabblewriter/patches/commit/15c3b81e4b1eea830aee0dbeafbbe24a9618af77))
* **sync:** answer "which docs have pending work" in one query per store, not one per doc ([9de4723](https://github.com/dabblewriter/patches/commit/9de472308bdaceb3b233b949e2ea8a6786b139e3))

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
