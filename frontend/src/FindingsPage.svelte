<script lang="ts">
  // A project's findings (README "Experiment ledger"): what the runs showed, by topic, each
  // citing the runs and updates it rests on, with every earlier version kept.
  import { onMount, tick } from 'svelte';
  import {
    Button,
    InlineNotification,
    Modal,
    RadioButton,
    RadioButtonGroup,
    Search,
    Tag,
    TextArea,
    TextInput,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import History from 'carbon-icons-svelte/lib/History.svelte';
  import TrashCan from 'carbon-icons-svelte/lib/TrashCan.svelte';
  import MarkdownIt from 'markdown-it';
  import Choice from './Choice.svelte';
  import { tool, apiMessage } from './api';
  import { t, number, date, type Message } from './i18n';
  import { filterChoice, interceptLink, resultCount, runURL } from './ui';
  import type { Run } from './types';

  type Citation = { run: string; update?: number; note?: string };
  type Finding = {
    id: string;
    topic: string;
    title: string;
    body: string;
    status: 'finding' | 'ruled_out';
    citations: Citation[];
    version: number;
    updated: number;
    by: string;
  };
  let {
    project,
    runs,
    onRun,
  }: { project: string; runs: Run[]; onRun: (run: Run, tab?: string) => void } = $props();
  const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
  let findings = $state<Finding[] | null>(null),
    error = $state<Message>(''),
    search = $state(''),
    focus = $state(new URL(location.href).searchParams.get('finding') || '');
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));

  async function load() {
    try {
      findings = (await tool('findings_list', { project })).findings;
      error = '';
    } catch (reason) {
      error = apiMessage(reason);
    }
  }
  onMount(() => {
    void load().then(async () => {
      await tick();
      if (focus) document.getElementById('finding-' + focus)?.scrollIntoView({ block: 'start' });
    });
  });
  let shown = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return (findings ?? []).filter(
      (finding) =>
        !query ||
        [finding.title, finding.topic, finding.body].some((text) => text.toLowerCase().includes(query)),
    );
  });
  // Topics in name order, each with its findings, then everything ruled out.
  let topics = $derived.by(() => {
    const groups = new Map<string, Finding[]>();
    for (const finding of shown.filter((item) => item.status === 'finding')) {
      const list = groups.get(finding.topic) ?? [];
      list.push(finding);
      groups.set(finding.topic, list);
    }
    return [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  });
  let ruledOut = $derived(shown.filter((item) => item.status === 'ruled_out'));

  // Editing: a draft of one finding; saving checks that nobody changed it meanwhile.
  type Draft = Omit<Finding, 'version' | 'updated' | 'by' | 'citations'> & {
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
      await tool('finding_save', {
        project,
        id: draft.version === null ? draft.id || slug(draft.title) : draft.id,
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
      draft.citations.every((citation) => !citation.update.trim() || Number.isFinite(Number(citation.update))),
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

{#snippet card(finding: Finding)}
  <article class="finding" id={'finding-' + finding.id} class:focused={finding.id === focus}>
    <header class="finding-header">
      <h3>{finding.title}</h3>
      {#if finding.status === 'ruled_out'}<Tag size="sm" type="red"
          >{$t('findings.status.ruledOut')}</Tag
        >{/if}
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
        />
      </span>
    </header>
    <!-- markdown-it escapes raw HTML (html: false), so its output is safe to insert. -->
    <div class="finding-body">{@html markdown.render(finding.body)}</div>
    {#if finding.citations.length}<ul class="finding-citations" aria-label={$t('findings.citations')}>
        {#each finding.citations as citation, position (position)}{@const cited = runById.get(
            citation.run,
          )}<li>
            {#if cited}<a
                class="bx--link"
                href={runURL(cited)}
                onclick={(event) => interceptLink(event, () => onRun(cited))}>{cited.display_name}</a
              >{:else}<span class="lineage-muted">{citation.run}</span>{/if}{citation.update ===
            undefined
              ? ''
              : ' @' + $number(citation.update)}{#if citation.note}<span class="lineage-muted">
                — {citation.note}</span
              >{/if}
          </li>{/each}
      </ul>{/if}
    <p class="lineage-muted">
      {$t('findings.meta', { version: finding.version, date: $date(finding.updated) })}{finding.by
        ? ' · ' + finding.by
        : ''}
    </p>
  </article>
{/snippet}

<div class="project-page-content findings-page">
  <div class="page-toolbar">
    <Search
      size="lg"
      labelText={$t('findings.search')}
      placeholder={$t('findings.search')}
      closeButtonLabelText={$t('common.search.clear')}
      bind:value={search}
    />
    <Button icon={Add} on:click={() => edit()}>{$t('findings.edit.new')}</Button>
  </div>
  {#if error}<InlineNotification
      lowContrast
      kind="error"
      title={$t('findings.errors.loadFailed')}
      subtitle={$t(error)}
      closeButtonDescription={$t('common.notification.close')}
      on:close={() => (error = '')}
    />{/if}
  {#if findings === null}{#if !error}<p class="lineage-muted">{$t('common.status.loading')}</p>{/if}
  {:else if !findings.length}<p class="empty-table">{$t('findings.empty')}</p>
  {:else if !shown.length}<p class="empty-table">{$t('findings.noMatches')}</p>
  {:else}
    {#each topics as [topic, list] (topic)}<section class="findings-topic">
        <h2>{topic || $t('findings.noTopic')}</h2>
        {#each list as finding (finding.id)}{@render card(finding)}{/each}
      </section>{/each}
    {#if ruledOut.length}<section class="findings-topic">
        <h2>{$t('findings.ruledOut')}</h2>
        {#each ruledOut as finding (finding.id)}{@render card(finding)}{/each}
      </section>{/if}
  {/if}
</div>

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
