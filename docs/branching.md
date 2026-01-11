# Branching and Merging in Patches: How the Magic Works! 🌱➡️🌳

So you want to understand how branches actually work under the hood? You've come to the right place! Let's dive into how Patches handles all the cool branching and merging stuff that makes your collaborative editing dreams come true.

## The Big Picture 🖼️

Think of branching like creating a parallel universe for your document. You start with the same document at a specific point in time, but then it goes off on its own adventure! Later, you can bring all those changes back to the main timeline when you're ready.

It's like Git branching, but designed specifically for collaborative, real-time JSON documents with all the Operational Transformation goodness baked in.

## Branch Creation: Born from the Main Document 🐣

When someone hits that "New Branch" button, here's what happens behind the scenes:

- 🔍 We grab the main document at a specific revision (let's say revision 42)
- 📝 We create a brand new document for the branch
- 🏁 This branch document starts with the exact same content as the main doc at revision 42
- 🏷️ We store all sorts of metadata so we know this branch came from that specific main doc at that specific revision
- 🔢 The branch document continues counting revisions from where it branched (so its first change would be revision 43)

**One important rule**: You can't branch off a branch! We decided to keep things simple by only allowing one level of branching. Trust us, this makes everyone's life easier!

## The Secret Sauce: Metadata 🧪

When you create a branch, we store some super important metadata that helps us keep everything organized:

| Field        | What it means in the branch                       | What it means after merging back                                  |
| ------------ | ------------------------------------------------- | ----------------------------------------------------------------- |
| `origin`     | Set to `"main"` (branch acts like a normal doc)   | `"main"` if fast-forward, `"branch"` if divergent                 |
| `rev`        | Continues from branch point (e.g., 43, 44, 45...) | Same numbers (no translation needed)                              |
| `baseRev`    | Normal (each change's previous rev)               | Set to the branch point revision (e.g., 42)                       |
| `groupId`    | The branch's document ID                          | The branch's document ID                                          |
| `branchName` | The human-readable branch name                    | The human-readable branch name (preserved for traceability)       |

This metadata is our bread crumbs 🥖 that help us keep track of what came from where, which is essential when merging time comes!

## The Grand Reunion: Merging a Branch 🤝

Ready to bring those experimental changes back to the main document? Here's what happens when you merge:

1. 📦 We gather up all the versions created in the branch
2. 🔍 We check if there were any changes on the main document since the branch was created
3. 📊 We add the branch ID and name so you can filter and group these changes later
4. Based on whether there were concurrent changes:

**Fast-forward merge** (no changes on main since branching):
- 🔄 Versions keep `origin: "main"` (they're now part of the main timeline!)
- 📝 Each change is committed individually to the main document
- This is the cleanest case - like the branch never diverged at all

**Divergent merge** (main has new changes since branching):
- 🔄 We flip their `origin` to `"branch"` so everyone knows they came from a branch
- 🔗 We set their `baseRev` to the original branching point
- 🏭 We flatten all the branch's changes into one mega-change (for transformation)
- This flattened change gets transformed against the concurrent main changes

5. 📝 We update the branch status to `"merged"` so everyone knows this branch's changes are now in the main doc

### Why Flatten Changes for Divergent Merges? 🤔

When there are concurrent changes to deal with, instead of transforming every single tiny change from the branch against the main changes (which could be hundreds or thousands of operations), we smoosh them all together into one change first. This:

- ⚡ Makes merging MUCH faster
- 💾 Saves tons of storage space
- 🧠 Keeps the main document's history cleaner and easier to understand

But don't worry - we still preserve all the original versions and their metadata with `origin: "branch"`, so you don't lose any important history!

### The Fast-Forward Advantage 🚀

When there are no concurrent changes on main, we skip the flattening entirely. The branch changes become part of the main timeline seamlessly, preserving your complete editing history without any transformation needed. It's like the branch was always part of main!

_Want to know a secret?_ 🤫 Offline sessions are treated _exactly_ the same way. They are basically auto-branches. Their versions are saved as they appeared to the user when they made the changes offline. If there were no server changes while offline, those versions simply become part of the main timeline. If there were concurrent changes, the offline versions are marked with `origin: "offline-branch"` and the changes get collapsed into one for transformation.

## Why We Made These Design Choices 🧐

We thought a LOT about how to build the branching system. Here's why we made some key decisions:

- **Starting branch revisions from the main doc's number**: This means no translation needed when merging - the numbers just work!

- **Using `origin: 'main'` in the branch before merging**: This lets the branch act just like a normal document until merge time. Everything just works!

- **No branches off branches**: Trust us, branch hierarchies get messy FAST. This keeps things simple and understandable.

- **Flattening changes during merge**: Imagine merging a branch with 1,000 tiny changes. Without flattening, your merge could be very slow. Flattening gives you the same end result but with much better performance! And from the user's perspective merging a branch happens all at once, so by flatting the changes, when they go scrubbing through their history, it will behave the same there as it did in realtime.

## Let's See It In Action! 🎬

Here's a simple example of how it all works:

1. **Starting point**: Main document is at revision 10

2. **Create a branch**: We create "Experimental Feature" branch at revision 10

3. **Work on the branch**:

   - Make change → revision 11 in branch
   - Make another change → revision 12 in branch
   - And another → revision 13 in branch

4. **Merge time!**:
   - All those versions (11, 12, 13) get copied to main doc with `origin: 'branch'`
   - Their changes get flattened into a single change
   - Main doc now has these changes, and the branch is marked as merged

## The Bottom Line 📝

Our branching system is designed to be powerful yet easy to understand. It gives you all the benefits of branches - experimentation, parallel work, review workflows - while keeping things performant and manageable behind the scenes.

The system is built to handle real-world scenarios like large documents, many collaborators, and complex changes - all while maintaining a clean, understandable history for both users and developers.

Now go forth and branch with confidence! 🌳
