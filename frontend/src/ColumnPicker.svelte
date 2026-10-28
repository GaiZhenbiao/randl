<script lang="ts">
  import { tick } from 'svelte';
  import { Button, Tag } from 'carbon-components-svelte';
  import ArrowsVertical from 'carbon-icons-svelte/lib/ArrowsVertical.svelte';
  import ChevronUp from 'carbon-icons-svelte/lib/ChevronUp.svelte';
  import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte';
  import UpToTop from 'carbon-icons-svelte/lib/UpToTop.svelte';
  import DownToBottom from 'carbon-icons-svelte/lib/DownToBottom.svelte';
  import EditorChoice from './EditorChoice.svelte';
  import limits from '../../backend/src/panel-limits.json';
  import { t } from './i18n';
  import { fieldLabel, filterChoice, resultCount } from './ui';
  let {
    fields,
    selected,
    onChange,
    onRequestClose,
  }: {
    fields: string[];
    selected: string[];
    onChange: (ids: string[]) => void;
    onRequestClose: () => void;
  } = $props();
  const uid = $props.id();
  let query = $state(''),
    open = $state(false),
    ordering = $state(false),
    removed = $state(''),
    moreAbove = $state(false),
    moreBelow = $state(false);
  let chipScroller = $state<HTMLDivElement>(),
    chipContent = $state<HTMLDivElement>();
  let selectedId = $state<string | undefined>(),
    input = $state<HTMLInputElement | null>(null);
  let host: HTMLFieldSetElement;
  let orderButton = $state<HTMLButtonElement>();
  const options = $derived(
    fields
      .filter((id) => !['name', 'display_name'].includes(id) && !selected.includes(id))
      .map((id) => ({ id, text: fieldLabel(id, $t) })),
  );
  const full = $derived(selected.length >= limits.maxColumns);
  const allSelected = $derived(!options.length);
  const unavailable = $derived(full || allSelected);
  const noMatches = $derived(!!query && !options.some((item) => filterChoice(item, query)));
  $effect(() => {
    if (unavailable) open = false;
  });
  $effect(() => {
    const node = chipScroller,
      content = chipContent;
    if (!node || !content) return;
    const update = () => {
      moreAbove = node.scrollTop > 1;
      moreBelow = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(content);
    node.addEventListener('scroll', update);
    update();
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', update);
    };
  });
  async function focusInput(reopen = false) {
    await tick();
    input?.focus();
    open = reopen && !unavailable;
  }
  async function add(id: string) {
    if (!id || full || selected.includes(id)) return;
    onChange([...selected, id]);
    await tick();
    selectedId = undefined;
    query = '';
    await focusInput(true);
  }
  async function remove(id: string, reopen = false) {
    removed = '';
    onChange(selected.filter((value) => value !== id));
    await focusInput(reopen);
    removed = $t('runs.columns.removed', { name: fieldLabel(id, $t) });
  }
  function orderKeys(node: HTMLFieldSetElement) {
    const key = (event: KeyboardEvent) => {
      if (ordering && event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void stopOrdering();
      }
    };
    node.addEventListener('keydown', key);
    return { destroy: () => node.removeEventListener('keydown', key) };
  }
  async function stopOrdering() {
    ordering = false;
    await tick();
    orderButton?.focus();
  }
  async function move(id: string, control: 'first' | 'earlier' | 'later' | 'last') {
    const from = selected.indexOf(id),
      to = { first: 0, earlier: from - 1, later: from + 1, last: selected.length - 1 }[control];
    if (to === from || to < 0 || to >= selected.length) return;
    const next = [...selected];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
    await tick();
    const row = Array.from(host.querySelectorAll<HTMLElement>('[data-column]')).find(
      (row) => row.dataset.column === id,
    );
    row?.querySelector<HTMLButtonElement>('[data-' + control + ']')?.focus();
  }
</script>

