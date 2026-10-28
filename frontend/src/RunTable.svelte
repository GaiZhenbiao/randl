<script lang="ts">
  import {
    filterChoice,
    fieldType,
    fieldLabel,
    groupFieldLabel,
    groupTitle,
    groupValueLabel,
    orderGroups,
    runURL,
    interceptLink,
    statusLabel,
    resultCount,
  } from './ui';
  import { t, locale, number, date, type Message } from './i18n';
  import { apiMessage } from './api';
  import { onMount, tick } from 'svelte';
  import { setHoveredRuns } from './hover';

  import {
    Button,
    Search,
    DataTable,
    Checkbox,
    InlineNotification,
    ComboBox,
  } from 'carbon-components-svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte';
  import ChevronUp from 'carbon-icons-svelte/lib/ChevronUp.svelte';
  import Column from 'carbon-icons-svelte/lib/Column.svelte';
  import Filter from 'carbon-icons-svelte/lib/Filter.svelte';
  import GroupObjects from 'carbon-icons-svelte/lib/GroupObjects.svelte';
  import SortDescending from 'carbon-icons-svelte/lib/SortDescending.svelte';
  import TrashCan from 'carbon-icons-svelte/lib/TrashCan.svelte';
  import StopFilled from 'carbon-icons-svelte/lib/StopFilled.svelte';
  import TagIcon from 'carbon-icons-svelte/lib/Tag.svelte';
  import Download from 'carbon-icons-svelte/lib/Download.svelte';
  import ContextPopover from './ContextPopover.svelte';
  import ColumnPicker from './ColumnPicker.svelte';
  import ColorPicker from './ColorPicker.svelte';
  import { color, resolvePaletteColor } from './run-colors';
  import type { Run } from './types';
  let {
    dark,
    runs,
    totalCount,
    filterCount = 0,
    onclear,
    search = $bindable(''),
    colors,
    fields,
    columns,
    fieldValue,
    oncolumns,
    onrun,
    oncolor,
    onfilter,
    ongroup,
    onsort,
    groupBy = '',
    sort = '',
    onSortColumn,
    onManage,
    restorePosition = null,
    onrestored,
  }: {
    groupBy?: string;
    sort?: string;
    onSortColumn: (field: string) => void;
    onManage: (action: string, ids: string[], tags?: string[]) => Promise<void>;
    restorePosition?: { top: number; run?: string } | null;
    onrestored: () => void;
    runs: Run[];
    totalCount: number;
    filterCount?: number;
    onclear: () => void;
    search: string;
    dark: boolean;
    colors: Record<string, string>;
    fields: string[];
    columns: string[];
    fieldValue: (run: Run, field: string) => any;
    oncolumns: (columns: string[]) => void;
    onrun: (run: Run) => void;
    oncolor: (id: string, color: string | null) => void;
    onfilter: (event: MouseEvent) => void;
    ongroup: (event: MouseEvent) => void;
    onsort: (event: MouseEvent) => void;
  } = $props();
  let columnAnchor = $state<HTMLElement | null>(null),
    colorRun = $state<Run | null>(null),
    colorAnchor = $state<HTMLElement | null>(null);
  let checked = $state<string[]>([]),
    bulkBusy = $state(false),
    bulkError = $state<Message>(''),
    tagAnchor = $state<HTMLElement | null>(null),
    tagValue = $state('');
  const byId = $derived(new Map(runs.map((run) => [run.id, run])));
  const listedIds = $derived(runs.map((run) => run.id));
  const listedSet = $derived(new Set(listedIds));
  const checkedIds = $derived(new Set(checked));
  const selectedRuns = $derived(checked.filter((id) => listedSet.has(id)));
  const selectedIds = $derived(new Set(selectedRuns));
  const tagOptions = $derived(
    [
      ...new Set(
        runs.flatMap((run) => {
          const value = fieldValue(run, 'tags');
          return Array.isArray(value)
            ? value
            : typeof value === 'string'
              ? JSON.parse(value || '[]')
              : [];
        }),
      ),
    ].map((value) => ({
      id: groupBy === 'state' ? statusLabel(String(value), $t) : String(value),
      text: String(value),
    })),
  );
  function check(ids: string[], on: boolean) {
    const next = new Set(checked);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    checked = [...next];
  }
  async function focusSelection() {
    await tick();
    scrollContainer?.querySelector<HTMLInputElement>('thead input[type=checkbox]')?.focus({ preventScroll: true });
  }
  async function focusTags() {
    await tick();
    (document.getElementById('runs-batch-tags') || scrollContainer)?.focus({ preventScroll: true });
  }
  async function clearResults() {
    onclear();
    await tick();
    document.querySelector<HTMLInputElement>('.runs-table-search input')?.focus({ preventScroll: true });
  }
  async function manage(action: string) {
    const invoker = document.activeElement as HTMLElement;
    bulkBusy = true;
    bulkError = '';
    try {
      await onManage(action, action==='stop'?selectedRuns.filter(id=>runs.some(run=>run.id===id&&run.snapshot_at==null&&run.state==='running'&&!run.stop_requested)):selectedRuns, action.endsWith('tags') ? [tagValue.trim()] : undefined);
      if (action === 'delete') checked = [];
      tagAnchor = null;
      tagValue = '';

    } catch (error) {
      bulkError = apiMessage(error);
    } finally {
      bulkBusy = false;
      await tick();
      if (bulkError) {
        if (document.activeElement === document.body) {
          if (invoker?.isConnected) invoker.focus({ preventScroll: true });
          else await focusTags();
        }
      } else await (action === 'delete' ? focusSelection() : focusTags());
    }
  }
  let coarse = $state(matchMedia('(pointer: coarse)').matches);
  /**
   * Column widths come from the column's kind, not from the rows currently rendered, so the
   * table keeps its layout while virtual scrolling swaps rows. The run name takes the rest.
   */
  function columnWidth(key: string) {
    if (key === 'state') return 128;
    if (key === 'tags') return 192;
    const type = fieldType(key);
    return type === 'date' ? 216 : type === 'number' ? 120 : 160;
  }
  const nameMinWidth = 240;
  let headers = $derived([
    { key: 'selection', value: $t('runs.table.selection.column'), width: (coarse ? 48 : 40) + 'px' },
    { key: 'display_name', value: $t('runs.columns.run') },
    ...columns
      .filter((key) => !['display_name', 'name'].includes(key))
      .map((key) => ({ key, value: fieldLabel(key, $t), width: columnWidth(key) + 'px' })),
  ]);
  let tableMinWidth = $derived(
    headers.reduce((sum, header) => sum + (header.width ? parseInt(header.width) : nameMinWidth), 0),
  );
  function textValue(run: Run, key: string) {
    const value = fieldValue(run, key);
    if (key === 'state')
      return run.stop_requested && run.state === 'running' && run.snapshot_at == null
        ? $t('runs.stop.requested')
        : statusLabel(run.state, $t);
    if (Array.isArray(value)) return value.join(', ');
    return value == null
      ? '—'
      : fieldType(key)==='date'
        ? $date(Number(value))
        : key==='runtime'?$number(Math.floor(Number(value)))
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  }
  let collapsed = $state<string[]>([]);
  type Row = { id: string; [key: string]: any };
  let rows = $derived.by(() => {
    const flat: Row[] = runs.map((run) => ({
      id: run.id,
      display_name: run.display_name,
      selection: '',
      ...Object.fromEntries(columns.map((key) => [key, textValue(run, key)])),
    }));
    if (!groupBy) return flat;
    const groups = new Map<string, { label: string; name: string; rows: Row[] }>();
    for (const row of flat) {
      const value = fieldValue(byId.get(row.id)!, groupBy),
        key = JSON.stringify(value ?? null);
      if (!groups.has(key))
        groups.set(key, {
          label: groupValueLabel(groupBy, value, $t),
          name: groupTitle(groupBy, value, $t),
          rows: [],
        });
      groups.get(key)!.rows.push(row);
    }
    const result: Row[] = [];
    for (const [key, group] of orderGroups(groupBy, [...groups])) {
      result.push({
        id: 'group:' + key,
        display_name: group.name,
        _value: group.label,
        _count: group.rows.length,
        selection: '',
        _group: true,
        _key: key,
        _ids: group.rows.map((row) => row.id),
      });
      if (!collapsed.includes(key)) result.push(...group.rows);
    }
    return result;
  });
  let tableHost = $state<HTMLDivElement>();
  let scrollContainer = $state<HTMLDivElement | null>(null);
  let regionHeight = $state(1);
  let tableInset = $state(2);
  let headerHeight = $state(32);
  const containerHeight = $derived(Math.max(1, Math.floor(regionHeight - tableInset)));
  let narrow = $state(matchMedia('(max-width: 760px)').matches);
  let rowPitch = $state(32);
  onMount(() => () => setHoveredRuns('runs-table', []));
  onMount(() => {
    const query = matchMedia('(pointer: coarse)'), compact = matchMedia('(max-width: 760px)');
    const changed = () => (coarse = query.matches);
    const compactChanged = () => (narrow = compact.matches);
    query.addEventListener('change', changed);
    compact.addEventListener('change', compactChanged);
    return () => { query.removeEventListener('change', changed); compact.removeEventListener('change', compactChanged); };
  });
  $effect(() => {
    if (!tableHost) return;
    const observer = new ResizeObserver(([entry]) => {
      regionHeight = entry.contentRect.height;
    });
    observer.observe(tableHost);
    return () => observer.disconnect();
  });
  $effect(() => {
    if (!scrollContainer) return;
    const label = $t('runs.table.label');
    scrollContainer.tabIndex = runs.length ? 0 : -1;
    scrollContainer.setAttribute('role', 'region');
    scrollContainer.setAttribute('aria-label', label);
    scrollContainer.dataset.runsScroller = '';
  });
  $effect(() => {
    const host = scrollContainer;
    if (!host) return;
    coarse;
    $locale;
    headers;
    let live = true;
    const measure = () => {
      const container = getComputedStyle(host.parentElement!);
      tableInset = parseFloat(container.paddingTop) + parseFloat(container.paddingBottom);
      const header = host.querySelector('thead');
      if (header && header.getBoundingClientRect().height) headerHeight = header.getBoundingClientRect().height;
      const visibleRows = host.querySelectorAll<HTMLElement>('tbody tr[data-row]');
      if (visibleRows.length > 1) {
        const pitch = visibleRows[1].getBoundingClientRect().top - visibleRows[0].getBoundingClientRect().top;
        if (pitch > 0) rowPitch = pitch;
      } else if (visibleRows.length) rowPitch = visibleRows[0].getBoundingClientRect().height;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    void tick().then(() => { if (live) measure(); });
    return () => { live = false; observer.disconnect(); };
  });
  $effect(() => {
    const host = scrollContainer;
    if (!host) return;
    let remembered: { id: string; selector: string; element: HTMLElement } | null = null;
    let rescued = false;
    const focus = (event: FocusEvent) => {
      const element = event.target as HTMLElement;
      const row = element.closest<HTMLElement>('tbody tr[data-row]');
      if (host.contains(element) && row) {
        remembered = {
          id: row.dataset.row!, element,
          selector: element.matches('input[type="checkbox"]') ? 'input[type="checkbox"]'
            : element.closest('.run-color-button') ? '.run-color-button' : '.table-link',
        };
        rescued = false;
      } else if (element !== host) { remembered = null; rescued = false; }
    };
    const rescue = () => {
      if (!remembered) return;
      if (!remembered.element.isConnected && document.activeElement === document.body) {
        rescued = true;
        host.focus({ preventScroll: true });
      }
      if (!rescued || document.activeElement !== host) return;
      const row = host.querySelector<HTMLElement>('tr[data-row="' + CSS.escape(remembered.id) + '"]');
      const element = row?.querySelector<HTMLElement>(remembered.selector);
      if (!element || !row) return;
      const bounds = host.getBoundingClientRect(), target = row.getBoundingClientRect();
      const header = host.querySelector('thead th')?.getBoundingClientRect().bottom || bounds.top;
      if (target.bottom > header && target.top < bounds.bottom) element.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(rescue);
    observer.observe(host, { childList: true, subtree: true });
    host.addEventListener('scroll', rescue, { passive: true });
    window.addEventListener('focusin', focus);
    return () => { observer.disconnect(); host.removeEventListener('scroll', rescue); window.removeEventListener('focusin', focus); };
  });
  $effect(() => {
    const host = scrollContainer, position = restorePosition;
    if (!host || !position) return;
    let live = true;
    void tick().then(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!live) return;
      host.scrollTop = position.top;
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!live) return;
      const link = position.run && host.querySelector<HTMLElement>('tr[data-row="' + CSS.escape(position.run) + '"] .table-link');
      if (position.run && (document.activeElement === document.body || host.contains(document.activeElement)))
        (link || host).focus({ preventScroll: true });
      onrestored();
    });
    return () => { live = false; };
  });
  $effect(() => {
    if (scrollContainer) scrollContainer.style.scrollPaddingTop = headerHeight + 'px';
  });
  function exportRows() {
    const cell = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"',
      keys = ['display_name', ...columns],
      csv = [
        keys.map(cell).join(','),
        ...runs.map((run) =>
          keys
            .map((key) => cell(key === 'display_name' ? run.display_name : textValue(run, key)))
            .join(','),
        ),
      ].join('\n'),
      url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      a = document.createElement('a');
    a.href = url;
    a.download = 'runs.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="runs-toolbar-region">
  <div class="runs-table-toolbar" class:batch-active={selectedRuns.length > 0}>
    <div class="runs-table-search">
      <Search
        closeButtonLabelText={$t('common.search.clear')}
        size="sm"
        labelText={$t('runs.search.label')}
        placeholder={$t('runs.search.label')}
        bind:value={search}
      />
    </div>
    <Button kind="ghost" size="small" icon={narrow ? undefined : Filter} on:click={onfilter}
      >{$t(filterCount ? 'runs.filter.buttonWithCount' : 'runs.filter.button', { count: filterCount })}</Button
    ><Button kind="ghost" size="small" icon={narrow ? undefined : GroupObjects} on:click={ongroup}>{$t('runs.group.button')}</Button
    ><Button kind="ghost" size="small" icon={narrow ? undefined : SortDescending} on:click={onsort}>{$t('runs.sort.button')}</Button
    ><span class="runs-column-actions"><Button
      kind="ghost"
      size="small"
      icon={narrow ? undefined : Column}
      on:click={(event) => (columnAnchor = (event.target as HTMLElement).closest('button'))}
      >{$t('runs.table.columns')}</Button
    ><Button
      kind="ghost"
      size="small"
      icon={Download}
      hideTooltip title={$t('runs.table.export')} iconDescription={$t('runs.table.export')}
      portalTooltip
      on:click={exportRows}
    /></span>
  </div>
  {#if bulkError}<InlineNotification
      kind="error"
      title={$t(bulkError)}
      on:close={() => {
        bulkError = '';
        void focusTags();
      }}
    />{/if}
  {#if selectedRuns.length}<div
      class="runs-batch-actions"
      role="region"
      aria-label={$t('runs.table.selection.actions')}
    >
      <span>{$t('runs.table.selection.count', { selected: selectedRuns.length })}</span>
      <Button
        kind="ghost"
        size="small"
        id="runs-batch-tags"
        icon={narrow ? undefined : TagIcon}
        disabled={bulkBusy}
        on:click={(event) => (tagAnchor = (event.target as HTMLElement).closest('button'))}
        >{$t('runs.table.actions.tags')}</Button
      >
      <Button
        kind="ghost"
        size="small"
        icon={narrow ? undefined : StopFilled}
        disabled={bulkBusy ||
          !runs.some(
            (run) =>
              selectedIds.has(run.id) && run.state === 'running' && run.snapshot_at == null && !run.stop_requested,
          )}
        on:click={() => manage('stop')}>{$t('runs.table.actions.stop')}</Button
      >
      <Button
        kind="danger-ghost"
        size="small"
        icon={narrow ? undefined : TrashCan}
        disabled={bulkBusy}
        on:click={() => manage('delete')}>{$t('runs.table.actions.delete')}</Button
      >
      <Button kind="ghost" size="small" disabled={bulkBusy} on:click={() => { checked = []; void focusSelection(); }}
        >{$t('common.action.cancel')}</Button
      >
    </div>{/if}
</div>
<div class="table-result-count" role="status">
  {$t(runs.length === totalCount ? 'runs.table.count.all' : 'runs.table.count.filtered', {
    count: runs.length,
    shown: runs.length,
    total: totalCount,
  })}
</div>
<div class="runs-table-region" class:table-empty={!runs.length} bind:this={tableHost} style:--runs-row-floor={headerHeight + rowPitch + 'px'} style:--runs-table-inset={tableInset + 'px'} style:--runs-table-min-width={tableMinWidth + 'px'}>
  <DataTable
    {rows}
    {headers}
    on:mouseenter:row={(event) =>
      setHoveredRuns('runs-table', byId.has(event.detail.id) ? [String(event.detail.id)] : [])}
    on:mouseleave:row={() => setHoveredRuns('runs-table', [])}
    fixedLayout
    size={coarse ? "medium" : "short"}
    bind:scrollContainerRef={scrollContainer}
    virtualize={{ threshold: 30, containerHeight, itemHeight: rowPitch, overscan: 5 }}
    ><svelte:fragment slot="cellHeader" let:header
      >{#if header.key === 'selection'}<Checkbox
          labelText={$t('runs.table.selection.all')}
          hideLabel
          checked={!!runs.length && selectedRuns.length === runs.length}
          indeterminate={!!selectedRuns.length && selectedRuns.length < runs.length}
          on:change={(event) => check(listedIds, (event.target as HTMLInputElement).checked)}
        />{:else}<button class="table-sort" onclick={() => onSortColumn(header.key)}
          >{header.value}{#if sort.replace(/^-/, '') === header.key}{#if sort.startsWith('-')}<ChevronDown
                size={16}
              />{:else}<ChevronUp size={16} />{/if}{/if}</button
        >{/if}</svelte:fragment
    ><svelte:fragment slot="cell" let:row let:cell
      >{@const run = byId.get(row.id)!}{#if cell.key === 'selection'}{@const ids = row._group ? row._ids : [row.id]}<Checkbox
          labelText={$t(row._group ? 'runs.table.selection.group' : 'runs.table.selection.run', {
            name: row._group ? String(row.display_name) : run.display_name,
          })}
          hideLabel
          checked={ids.every((id: string) => checkedIds.has(id))}
          indeterminate={ids.some((id: string) => checkedIds.has(id)) &&
            !ids.every((id: string) => checkedIds.has(id))}
          on:change={(event) => check(ids, (event.target as HTMLInputElement).checked)}
        />{:else if row._group}{#if cell.key === 'display_name'}<button
            class="table-link table-group"
            aria-expanded={!collapsed.includes(row._key!)}
            onclick={() =>
              (collapsed = collapsed.includes(row._key!)
                ? collapsed.filter((key) => key !== row._key)
                : [...collapsed, row._key!])}
            title={row.display_name}
            >{#if collapsed.includes(row._key!)}<ChevronRight size={16} />{:else}<ChevronDown
                size={16}
              />{/if}<span class="group-field">{groupFieldLabel(groupBy, $t)}</span><span
              class="group-value">{row._value}</span
            ><span class="group-count">{$number(row._count)}</span></button
          >{/if}{:else if cell.key === 'display_name'}<div class="table-run-name">
          <button
            class="run-color-button"
            aria-label={$t('runs.color.changeFor', { name: run.display_name })}
            onclick={(event) => {
              colorAnchor = event.currentTarget;
              colorRun = run;
            }}
            ><span class="run-color" style:background={resolvePaletteColor(color(run.id, colors), dark)}></span></button
          ><a
            class="table-link"
            href={runURL(run)}
            title={run.display_name}
            onclick={(event) => interceptLink(event, () => onrun(run))}
            ><span class="table-link-text">{cell.value}</span></a
          >
        </div>{:else}<span class="table-cell-text" title={String(cell.value ?? '')}>{cell.value}</span
        >{/if}</svelte:fragment
    ></DataTable
  >{#if !runs.length}<div class="empty-table">
    <p>{$t(filterCount || search ? 'runs.empty.noMatches' : 'runs.empty.none')}</p>
    {#if filterCount || search}<Button kind="tertiary" size="small" on:click={clearResults}>{$t(search ? (filterCount ? 'runs.empty.clearAll' : 'common.search.clear') : 'runs.filter.clear')}</Button>{/if}
  </div>{/if}
</div>
{#if columnAnchor}<ContextPopover
    anchor={columnAnchor}
    title={$t('runs.columns.title')}
    onClose={() => (columnAnchor = null)}
    ><ColumnPicker
      {fields}
      selected={columns}
      onChange={oncolumns}
      onRequestClose={() => (columnAnchor = null)}
    /></ContextPopover
  >{/if}
{#if colorRun && colorAnchor}<ColorPicker
    {dark}
    anchor={colorAnchor}
    value={color(colorRun.id, colors)}
    name={colorRun.display_name}
    onChange={(value) => oncolor(colorRun!.id, value)}
    onClose={() => {
      colorRun = null;
      colorAnchor = null;
    }}
  />{/if}

{#if tagAnchor}<ContextPopover
    anchor={tagAnchor}
    title={$t('runs.tags.title')}
    onClose={() => (tagAnchor = null)}
  >
    <ComboBox
      selectionClearedText={$t('common.combobox.selectionCleared')}
      filterResultsText={(count) =>
        resultCount(count, $t)}
      on:keydown={(event) => {
        if (
          event.key === 'Escape' &&
          (event.target as HTMLElement).getAttribute('aria-expanded') === 'true'
        )
          event.preventDefault();
      }}
      shouldFilterItem={filterChoice}
      portalMenu
      wrapOptions
      translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
      translateWithIdSelection={() => $t('common.combobox.clear')}
      allowCustomValue
      labelText={$t('runs.tags.label')}
      items={tagOptions}
      placeholder={$t('runs.tags.placeholder')}
      bind:value={tagValue}
      on:select={(event) => (tagValue = String(event.detail.selectedId || ''))}
    />
    <div class="popover-actions">
      <Button
        size="small"
        kind="tertiary"
        disabled={bulkBusy || !tagValue.trim()}
        on:click={() => manage('remove-tags')}>{$t('runs.tags.remove')}</Button
      ><Button
        size="small"
        disabled={bulkBusy || !tagValue.trim()}
        on:click={() => manage('add-tags')}>{$t('runs.tags.add')}</Button
      >
    </div>
  </ContextPopover>{/if}
