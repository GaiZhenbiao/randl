<script lang="ts">
  // Carbon's ComboBox, kept steady while live data refreshes its items: an open menu keeps
  // its scroll position and highlighted option until the reader types or reopens it.
  import { untrack } from 'svelte';
  import { ComboBox } from 'carbon-components-svelte';
  import type { ComponentProps } from 'svelte';
  type Props = ComponentProps<InstanceType<typeof ComboBox>>;
  type Items = NonNullable<Props['items']>;
  let {
    items = [],
    selectedId = $bindable(),
    value = $bindable(''),
    open = $bindable(false),
    ref = $bindable<HTMLInputElement | null>(null),
    listRef = $bindable<HTMLDivElement | null>(null),
    autoHighlight = 'none',
    ...attributes
  }: Props = $props();
  function sameItems(a: Items, b: Items) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      const left = a[index] as Record<string, unknown>,
        right = b[index] as Record<string, unknown>,
        keys = Object.keys(left);
      if (keys.length !== Object.keys(right).length) return false;
      for (const key of keys) if (!Object.is(left[key], right[key])) return false;
    }
    return true;
  }
  // Rebuilt but unchanged lists keep their identity, so Carbon does no work for them.
  let latest: Items = untrack(() => items);
  const shownItems = $derived.by(() => (sameItems(items, latest) ? latest : (latest = items)));
  // Carbon re-highlights the first match, and scrolls to it, whenever its items change.
  // Hold the reader's highlight for changes they did not make.
  let itemsAtInput = $state.raw(untrack(() => shownItems));
  $effect.pre(() => {
    void value;
    void open;
    void autoHighlight;
    itemsAtInput = untrack(() => shownItems);
  });
  const effectiveHighlight = $derived(
    open && shownItems !== itemsAtInput ? 'none' : autoHighlight,
  );
</script>

<ComboBox
  {...attributes}
  items={shownItems}
  autoHighlight={effectiveHighlight}
  bind:selectedId
  bind:value
  bind:open
  bind:ref
  bind:listRef
  on:select
  on:clear
  on:close
  on:input
  on:focus
  on:blur
  on:keydown
/>
