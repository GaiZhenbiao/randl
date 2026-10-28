<script lang="ts">
  import { tick } from 'svelte';
  import { Button, Tag, TextInput } from 'carbon-components-svelte';
  import EditorChoice from './EditorChoice.svelte';
  import panelLimits from '../../backend/src/panel-limits.json';
  import { t, type MessageKey } from './i18n';
  import { resultCount, filterChoice } from './ui';
  let {
    label,
    metrics,
    loggedMetrics = metrics,
    selected,
    limit = panelLimits.maxMetrics,
    capacity = limit,
    seriesCount,
    emptyMessage = 'metrics.picker.unavailable',
    onChange,
    onRequestClose = () => {},
    loading = false,
  }: {
    label: string;
    metrics: string[];
    loggedMetrics?: string[];
    selected: string[];
    limit?: number;
    capacity?: number;
    seriesCount?: number;
    emptyMessage?: MessageKey;
    onChange: (metrics: string[]) => void;
    onRequestClose?: () => void;
    loading?: boolean;
  } = $props();
  let query = $state(''),
    open = $state(false),
    selectedId = $state<string | undefined>(),
    input = $state<HTMLInputElement | null>(null),
    focused = $state(false);
  let patternMode = $state(false),
    pattern = $state(''),
    focusOpens = true;
  const full = $derived(limit > 1 && (selected.length >= limit || capacity <= 0)),
    remaining = $derived(Math.min(limit - selected.length, capacity));
  const options = $derived(
    metrics.filter((metric) => !selected.includes(metric)).map((id) => ({ id, text: id })),
  );
  const noMatches = $derived(!!query && !options.some((item) => filterChoice(item, query)));
  const matching = $derived.by(() => {
    if (!pattern) return { metrics: [] as string[], total: 0, invalid: false };
    try {
      const expression = new RegExp(pattern, 'i'),
        all = metrics.filter((metric) => expression.test(metric));
      return {
        metrics: all.filter((metric) => !selected.includes(metric)),
        total: all.length,
        invalid: false,
      };
    } catch {
      return { metrics: [] as string[], total: 0, invalid: true };
    }
  });
  $effect(() => {
    if (full && open) open = false;
  });
  async function focusInput(reopen: boolean) {
    await tick();
    focusOpens = reopen;
    input?.focus();
    input?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    focusOpens = true;
    open = reopen && !full;
  }
  async function add(metric: string) {
    if (!metric || selected.includes(metric) || full) return;
    onChange(limit === 1 ? [metric] : [...selected, metric]);
    await tick();
    selectedId = undefined;
    query = '';
    await focusInput(limit > 1);
  }
  async function remove(metric: string, reopen = false) {
    onChange(selected.filter((value) => value !== metric));
    await focusInput(reopen);
  }
  async function addMatching() {
    if (full || matching.metrics.length > remaining) return;
    onChange([...selected, ...matching.metrics]);
    patternMode = false;
    pattern = '';
    query = '';
    await focusInput(false);
  }
</script>

<fieldset class="metric-picker" aria-busy={loading}>
  <legend class="bx--label metric-picker-label"
    >{label}{#if seriesCount !== undefined}<span
        >{$t('charts.expressions.seriesCount', { count: seriesCount, limit })}</span
      >{/if}</legend
  >
  <div class="metric-picker-field" class:at-limit={full}>
    {#if selected.length}<div class="metric-picker-chips">
        {#each selected as metric (metric)}
          <Tag filter title={$t('metrics.picker.remove', { metric })} on:close={() => remove(metric)}
            >{metric}</Tag
          >
        {/each}
      </div>{/if}
    <div class="metric-picker-entry" class:with-pattern={limit > 1}>
      <EditorChoice
        labelText={label}
        hideLabel
        size="sm"
        items={options}
        bind:ref={input}
        bind:value={query}
        bind:open
        bind:selectedId
        readonly={full}
        disabled={loading || !metrics.length}
        placeholder={selected.length || full
          ? ''
          : $t(limit === 1 ? 'metrics.picker.placeholderOne' : 'metrics.picker.placeholder')}
        virtualize
        {onRequestClose}
        canOpenOnFocus={() => !full && focusOpens}
        filterResultsText={(count) => resultCount(count, $t, 'metrics.picker.noMatches')}
        translateWithIdSelection={() => $t('common.search.clear')}
        on:focus={() => (focused = true)}
        on:blur={() => (focused = false)}
        on:keydown={(event) => {
          if (event.key === 'Backspace' && !query && selected.length) {
            event.preventDefault();
            void remove(selected.at(-1)!, true);
          }
        }}
        on:select={(event) => void add(String(event.detail.selectedId || ''))}
      />
      {#if limit > 1}<Button
          class="metric-pattern-toggle"
          kind="ghost"
          size="small"
          title={$t('metrics.picker.regex')}
          aria-label={$t('metrics.picker.regex')}
          aria-pressed={patternMode}
          disabled={loading}
          on:click={() => {
            patternMode = !patternMode;
            open = false;
          }}><span aria-hidden="true">.*</span></Button
        >{/if}
    </div>
  </div>
  {#if !loading}{#each selected.filter((metric) => !loggedMetrics.includes(metric)) as metric (metric)}
      <p class="bx--form__helper-text">
        {$t('metrics.notLogged', { metric })}
      </p>
    {/each}{/if}
  {#if loading}<p class="bx--form__helper-text" role="status">{$t('metrics.loading')}</p>
  {:else if !metrics.length}<p class="bx--form__helper-text">{$t(emptyMessage)}</p>
  {:else if full && !patternMode}<p class="bx--form__helper-text">
      {$t(
        seriesCount !== undefined
          ? 'charts.expressions.budgetFull'
          : 'metrics.picker.full',
      )}
    </p>
  {:else if !full && noMatches}<p class="bx--form__helper-text" role="status">
      {$t('metrics.picker.noMatches')}
    </p>
  {:else if limit > 1 && focused && !options.length && !full}<p class="bx--form__helper-text">
      {$t('metrics.picker.allSelected')}
    </p>{/if}
  {#if patternMode}<div class="metric-pattern">
      <TextInput
        size="sm"
        labelText={$t('metrics.picker.regex')}
        bind:value={pattern}
        invalid={matching.invalid}
        invalidText={$t('metrics.picker.regexInvalid')}
        on:keydown={(event) => {
          if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          event.stopPropagation();
          if (matching.metrics.length && matching.metrics.length <= remaining) void addMatching();
        }}
      />
      {#if pattern && !matching.invalid}<p class="bx--form__helper-text" role="status">
          {#if matching.total && !matching.metrics.length}{$t(
              'metrics.picker.regexAllSelected',
            )}
          {:else if !matching.total}{$t('metrics.picker.noMatches')}
          {:else}{$t('metrics.picker.regexMatches', { count: matching.metrics.length })}{/if}
        </p>{/if}
      {#if full}<p class="bx--form__helper-text">
          {$t(
            seriesCount !== undefined
              ? 'charts.expressions.budgetFull'
              : 'metrics.picker.full',
          )}
        </p>
      {:else if matching.metrics.length > remaining}<p class="bx--form__helper-text">
          {$t('metrics.picker.regexOverLimit', { count: remaining })}
        </p>{/if}
      <Button
        kind="tertiary"
        size="small"
        disabled={!matching.metrics.length || matching.metrics.length > remaining}
        on:click={addMatching}>{$t('metrics.picker.addMatching')}</Button
      >
    </div>{/if}
</fieldset>
