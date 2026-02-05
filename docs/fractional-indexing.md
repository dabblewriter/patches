# Fractional Indexing

You want ordered lists in LWW. Great. Here's the problem: arrays will betray you.

Two users insert at "position 3" at the same time. Last write wins. One item vanishes. Poof. Gone. Your user is now staring at a screen wondering where their work went.

"Fine," you say, "I'll just use integer indices as a sort key." Cool. Now insert something between positions 2 and 3. You can't. You have to reindex everything after position 2, which means touching a bunch of records, which means more conflicts, which means more vanishing data.

This is not a new problem. Figma solved it. Every collaborative app with drag-and-drop solved it. The solution is fractional indexing.

## The Idea in 30 Seconds

Instead of integers, use strings that sort lexicographically. You can _always_ generate a string between any two other strings:

- Between `"a"` and `"b"`? → `"aV"`
- Between `"a"` and `"aV"`? → `"aG"`
- Between `"a"` and `"aG"`? → `"a8"`

The strings grow slowly. You'll run out of atoms in the universe before you run out of positions.

## When You Need This

**Use it when:**

- You have ordered items in LWW — kanban cards, todos, playlist tracks, document sections, layers in a design tool
- Users drag and drop things around
- Multiple users might reorder simultaneously

**Skip it when:**

- You're using OT (it handles array ops natively)
- Order doesn't matter (just use an object)
- You only append (a timestamp or counter is fine)

## The Function

```typescript
import { fractionalIndex } from '@dabble/patches';
```

One function. Two arguments: what comes _before_, what comes _after_. Returns a string that slots between them.

```typescript
fractionalIndex(null, null); // "a0" — first item, nothing exists yet
fractionalIndex('a0', null); // "a1" — after a0, nothing after
fractionalIndex(null, 'a0'); // "Z~" — before a0, nothing before
fractionalIndex('a0', 'a1'); // "a0V" — between a0 and a1
```

Use `null`, `undefined`, or `''` for "the beginning" or "the end."

### Bulk Insert

Inserting multiple items? Pass a count as the third argument:

```typescript
fractionalIndex('a0', null, 5); // ["a1", "a2", "a3", "a4", "a5"]
fractionalIndex('a0', 'a1', 3); // ["a0G", "a0V", "a0l"]
```

This spreads items across the available space instead of clustering them. If you called `fractionalIndex` in a loop, you'd stack everything on one side and grow your strings faster than necessary.

## The Pattern: Objects, Not Arrays

Here's the mental shift. Stop thinking in arrays. Start thinking in objects keyed by ID, with an `order` field for sorting.

```typescript
// NOT this
interface BadTodoList {
  todos: Todo[]; // Arrays + LWW = data loss
}

// THIS
interface TodoList {
  todos: Record<string, Todo>; // Object keyed by ID
}

interface Todo {
  id: string;
  text: string;
  order: string; // Fractional index lives here
  done: boolean;
}
```

To display them in order:

```typescript
import { fractionalIndex } from '@dabble/patches';

// Returns [key, value] tuples sorted by order, then by key
const sorted = fractionalIndex.sort(doc.todos);
// [['id1', { id: 'id1', order: 'a1', ... }], ['id2', { id: 'id2', order: 'a2', ... }]]

// Just the values
const values = fractionalIndex.sort(doc.todos).map(([, todo]) => todo);
```

That's it. Your "array" is an object. Your "index" is a string. Everything else works the same.

## Common Operations

**Add at the end:**

```typescript
const sorted = fractionalIndex.sort(doc.todos);
const lastOrder = sorted.at(-1)?.[1].order ?? null;

const id = crypto.randomUUID();
doc.todos[id] = {
  id,
  text: 'New item',
  order: fractionalIndex(lastOrder, null), // after last, before nothing
  done: false,
};
```

**Add at the start:**

```typescript
const sorted = fractionalIndex.sort(doc.todos);
const firstOrder = sorted[0]?.[1].order ?? null;

doc.todos[id] = {
  ...item,
  order: fractionalIndex(null, firstOrder), // after nothing, before first
};
```

**Insert between two items:**

```typescript
// Insert after item at index 2
const sorted = fractionalIndex.sort(doc.todos);
const afterOrder = sorted[2][1].order;
const beforeOrder = sorted[3]?.[1].order ?? null;

doc.todos[id] = {
  ...item,
  order: fractionalIndex(afterOrder, beforeOrder),
};
```

**Drag and drop (move an item):**

```typescript
// User dragged item between positions with orders "a3" and "a5"
doc.todos[draggedId].order = fractionalIndex('a3', 'a5');
```

That's it. One function call. The item now sorts between those two positions.

## In a Patches App

```typescript
const doc = await patches.openDoc<TodoList>('my-todos', { strategy: 'lww' });

// Add a todo
doc.change(state => {
  const sorted = fractionalIndex.sort(state.todos);
  const lastOrder = sorted.at(-1)?.[1].order ?? null;

  const id = crypto.randomUUID();
  state.todos[id] = {
    id,
    text: 'Buy milk',
    order: fractionalIndex(lastOrder, null),
    done: false,
  };
});

// Reorder via drag-and-drop
doc.change(state => {
  state.todos['abc'].order = fractionalIndex('a3', 'a5');
});
```

## "But Why Can't I Just Use Arrays?"

Because LWW resolves conflicts at the field level. Watch what happens:

```typescript
// User A inserts at index 2, timestamp T1
items[2] = { text: 'A item' };

// User B inserts at index 2, timestamp T2
items[2] = { text: 'B item' };

// Result: User B wins. User A's item is GONE. Forever.
```