<fieldset class="column-picker" bind:this={host} use:orderKeys>
  <legend id={uid} class="bx--visually-hidden">{$t('runs.columns.visible')}</legend>
  <div class="column-picker-heading">
    <span class="bx--label" aria-hidden="true">{$t('runs.columns.visible')}</span>
    {#if selected.length >= 2}
      <Button
        bind:ref={orderButton}
        kind="ghost"
        size="small"
        icon={ordering ? undefined : ArrowsVertical}
        on:click={() => {
          if (ordering) void stopOrdering();
          else {
            ordering = true;
            open = false;
          }
        }}
      >
        {$t(ordering ? 'runs.columns.orderDone' : 'runs.columns.changeOrder')}
      </Button>
    {/if}
  </div>
  {#if ordering}
    <ol class="column-picker-order" aria-labelledby={uid}>
      {#each selected as id, i (id)}
        <li data-column={id}>
          <span>{fieldLabel(id, $t)}</span>
          <Button
            data-first
            kind="ghost"
            size="small"
            icon={UpToTop}
            hideTooltip
            aria-disabled={i === 0}
            title={$t('runs.columns.moveToFirst', { name: fieldLabel(id, $t) })}
            iconDescription={$t('runs.columns.moveToFirst', { name: fieldLabel(id, $t) })}
            on:click={() => move(id, 'first')}
          />
          <Button
            data-earlier
            kind="ghost"
            size="small"
            icon={ChevronUp}
            hideTooltip
            aria-disabled={i === 0}
            title={$t('runs.columns.moveEarlier', { name: fieldLabel(id, $t) })}
            iconDescription={$t('runs.columns.moveEarlier', { name: fieldLabel(id, $t) })}
            on:click={() => move(id, 'earlier')}
          />
          <Button
            data-later
            kind="ghost"
            size="small"
            icon={ChevronDown}
            hideTooltip
            aria-disabled={i === selected.length - 1}
            title={$t('runs.columns.moveLater', { name: fieldLabel(id, $t) })}
            iconDescription={$t('runs.columns.moveLater', { name: fieldLabel(id, $t) })}
            on:click={() => move(id, 'later')}
          />
          <Button
            data-last
            kind="ghost"
            size="small"
            icon={DownToBottom}
            hideTooltip
            aria-disabled={i === selected.length - 1}
            title={$t('runs.columns.moveToLast', { name: fieldLabel(id, $t) })}
            iconDescription={$t('runs.columns.moveToLast', { name: fieldLabel(id, $t) })}
            on:click={() => move(id, 'last')}
          />
        </li>
      {/each}
    </ol>
  {:else}
    <div class="chip-choice-field">
      {#if selected.length}<div
          class="column-picker-chip-region"
          class:more-above={moreAbove}
          class:more-below={moreBelow}
        >
          <div class="column-picker-chips" bind:this={chipScroller}>
            <div class="column-picker-chip-content" bind:this={chipContent}>
              {#each selected as id (id)}
                <Tag
                  filter
                  title={$t('runs.columns.remove', { name: fieldLabel(id, $t) })}
                  on:close={() => remove(id)}>{fieldLabel(id, $t)}</Tag
                >
              {/each}
            </div>
          </div>
        </div>{/if}
      <EditorChoice
        labelText={$t('runs.columns.visible')}
        hideLabel
        size="sm"
        items={options}
        bind:ref={input}
        bind:value={query}
        bind:open
        bind:selectedId
        readonly={unavailable}
        aria-describedby={full ? uid + '-limit' : allSelected ? uid + '-all-selected' : undefined}
        placeholder={unavailable ? '' : $t('runs.columns.search')}
        virtualize
        canOpenOnFocus={() => false}
        {onRequestClose}
        filterResultsText={(count) => resultCount(count, $t, 'runs.columns.noMatches')}
        translateWithIdSelection={() => $t('common.search.clear')}
        on:keydown={(event) => {
          if (event.key === 'Backspace' && !query && selected.length && !event.isComposing) {
            event.preventDefault();
            void remove(selected.at(-1)!, true);
          }
        }}
        on:select={(event) => void add(String(event.detail.selectedId || ''))}
      />
    </div>
    {#if full}<p class="bx--form__helper-text" id={uid + '-limit'} role="status">
        {$t('runs.columns.limit', {
          count: limits.maxColumns,
        })}
      </p>
    {:else if allSelected}<p class="bx--form__helper-text" id={uid + '-all-selected'} role="status">
        {$t('runs.columns.allSelected')}
      </p>
    {:else if noMatches}<p class="bx--form__helper-text" role="status">
        {$t('runs.columns.noMatches')}
      </p>{/if}
  {/if}
  <span class="bx--visually-hidden" role="status" aria-live="polite">{removed}</span>
</fieldset>
