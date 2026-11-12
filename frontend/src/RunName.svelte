<script lang="ts">
  // A run's name wherever randl shows one (CONTRIBUTING.md "Run names"): its colour swatch, as
  // in the Runs tab, then the name on one line, cut with an ellipsis when it does not fit. The
  // full name shows on hover (title) and, for links and buttons, on keyboard focus.
  import { runColors, swatch } from './run-name';
  let {
    id,
    name,
    href,
    onclick,
    strong = false,
    quiet = false,
  }: {
    /** The run's ID, which picks its colour. */
    id: string;
    name: string;
    /** Makes the name a link (with `onclick` to open it in the app). */
    href?: string;
    /** Without `href`, makes the name a button. */
    onclick?: (event: MouseEvent) => void;
    /** Bolder text, for headings. */
    strong?: boolean;
    /** A link in body text colour, as table links are. */
    quiet?: boolean;
  } = $props();
  let background = $derived(swatch(id, $runColors));
</script>

{#snippet content()}<span class="run-label-swatch" style:background aria-hidden="true"></span><span
    class="run-label-text">{name}</span
  >{/snippet}
{#if href}<a
    class="run-label {quiet ? 'table-link' : 'bx--link'}"
    class:strong
    {href}
    {onclick}
    title={name}
    data-name={name}>{@render content()}</a
  >{:else if onclick}<button
    type="button"
    class="run-label run-label-button"
    class:strong
    {onclick}
    title={name}
    data-name={name}>{@render content()}</button
  >{:else}<span class="run-label" class:strong title={name}>{@render content()}</span>{/if}