User A is now filing a support ticket.

With fractional indexing, both users get unique keys:

```typescript
// User A inserts, gets their own key
todos['uuid-A'] = { text: 'A item', order: 'a1V' };

// User B inserts, gets their own key
todos['uuid-B'] = { text: 'B item', order: 'a1V' };

// Result: Both items exist. Same order value, but both preserved.
```

Yes, they might have the same `order` string (rare, but possible). So what? They both exist. Your sort is stable. Break ties by ID or timestamp if you care. Nobody loses data.

## How It Actually Works

You don't need to know this to use it. But if you're curious:

The algorithm comes from [Figma's engineering blog](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/). It uses:

1. **Variable-length integers** — The first characters encode an integer. Lowercase `a-z` = positive with increasing length. Uppercase `A-Z` = negative (for prepending).

2. **Fractional part** — Characters after the integer are the fraction. No trailing zeros.

3. **Base-62** — Uses `0-9`, `A-Z`, `a-z`. That's 62 values per character.

The result: strings that sort correctly with plain string comparison, grow logarithmically, and have ~10^46 available positions. You will never run out.

## Things That Might Trip You Up

**Swapped arguments?** It auto-corrects.

```typescript
fractionalIndex('a5', 'a3'); // Same as fractionalIndex('a3', 'a5')
```

**Invalid keys?** It throws.

```typescript
fractionalIndex('invalid!', null); // Error: "Invalid order key head: i"
```

**Sorting?** Use `fractionalIndex.sort()` or string comparison. Never numeric.

```typescript
// Best — handles order + key tiebreaker
fractionalIndex.sort(items);

// Also fine for simple cases
items.sort((a, b) => a.order.localeCompare(b.order));

// Wrong — you'll get nonsense sorting
items.sort((a, b) => a.order - b.order);
```

**Database?** Standard string indexes work perfectly.

```sql
CREATE INDEX idx_order ON todos (order_key ASC);
SELECT * FROM todos ORDER BY order_key;
```

No custom collation. No special handling. Just strings.

## Duplicate Orders (The Offline Problem)

Here's a scenario that will happen: Two users are offline. Both append an item to the end of the same list. Both generate the same fractional index.

```typescript
// User A offline, list ends at "a5"
fractionalIndex('a5', null); // "a6"

// User B offline, same list, same state
fractionalIndex('a5', null); // "a6"

// They sync. Now you have:
// Item A: { id: 'aaa', order: 'a6' }
// Item B: { id: 'zzz', order: 'a6' }
```

Both items exist. No data loss. But they have identical orders.

For display, this is fine—sort by order, break ties by ID. Consistent and stable.

The problem: what if someone tries to insert _between_ these two items?

```typescript
fractionalIndex('a6', 'a6'); // Returns "a6V"
```

`"a6V"` sorts _after_ `"a6"`, not between the two items. You can't insert between identical values. That's like asking for a number between 6 and 6.

### The Fix: Heal After Sync

Call `fractionalIndex.heal` after applying remote changes:

```typescript
import { fractionalIndex } from '@dabble/patches';

// After syncing remote changes
const fixes = fractionalIndex.heal(state.todos);
if (fixes) {
  doc.change((patch, root) => {
    for (const [key, newOrder] of Object.entries(fixes)) {
      patch.replace(root.todos[key].order, newOrder);
    }
  });
}
```

The function:

1. Sorts items by order (with key as tiebreaker)
2. Finds consecutive items with identical orders
3. Computes new orders for the duplicates
4. Returns `{ key: newOrder }` map, or `null` if no duplicates

It doesn't mutate anything—you apply the fixes yourself. And it's idempotent: after applying fixes, calling it again returns `null`.

### API Options

Both `.sort()` and `.heal()` share the same signature for the second parameter:

```typescript
// Default: objects with an 'order' field
fractionalIndex.sort(items);
fractionalIndex.heal(items);

// Custom field name
fractionalIndex.sort(items, 'sortKey');
fractionalIndex.heal(items, 'sortKey');

// Values ARE the order strings (use false)
const orderMap: Record<string, string> = { a: 'a1', b: 'a1' };
fractionalIndex.sort(orderMap, false);
fractionalIndex.heal(orderMap, false);
```

### Healing on the Server

You can also heal duplicates server-side before committing changes. This keeps clients simpler and ensures all clients see the same healed state:

```typescript
// In your server's commitChanges hook or before saving
const fixes = fractionalIndex.heal(doc.todos);
if (fixes) {
  for (const [key, newOrder] of Object.entries(fixes)) {
    doc.todos[key].order = newOrder;
  }
}
```

Trade-off: server-side healing means the server modifies client data. Some apps prefer the client to own its data and heal locally. Pick what fits your architecture.

### When to Call It

- After applying remote changes from sync
- Before any operation that depends on unique orders (if you're paranoid)
- In a periodic cleanup job (if you're lazy)

The first option is the cleanest. Fix duplicates immediately when they appear, and you'll never hit the edge case.

### If You Don't Want to Heal

Your other option: don't let users insert between items with identical orders. Detect the case in your UI and either:

- Auto-select one of them as the drop target
- Show a message asking the user to reorder first

But honestly, just heal. It's simpler.

## The Bottom Line

Arrays in LWW lose data. Fractional indexing doesn't.

Store items in an object keyed by ID. Put the order in a string field. Sort by that field. Done.

```typescript
fractionalIndex(before, after);
```

One function. Tell it what's before and after. Get a string that goes between. Ship it.
