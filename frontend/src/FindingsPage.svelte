<script lang="ts">
  // A project's findings (docs/guides/ledger.md): what the runs showed, by topic, each
  // citing the runs and updates it rests on, with every earlier version kept.
  import RunName from './RunName.svelte';
  import { onMount, tick, untrack } from 'svelte';
  import {
    Button,
    InlineNotification,
    Modal,
    RadioButton,
    RadioButtonGroup,
    Select,
    SelectItem,
    Tag,
    TextArea,
    TextInput,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import History from 'carbon-icons-svelte/lib/History.svelte';
  import TrashCan from 'carbon-icons-svelte/lib/TrashCan.svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import ArrowDown from 'carbon-icons-svelte/lib/ArrowDown.svelte';
  import ArrowUp from 'carbon-icons-svelte/lib/ArrowUp.svelte';
  import PageRail from './PageRail.svelte';
  import ContextPopover from './ContextPopover.svelte';
  import Filter from 'carbon-icons-svelte/lib/Filter.svelte';
  import MarkdownIt from 'markdown-it';
  import Choice from './Choice.svelte';
  import LedgerSource from './LedgerSource.svelte';
  import SidebarResize from './SidebarResize.svelte';
  import { loadWidth } from './sidebar-width';
  import type { Source } from './lineage-graph';
  import { api, tool, apiMessage } from './api';
  import { t, number, date, type Message } from './i18n';
  import { filterChoice, interceptLink, resultCount, runURL } from './ui';
  import type { Plugin, Run } from './types';
  import PanelCard from './Panel.svelte';
  import { runColors } from './run-name';

  type Citation = { run: string; update?: number; note?: string };
  type Finding = {
    id: string;
    topic: string;
    title: string;
    body: string;
    status: 'finding' | 'ruled_out';
    citations: Citation[];
    source: Source | null;
    version: number;
    updated: number;
    by: string;
  };
  let {
    project,
    runs,
    onRun,
    rail,
    narrow = false,
    plugins,
    dark,
  }: {
    /** A phone-width window: filters move into a popover and buttons show as icons. */
    narrow?: boolean;
    project: string;
    runs: Run[];
    plugins: Plugin[];
    dark: boolean;
    onRun: (run: Run, tab?: string) => void;
    /** The header rail for the page's controls (PageRail.svelte), on wide screens. */
    rail?: HTMLElement;
  } = $props();
  // The reading pane's width, dragged at its edge (SidebarResize).
  let layout = $state<HTMLElement>(),
    readerWidth = $state(loadWidth('findings-reader'));
  const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
  let findings = $state<Finding[] | null>(null),
    error = $state<Message>(''),
    search = $state(''),
    topic = $state<string | null>(null),
    status = $state<'all' | Finding['status']>('all'),
    sort = $state<{ key: SortKey; descending: boolean }>({ key: 'updated', descending: true }),
    // The finding in the reading pane, kept in the URL so links (a run's findings) open it.
    open = $state(new URL(location.href).searchParams.get('finding') || ''),
    checked = $state<Set<string>>(new Set());
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));
  type SortKey = 'title' | 'topic' | 'status' | 'citations' | 'updated' | 'by';

  // Each finding with its search text, lowercased once per load.
  let indexed = $derived(
    (findings ?? []).map((finding) => ({
      finding,
      text: [finding.title, finding.topic, finding.body, finding.by].join('\n').toLowerCase(),
    })),
  );
  // Cited runs show the project's primary metric (the Lineage metric) over its progress key.
  let primary = $state<{ metric: string; progressKey: string } | null>(null);
  let lineChart = $derived(plugins.find((plugin) => plugin.id === 'line' && plugin.enabled));
  onMount(() => {
    tool('project_lineage_settings_get', { id: project }).then(
      (settings) => (primary = settings),
      () => (primary = null),
    );
  });
  // Whether each cited run logged the primary metric: runs that did not show a note, not an
  // empty chart.
  let logged = $state<Record<string, boolean>>({});
  $effect(() => {
    const metric = primary?.metric,
      ids = (current?.citations ?? [])
        .map((citation) => citation.run)
        .filter((id) => runById.has(id) && !(id in untrack(() => logged)));
    if (!metric || !ids.length) return;
    for (const id of new Set(ids))
      api('/api/metrics', { runs: [id] }).then(
        (result) => (logged = { ...logged, [id]: (result.metrics ?? []).includes(metric) }),
        () => (logged = { ...logged, [id]: true }),
      );
  });
  async function load() {
    try {
      findings = (await tool('findings_list', { project })).findings;
      error = '';
      // Checked findings that no longer exist drop out of the selection.
      const ids = new Set(findings!.map((finding) => finding.id));
      if ([...checked].some((id) => !ids.has(id)))
        checked = new Set([...checked].filter((id) => ids.has(id)));
    } catch (reason) {
      error = apiMessage(reason);
    }
  }
  onMount(() => {
    void load().then(() => {
      if (!open || !findings?.some((finding) => finding.id === open)) return;
      // A linked finding shows whatever the filters were.
      search = '';
      topic = null;
      status = 'all';
      void tick().then(() => rowOf(open)?.scrollIntoView({ block: 'center' }));
    });
  });
  $effect(() => {
    const url = new URL(location.href);
    if ((url.searchParams.get('finding') || '') === open) return;
    if (open) url.searchParams.set('finding', open);
    else url.searchParams.delete('finding');
    window.history.replaceState(window.history.state, '', url);
  });
  let topics = $derived(
    [...new Set((findings ?? []).map((finding) => finding.topic))].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
  let shown = $derived.by(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean),
      direction = sort.descending ? -1 : 1,
      value = (finding: Finding): string | number =>
        sort.key === 'citations'
          ? finding.citations.length
          : sort.key === 'updated'
            ? finding.updated
            : finding[sort.key];
    return indexed
      .filter(
        ({ finding, text }) =>
          (topic === null || finding.topic === topic) &&
          (status === 'all' || finding.status === status) &&
          words.every((word) => text.includes(word)),
      )
      .map(({ finding }) => finding)
      .sort((a, b) => {
        const x = value(a),
          y = value(b);
        return (
          direction *
            (typeof x === 'number'
              ? x - (y as number)
              : (x as string).localeCompare(y as string, undefined, { numeric: true })) ||
          b.updated - a.updated
        );
      });
  });
  let current = $derived(findings?.find((finding) => finding.id === open) ?? null);
  function toggleSort(key: SortKey) {
    sort =
      sort.key === key
        ? { key, descending: !sort.descending }
        : { key, descending: key === 'updated' || key === 'citations' };
  }
  const ariaSort = (key: SortKey) =>
    sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none';

  // Selection for bulk actions.
  let checkedShown = $derived(shown.filter((finding) => checked.has(finding.id)));
  function check(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    checked = next;
  }
  function checkAll(on: boolean) {
    checked = on ? new Set(shown.map((finding) => finding.id)) : new Set();
  }
  let busy = $state(false),
    confirmDelete = $state(false);
  /** Applies one change to each checked finding in turn, then reloads; names any that failed. */
  async function bulk(change: (finding: Finding) => Promise<unknown>) {
    busy = true;
    const failed: string[] = [];
    for (const finding of checkedShown)
      try {
        await change(finding);
      } catch {
        failed.push(finding.title);
      }
    await load();
    checked = new Set();
    busy = false;
    if (failed.length)
      error = {
        key: 'findings.bulk.failed',
        values: { count: failed.length, titles: failed.join(', ') },
      };
  }
  const setStatus = (next: Finding['status']) =>
    bulk((finding) =>
      finding.status === next
        ? Promise.resolve()
        : tool('finding_save', { project, id: finding.id, status: next, version: finding.version }),
    );
  async function deleteChecked() {
    confirmDelete = false;
    const removed = new Set(checkedShown.map((finding) => finding.id));
    await bulk((finding) => tool('finding_delete', { project, id: finding.id }));
    if (removed.has(open)) open = '';
  }

  // Keyboard: arrows move through the list and open each finding, Space checks it, Home and
  // End jump; `/` searches. Keys typed into a field are left alone.
  const rowOf = (id: string) =>
    document.querySelector<HTMLElement>(`[data-finding="${CSS.escape(id)}"]`);
  function openAt(index: number) {
    const finding = shown[Math.max(0, Math.min(shown.length - 1, index))];
    if (!finding) return;
    open = finding.id;
    void tick().then(() => rowOf(finding.id)?.focus());
  }
  function rowKey(event: KeyboardEvent, finding: Finding) {
    if (event.target !== event.currentTarget) return;
    const at = shown.indexOf(finding);
    if (event.key === 'ArrowDown') openAt(at + 1);
    else if (event.key === 'ArrowUp') openAt(at - 1);
    else if (event.key === 'Home') openAt(0);
    else if (event.key === 'End') openAt(shown.length - 1);
    else if (event.key === ' ') check(finding.id, !checked.has(finding.id));
    else if (event.key === 'Enter') open = finding.id;
    else return;
    event.preventDefault();
  }
  let filtersAnchor = $state<HTMLElement | null>(null);
  function pageKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
    if (event.key === '/') {
      event.preventDefault();
      // The header search is an icon until opened.
      document.querySelector<HTMLElement>('.page-rail-search .bx--search-magnifier')?.click();
      void tick().then(() =>
        document.querySelector<HTMLInputElement>('.page-rail-search input')?.focus(),
      );
    } else if (event.key === 'Escape' && checked.size) checked = new Set();
  }

  // Editing: a draft of one finding; saving checks that nobody changed it meanwhile.
  type Draft = Omit<Finding, 'version' | 'updated' | 'by' | 'citations' | 'source'> & {
    citations: { run: string; update: string; note: string }[];
    version: number | null;
  };
  let draft = $state<Draft | null>(null),
    saving = $state(false),
    editError = $state<Message>('');
  function edit(finding?: Finding) {
    editError = '';
    draft = finding
      ? {
          ...finding,
          citations: finding.citations.map((citation) => ({
            run: citation.run,
            update: citation.update === undefined ? '' : String(citation.update),
            note: citation.note ?? '',
          })),
        }
      : { id: '', topic: '', title: '', body: '', status: 'finding', citations: [], version: null };
  }
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  async function save() {
    if (!draft) return;
    saving = true;
    editError = '';
    try {
      // A title with no ASCII letters or digits gives no slug, so such findings get a random id.
      const id =
        draft.version === null
          ? draft.id || slug(draft.title) || 'finding-' + crypto.randomUUID().slice(0, 8)
          : draft.id;
      await tool('finding_save', {
        project,
        id,
        topic: draft.topic.trim(),
        title: draft.title.trim(),
        body: draft.body,
        status: draft.status,
        citations: draft.citations
          .filter((citation) => citation.run)
          .map((citation) => ({
            run: citation.run,
            ...(citation.update.trim() ? { update: Number(citation.update) } : {}),
            ...(citation.note.trim() ? { note: citation.note.trim() } : {}),
          })),
        version: draft.version ?? 0,
      });
      draft = null;
      await load();
      open = id;
    } catch (reason) {
      editError = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
  async function remove() {
    if (!draft || draft.version === null) return;
    saving = true;
    try {
      await tool('finding_delete', { project, id: draft.id });
      if (open === draft.id) open = '';
      draft = null;
      await load();
    } catch (reason) {
      editError = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
  let validDraft = $derived(
    !!draft &&
      !!draft.title.trim() &&
      draft.citations.every(
        (citation) => !citation.update.trim() || Number.isFinite(Number(citation.update)),
      ),
  );
  let runItems = $derived(runs.map((run) => ({ id: run.id, text: run.display_name })));

  // Earlier versions of one finding.
  type Version = { version: number; by: string; time: number; record: Finding };
  let history = $state<{ finding: Finding; versions: Version[]; shown: number } | null>(null);
  async function openHistory(finding: Finding) {
    try {
      const result = await tool('finding_get', { project, id: finding.id });
      history = { finding, versions: result.versions, shown: result.versions[0]?.version ?? 0 };
    } catch (reason) {
      error = apiMessage(reason);
    }
  }
  let historyOpen = $state(false);
  $effect(() => {
    historyOpen = !!history;
  });
</script>

<svelte:window onkeydown={pageKey} />

{#snippet card(finding: Finding)}
  <article class="finding focused" id={'finding-' + finding.id} aria-labelledby="finding-title">
    <header class="finding-header">
      <h2 id="finding-title">{finding.title}</h2>
      <span class="finding-actions">
        <Button
          kind="ghost"
          size="small"
          icon={History}
          iconDescription={$t('findings.history.open')}
          tooltipPosition="bottom"
          on:click={() => openHistory(finding)}
        /><Button
          kind="ghost"
          size="small"
          icon={Edit}
          iconDescription={$t('findings.edit.open')}
          tooltipPosition="bottom"
          tooltipAlignment="end"
          on:click={() => edit(finding)}
        /><Button
          kind="ghost"
          size="small"
          icon={Close}
          iconDescription={$t('findings.reader.close')}
          tooltipPosition="bottom"
          tooltipAlignment="end"
          on:click={() => (open = '')}
        />
      </span>
    </header>
    <p class="finding-meta">
      <Tag size="sm" type={finding.status === 'ruled_out' ? 'red' : 'green'}
        >{$t(
          finding.status === 'ruled_out' ? 'findings.status.ruledOut' : 'findings.status.finding',
        )}</Tag
      >
      <span>{finding.topic || $t('findings.noTopic')}</span>
      <span
        >{$t('findings.meta', {
          version: finding.version,
          date: $date(finding.updated),
        })}{finding.by ? ' · ' + finding.by : ''}</span
      >
    </p>
    <!-- markdown-it escapes raw HTML (html: false), so its output is safe to insert. -->
    <div class="finding-body">{@html markdown.render(finding.body)}</div>
    {#if finding.citations.length}<section class="finding-cited">
        <h3>{$t('findings.citations')}</h3>
        <ul class="finding-citations" aria-label={$t('findings.citations')}>
          {#each finding.citations as citation, position (position)}{@const cited = runById.get(
              citation.run,
            )}
            <li class="finding-citation">
              <p class="finding-citation-head">
                {#if cited}<RunName
                    id={cited.id}
                    name={cited.display_name}
                    href={runURL(cited)}
                    onclick={(event) => interceptLink(event, () => onRun(cited))}
                  />{:else}<RunName
                    id={citation.run}
                    name={citation.run}
                  />{/if}{#if citation.update !== undefined}<span class="finding-citation-at"
                    >@{$number(citation.update)}</span
                  >{/if}
              </p>
              {#if citation.note}<p class="lineage-muted">{citation.note}</p>{/if}
              <!-- The run's primary metric, with the cited update marked. -->
              {#if cited && primary?.metric && logged[cited.id] === false}<p class="lineage-muted">
                  {$t('findings.citation.noMetric', { metric: primary.metric })}
                </p>{:else if cited && primary?.metric && lineChart && logged[cited.id]}<div
                  class="finding-citation-chart"
                >
                  <PanelCard
                    height={180}
                    panel={{
                      id: 'finding-' + finding.id + '-' + position,
                      plugin: 'line',
                      metric: primary.metric,
                      metrics: [primary.metric],
                      title: primary.metric,
                      settings: {
                        ...(primary.progressKey ? { xAxis: primary.progressKey } : {}),
                        legendPosition: 'bottom',
                        ...(citation.update !== undefined
                          ? {
                              // The update shows beside the run's name.
                              marks: [{ x: citation.update }],
                            }
                          : {}),
                      },
                    }}
                    runs={[cited]}
                    {dark}
                    colors={$runColors}
                    plugin={lineChart}
                    readonly
                    onedit={() => {}}
                    onremove={() => {}}
                    onduplicate={() => {}}
                    onmove={() => {}}
                  />
                </div>{/if}
            </li>{/each}
        </ul>
      </section>{/if}
    <LedgerSource source={finding.source} />
  </article>
{/snippet}

{#snippet sortHeader(key: SortKey, label: string)}
  <th scope="col" aria-sort={ariaSort(key)} class="findings-col-{key}">
    <button type="button" class="findings-sort" onclick={() => toggleSort(key)}
      >{label}{#if sort.key === key}{#if sort.descending}<ArrowDown size={16} />{:else}<ArrowUp
            size={16}
          />{/if}{/if}</button
    >
  </th>
{/snippet}

{#snippet filterSelects(inline: boolean)}<Select
    size="sm"
    {inline}
    hideLabel={inline}
    labelText={$t('findings.filter.topic')}
    selected={topic === null ? '' : '=' + topic}
    on:change={(event) => {
      const value = (event.target as HTMLSelectElement).value;
      topic = value === '' ? null : value.slice(1);
    }}
    ><SelectItem
      value=""
      text={$t('findings.filter.allTopics')}
    />{#each topics as name (name)}<SelectItem
        value={'=' + name}
        text={name || $t('findings.noTopic')}
      />{/each}</Select
  ><Select
    size="sm"
    {inline}
    hideLabel={inline}
    labelText={$t('findings.filter.status')}
    selected={status}
    on:change={(event) => (status = (event.target as HTMLSelectElement).value as typeof status)}
    ><SelectItem value="all" text={$t('findings.filter.allStatuses')} /><SelectItem
      value="finding"
      text={$t('findings.status.finding')}
    /><SelectItem value="ruled_out" text={$t('findings.status.ruledOut')} /></Select
  >{/snippet}

<PageRail
  target={rail}
  label={$t('findings.controls')}
  bind:search
  searchLabel={$t('findings.search')}
>
  {#if narrow}<Button
      kind="ghost"
      size="small"
      icon={Filter}
      iconDescription={$t('findings.filter.open')}
      tooltipPosition="bottom"
      aria-haspopup="dialog"
      aria-expanded={!!filtersAnchor}
      on:click={(event) =>
        (filtersAnchor = filtersAnchor ? null : (event.currentTarget as HTMLElement))}
    />{:else}{@render filterSelects(true)}{/if}
  <span class="page-rail-end"
    >{#if narrow}<Button
        size="small"
        icon={Add}
        iconDescription={$t('findings.edit.new')}
        tooltipPosition="bottom"
        tooltipAlignment="end"
        on:click={() => edit()}
      />{:else}<Button size="small" icon={Add} on:click={() => edit()}
        >{$t('findings.edit.new')}</Button
      >{/if}</span
  >
</PageRail>
{#if filtersAnchor}<ContextPopover
    anchor={filtersAnchor}
    title={$t('findings.filter.open')}
    onClose={() => (filtersAnchor = null)}
    width={300}><div class="form-stack">{@render filterSelects(false)}</div></ContextPopover
  >{/if}

<div class="findings-page" class:reading={!!current}>
  {#if error}<InlineNotification
      lowContrast
      kind="error"
      title={$t('findings.errors.loadFailed')}
      subtitle={$t(error)}
      closeButtonDescription={$t('common.notification.close')}
      on:close={() => (error = '')}
    />{/if}
  {#if findings === null}{#if !error}<p class="lineage-muted findings-status">
        {$t('common.status.loading')}
      </p>{/if}
  {:else if !findings.length}<p class="empty-table">{$t('findings.empty')}</p>
  {:else}<div
      class="findings-layout"
      bind:this={layout}
      style:--findings-reader-width={readerWidth ? readerWidth + 'px' : undefined}
    >
      <section class="findings-list" aria-label={$t('findings.list')}>
        <div class="findings-list-bar" class:active={checked.size > 0}>
          {#if checked.size}<span class="findings-bulk-count"
              >{$t('findings.bulk.selected', { count: checked.size })}</span
            >
            <Button kind="ghost" size="small" disabled={busy} on:click={() => setStatus('finding')}
              >{$t('findings.bulk.markFinding')}</Button
            ><Button
              kind="ghost"
              size="small"
              disabled={busy}
              on:click={() => setStatus('ruled_out')}>{$t('findings.bulk.markRuledOut')}</Button
            ><Button
              kind="ghost"
              size="small"
              icon={TrashCan}
              disabled={busy}
              on:click={() => (confirmDelete = true)}>{$t('findings.bulk.delete')}</Button
            ><Button kind="ghost" size="small" disabled={busy} on:click={() => checkAll(false)}
              >{$t('common.action.cancel')}</Button
            >
          {:else}<span class="lineage-muted"
              >{shown.length === findings.length
                ? $t('findings.count', { count: findings.length })
                : $t('findings.countFiltered', {
                    shown: shown.length,
                    total: findings.length,
                  })}</span
            >{/if}
        </div>
        {#if !shown.length}<p class="empty-table">{$t('findings.noMatches')}</p>
        {:else}<div class="findings-scroll">
            <table class="findings-table">
              <thead>
                <tr>
                  <th scope="col" class="findings-col-check">
                    <input
                      type="checkbox"
                      class="findings-check"
                      aria-label={$t('findings.bulk.all')}
                      checked={checkedShown.length === shown.length}
                      indeterminate={checkedShown.length > 0 && checkedShown.length < shown.length}
                      onchange={(event) => checkAll(event.currentTarget.checked)}
                    />
                  </th>
                  {@render sortHeader('title', $t('findings.column.title'))}
                  {@render sortHeader('topic', $t('findings.edit.topic'))}
                  {@render sortHeader('status', $t('findings.edit.status'))}
                  {@render sortHeader('citations', $t('findings.column.runs'))}
                  {@render sortHeader('updated', $t('findings.column.updated'))}
                  {@render sortHeader('by', $t('findings.column.by'))}
                </tr>
              </thead>
              <tbody>
                {#each shown as finding (finding.id)}<tr
                    data-finding={finding.id}
                    tabindex={finding.id === (open || shown[0].id) ? 0 : -1}
                    aria-selected={finding.id === open}
                    class:checked={checked.has(finding.id)}
                    class:ruled-out={finding.status === 'ruled_out'}
                    onclick={(event) => {
                      if (!(event.target as Element).closest('input')) open = finding.id;
                    }}
                    onkeydown={(event) => rowKey(event, finding)}
                  >
                    <td class="findings-col-check">
                      <input
                        type="checkbox"
                        class="findings-check"
                        tabindex="-1"
                        aria-label={$t('findings.bulk.selectOne', { title: finding.title })}
                        checked={checked.has(finding.id)}
                        onchange={(event) => check(finding.id, event.currentTarget.checked)}
                      />
                    </td>
                    <td class="findings-col-title">{finding.title}</td>
                    <td class="findings-col-topic">{finding.topic || '–'}</td>
                    <td class="findings-col-status"
                      ><span class="findings-status-dot status-{finding.status}"></span>{$t(
                        finding.status === 'ruled_out'
                          ? 'findings.status.ruledOut'
                          : 'findings.status.finding',
                      )}</td
                    >
                    <td class="findings-col-citations">{$number(finding.citations.length)}</td>
                    <td class="findings-col-updated" title={$date(finding.updated)}
                      >{$date(finding.updated, true)}</td
                    >
                    <td class="findings-col-by">{finding.by || '–'}</td>
                  </tr>{/each}
              </tbody>
            </table>
          </div>{/if}
      </section>
      {#if current}<div class="findings-reader">{@render card(current)}</div>
        {#if !narrow}<SidebarResize
            id="findings-reader"
            label={$t('common.sidebar.resize')}
            min={320}
            width={() =>
              layout?.querySelector('.findings-reader')?.getBoundingClientRect().width ?? 480}
            max={() => (layout?.clientWidth ?? 1200) - 360}
            onresize={(next) => (readerWidth = next)}
          />{/if}{/if}
    </div>{/if}
</div>

{#if confirmDelete}<Modal
    open
    danger
    size="xs"
    modalHeading={$t('findings.bulk.deleteTitle', { count: checkedShown.length })}
    primaryButtonText={$t('findings.bulk.delete')}
    secondaryButtonText={$t('common.action.cancel')}
    iconDescription={$t('common.action.close')}
    on:click:button--secondary={() => (confirmDelete = false)}
    on:close={() => (confirmDelete = false)}
    on:submit={deleteChecked}
  >
    <p>{$t('findings.bulk.deleteBody', { count: checkedShown.length })}</p>
  </Modal>{/if}

{#if draft}<Modal
    open
    size="lg"
    hasScrollingContent
    iconDescription={$t('common.action.close')}
    modalHeading={draft.version === null ? $t('findings.edit.new') : $t('findings.edit.title')}
    primaryButtonText={saving ? $t('common.status.saving') : $t('findings.edit.save')}
    primaryButtonDisabled={saving || !validDraft}
    secondaryButtonText={$t('common.action.cancel')}
    on:click:button--secondary={() => (draft = null)}
    on:close={() => (draft = null)}
    on:submit={save}
  >
    <div class="form-stack">
      {#if editError}<InlineNotification
          lowContrast
          hideCloseButton
          kind="error"
          title={$t('findings.errors.saveFailed')}
          subtitle={$t(editError)}
        />{/if}
      <TextInput labelText={$t('findings.edit.titleLabel')} bind:value={draft.title} />
      <TextInput labelText={$t('findings.edit.topic')} bind:value={draft.topic} />
      <RadioButtonGroup
        legendText={$t('findings.edit.status')}
        name="finding-status"
        selected={draft.status}
        on:change={(event) => (draft!.status = event.detail as Finding['status'])}
        ><RadioButton value="finding" labelText={$t('findings.status.finding')} /><RadioButton
          value="ruled_out"
          labelText={$t('findings.status.ruledOut')}
        /></RadioButtonGroup
      >
      <TextArea
        labelText={$t('findings.edit.body')}
        helperText={$t('findings.edit.bodyHelp')}
        rows={10}
        bind:value={draft.body}
      />
      <fieldset class="finding-citation-editor">
        <legend class="bx--label">{$t('findings.citations')}</legend>
        {#each draft.citations as citation, position (position)}<div class="finding-citation-row">
            <Choice
              labelText={$t('findings.edit.run')}
              placeholder={$t('findings.edit.runPlaceholder')}
              selectionClearedText={$t('common.combobox.selectionCleared')}
              filterResultsText={(count) => resultCount(count, $t)}
              translateWithId={(id) =>
                $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
              translateWithIdSelection={() => $t('common.combobox.clear')}
              shouldFilterItem={filterChoice}
              items={runItems}
              selectedId={citation.run || undefined}
              on:select={(event) => (citation.run = String(event.detail.selectedId))}
            />
            <TextInput
              labelText={$t('findings.edit.update')}
              inputmode="numeric"
              bind:value={citation.update}
            />
            <TextInput labelText={$t('findings.edit.note')} bind:value={citation.note} />
            <Button
              kind="ghost"
              size="field"
              icon={TrashCan}
              iconDescription={$t('findings.edit.removeCitation')}
              on:click={() => draft!.citations.splice(position, 1)}
            />
          </div>{/each}
        <Button
          kind="ghost"
          size="small"
          icon={Add}
          on:click={() => draft!.citations.push({ run: '', update: '', note: '' })}
          >{$t('findings.edit.addCitation')}</Button
        >
      </fieldset>
      {#if draft.version !== null}<div>
          <Button kind="danger-ghost" size="small" icon={TrashCan} on:click={remove}
            >{$t('findings.edit.delete')}</Button
          >
        </div>{/if}
    </div>
  </Modal>{/if}

{#if history}<Modal
    passiveModal
    size="lg"
    bind:open={historyOpen}
    iconDescription={$t('common.action.close')}
    modalHeading={$t('findings.history.title', { title: history.finding.title })}
    on:close={() => (history = null)}
  >
    <div class="finding-history">
      <ol>
        {#each history.versions as version (version.version)}<li>
            <button
              type="button"
              class="lineage-link"
              aria-current={version.version === history.shown ? 'true' : undefined}
              onclick={() => (history!.shown = version.version)}
              >{$t('findings.history.version', {
                version: version.version,
                date: $date(version.time),
              })}</button
            >{version.by ? ' · ' + version.by : ''}
          </li>{/each}
      </ol>
      {#each history.versions.filter((version) => version.version === history!.shown) as version (version.version)}<article
          class="finding"
        >
          <header class="finding-header">
            <h3>{version.record.title}</h3>
            {#if version.record.status === 'ruled_out'}<Tag size="sm" type="red"
                >{$t('findings.status.ruledOut')}</Tag
              >{/if}
          </header>
          <div class="finding-body">{@html markdown.render(version.record.body)}</div>
        </article>{/each}
    </div>
  </Modal>{/if}
