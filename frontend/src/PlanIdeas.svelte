<script lang="ts">
  // The Plans page's backlog (docs/guides/planning.md): ideas worth running once what
  // they wait on is in, by priority. Promoting one opens the plan editor on a plan made from
  // it; the plan and the idea link to each other.
  import {
    Button,
    InlineNotification,
    Modal,
    Select,
    SelectItem,
    Tag,
    TextArea,
    TextInput,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import CheckmarkFilled from 'carbon-icons-svelte/lib/CheckmarkFilled.svelte';
  import Time from 'carbon-icons-svelte/lib/Time.svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import Choice from './Choice.svelte';
  import LedgerSource from './LedgerSource.svelte';
  import RunName from './RunName.svelte';
  import { tool, apiMessage } from './api';
  import { t, number, date, type Message, type MessageKey } from './i18n';
  import { filterChoice, interceptLink, resultCount, runURL, statusLabel } from './ui';
  import type { Run } from './types';
  import type { Idea, IdeaLink, Plan } from './lineage-graph';

  let {
    project,
    ideas,
    plans,
    runs,
    findings,
    narrow = false,
    onchanged,
    onpromote,
    onplan,
    onRun,
  }: {
    project: string;
    ideas: Idea[] | null;
    plans: Plan[];
    runs: Run[];
    findings: { id: string; title: string; status: string }[];
    narrow?: boolean;
    onchanged: () => Promise<void>;
    /** Opens the plan editor on a plan made from the idea. */
    onpromote: (idea: Idea) => void;
    /** Shows a plan in the queues. */
    onplan: (id: string) => void;
    onRun: (run: Run) => void;
  } = $props();
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));

  // Open ideas by default; promoted and dropped ones a click away.
  type Shown = Idea['status'];
  let status = $state<Shown>('open');
  const counts = $derived(
    Object.fromEntries(
      (['open', 'promoted', 'dropped'] as const).map((key) => [
        key,
        (ideas ?? []).filter((idea) => idea.status === key).length,
      ]),
    ) as Record<Shown, number>,
  );
  const shown = $derived((ideas ?? []).filter((idea) => idea.status === status));
  const statusLabels: Record<Shown, MessageKey> = {
    open: 'plans.ideas.status.open',
    promoted: 'plans.ideas.status.promoted',
    dropped: 'plans.ideas.status.dropped',
  };
  const priorityLabels: Record<Idea['priority'], MessageKey> = {
    high: 'plans.ideas.priority.high',
    medium: 'plans.ideas.priority.medium',
    low: 'plans.ideas.priority.low',
  };
  let expanded = $state<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    expanded = next;
  };

  /** What an idea waits on, named, with its state and whether it is in yet. */
  function link(item: IdeaLink) {
    if (item.kind === 'run') {
      const run = runById.get(item.id);
      return {
        name: run?.display_name ?? item.id,
        state: run ? statusLabel(run.state, $t) : $t('plans.ideas.missing'),
        met: !!run && run.state !== 'running',
        run,
      };
    }
    if (item.kind === 'plan') {
      const plan = plans.find((entry) => entry.id === item.id);
      return {
        name: plan?.name ?? item.id,
        state: plan ? $t(`plans.status.${plan.status}` as MessageKey) : $t('plans.ideas.missing'),
        met: !!plan && ['done', 'stopped', 'cancelled'].includes(plan.status),
        run: undefined,
      };
    }
    const finding = findings.find((entry) => entry.id === item.id);
    return {
      name: finding?.title ?? item.id,
      state: finding
        ? $t(
            finding.status === 'ruled_out' ? 'findings.status.ruledOut' : 'findings.status.finding',
          )
        : $t('plans.ideas.missing'),
      met: !!finding,
      run: undefined,
    };
  }
  const kindLabels: Record<IdeaLink['kind'], MessageKey> = {
    run: 'plans.ideas.kind.run',
    plan: 'plans.ideas.kind.plan',
    finding: 'plans.ideas.kind.finding',
  };

  // Editing one idea.
  type Draft = {
    id: string;
    title: string;
    hypothesis: string;
    evidence: string;
    prerequisites: string;
    waits_on: IdeaLink[];
    priority: Idea['priority'];
    status: Idea['status'];
    created: boolean;
  };
  let draft = $state<Draft | null>(null),
    editError = $state<Message>(''),
    saving = $state(false);
  function edit(idea?: Idea) {
    editError = '';
    draft = idea
      ? {
          id: idea.id,
          title: idea.title,
          hypothesis: idea.hypothesis,
          evidence: idea.evidence,
          prerequisites: idea.prerequisites,
          waits_on: [...idea.waits_on],
          priority: idea.priority,
          status: idea.status,
          created: true,
        }
      : {
          id: '',
          title: '',
          hypothesis: '',
          evidence: '',
          prerequisites: '',
          waits_on: [],
          priority: 'medium',
          status: 'open',
          created: false,
        };
  }
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  // Everything an idea can wait on, by kind.
  const linkItems = $derived([
    ...runs.map((run) => ({ id: 'run:' + run.id, text: run.display_name })),
    ...plans
      .filter((plan) => ['planned', 'started'].includes(plan.status))
      .map((plan) => ({ id: 'plan:' + plan.id, text: plan.name })),
    ...findings.map((finding) => ({ id: 'finding:' + finding.id, text: finding.title })),
  ]);
  let linkPick = $state<string | undefined>(undefined);
  function addLink(value: string) {
    if (!draft) return;
    const at = value.indexOf(':'),
      item = { kind: value.slice(0, at) as IdeaLink['kind'], id: value.slice(at + 1) };
    if (!draft.waits_on.some((entry) => entry.kind === item.kind && entry.id === item.id))
      draft.waits_on = [...draft.waits_on, item];
    linkPick = undefined;
  }
  async function save(next?: Idea['status']) {
    if (!draft) return;
    saving = true;
    editError = '';
    try {
      await tool('idea_save', {
        project,
        id: draft.id.trim() || slug(draft.title) || 'idea-' + crypto.randomUUID().slice(0, 8),
        title: draft.title.trim(),
        hypothesis: draft.hypothesis,
        evidence: draft.evidence,
        prerequisites: draft.prerequisites,
        waits_on: draft.waits_on,
        priority: draft.priority,
        ...(next ? { status: next } : draft.status !== 'promoted' ? { status: draft.status } : {}),
      });
      draft = null;
      await onchanged();
    } catch (reason) {
      editError = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
  async function remove() {
    if (!draft) return;
    saving = true;
    try {
      await tool('idea_delete', { project, id: draft.id });
      draft = null;
      await onchanged();
    } catch (reason) {
      editError = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
  const choice = {
    selectionClearedText: '',
    translateWithIdSelection: () => $t('common.combobox.clear'),
    shouldFilterItem: filterChoice,
  };
</script>

{#snippet linkChip(item: IdeaLink)}{@const shown = link(item)}<span
    class="idea-link"
    class:met={shown.met}
    title={$t(kindLabels[item.kind]) + ' · ' + shown.state}
    >{#if shown.met}<CheckmarkFilled size={16} class="idea-link-icon" />{:else}<Time
        size={16}
        class="idea-link-icon"
      />{/if}{#if shown.run}<RunName
        quiet
        id={shown.run.id}
        name={shown.name}
        href={runURL(shown.run)}
        onclick={(event) => interceptLink(event, () => onRun(shown.run!))}
      />{:else}<span class="idea-link-name">{shown.name}</span>{/if}<span class="idea-link-state"
      >{shown.state}</span
    ></span
  >{/snippet}

<section class="plans-section plan-ideas" aria-labelledby="plans-ideas-title">
  <div class="plans-heading">
    <h2 id="plans-ideas-title">{$t('plans.ideas.title')}</h2>
    <div class="plan-history-filter" role="group" aria-label={$t('plans.ideas.filter')}>
      {#each ['open', 'promoted', 'dropped'] as const as key (key)}<button
          type="button"
          class="plan-history-chip"
          aria-pressed={status === key}
          onclick={() => (status = key)}
          >{$t(statusLabels[key])}<span class="plan-history-chip-count">{$number(counts[key])}</span
          ></button
        >{/each}
    </div>
    {#if narrow}<Button
        kind="tertiary"
        size="small"
        icon={Add}
        iconDescription={$t('plans.ideas.new')}
        tooltipPosition="left"
        on:click={() => edit()}
      />{:else}<Button kind="tertiary" size="small" icon={Add} on:click={() => edit()}
        >{$t('plans.ideas.new')}</Button
      >{/if}
  </div>
  {#if ideas === null}<p class="lineage-muted">{$t('common.status.loading')}</p>
  {:else if !shown.length}<p class="empty-table">
      {$t(status === 'open' ? 'plans.ideas.empty' : 'plans.ideas.noneHere')}
    </p>
  {:else}<table class="queue-table idea-table">
      <colgroup>
        <col class="idea-col-priority" />
        <col class="idea-col-idea" />
        <col class="idea-col-waits" />
        <col class="idea-col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">{$t('plans.ideas.column.priority')}</th>
          <th scope="col">{$t('plans.ideas.column.idea')}</th>
          <th scope="col">{$t('plans.ideas.column.waits')}</th>
          <th scope="col"><span class="visually-hidden">{$t('plans.lane.column.actions')}</span></th
          >
        </tr>
      </thead>
      <tbody>
        {#each shown as idea (idea.id)}{@const open = expanded.has(idea.id)}
          <tr id={'idea-' + idea.id} class="idea-row" class:open>
            <td class="idea-col-priority">
              <span class="idea-priority priority-{idea.priority}"
                >{$t(priorityLabels[idea.priority])}</span
              >
            </td>
            <td class="idea-col-idea">
              <button
                type="button"
                class="queue-name"
                aria-expanded={open}
                aria-controls={'idea-details-' + idea.id}
                onclick={() => toggle(idea.id)}
                ><ChevronRight size={16} class="queue-chevron" /><span>{idea.title}</span></button
              >
              {#if idea.hypothesis}<span class="queue-sub idea-summary">{idea.hypothesis}</span
                >{/if}
            </td>
            <td class="idea-col-waits">
              {#if idea.waits_on.length}<span class="idea-links"
                  >{#each idea.waits_on as item (item.kind + ':' + item.id)}{@render linkChip(
                      item,
                    )}{/each}</span
                >{/if}
              {#if idea.prerequisites}<span class="queue-sub idea-summary"
                  >{idea.prerequisites}</span
                >{:else if !idea.waits_on.length}<span class="queue-sub"
                  >{$t('plans.ideas.nothingFirst')}</span
                >{/if}
            </td>
            <td class="idea-col-actions">
              {#if idea.status === 'open'}<Button
                  kind="ghost"
                  size="small"
                  on:click={() => onpromote(idea)}>{$t('plans.ideas.promote')}</Button
                >{:else if idea.status === 'promoted' && idea.plan}<Button
                  kind="ghost"
                  size="small"
                  on:click={() => onplan(idea.plan!)}
                  >{$t('plans.ideas.toPlan', {
                    plan: plans.find((plan) => plan.id === idea.plan)?.name ?? idea.plan,
                  })}</Button
                >{/if}<Button
                kind="ghost"
                size="small"
                icon={Edit}
                iconDescription={$t('plans.ideas.edit')}
                tooltipAlignment="end"
                on:click={() => edit(idea)}
              />
            </td>
          </tr>
          {#if open}<tr class="queue-details-row" id={'idea-details-' + idea.id}>
              <td></td>
              <td colspan="3">
                <div class="queue-details">
                  <dl class="queue-facts">
                    {#if idea.hypothesis}<div>
                        <dt>{$t('lineage.panel.hypothesis')}</dt>
                        <dd>{idea.hypothesis}</dd>
                      </div>{/if}
                    {#if idea.evidence}<div>
                        <dt>{$t('plans.ideas.evidence')}</dt>
                        <dd>{idea.evidence}</dd>
                      </div>{/if}
                    {#if idea.prerequisites}<div>
                        <dt>{$t('plans.ideas.prerequisites')}</dt>
                        <dd>{idea.prerequisites}</dd>
                      </div>{/if}
                    <div>
                      <dt>{$t('plans.ideas.changed')}</dt>
                      <dd>{$date(idea.updated)}{idea.by ? ' · ' + idea.by : ''}</dd>
                    </div>
                  </dl>
                  <footer class="queue-details-footer">
                    <LedgerSource source={idea.source} />
                  </footer>
                </div>
              </td>
            </tr>{/if}
        {/each}
      </tbody>
    </table>{/if}
</section>

{#if draft}<Modal
    open
    size="lg"
    hasScrollingContent
    class="plan-editor"
    iconDescription={$t('common.action.close')}
    modalHeading={draft.created ? $t('plans.ideas.edit') : $t('plans.ideas.new')}
    primaryButtonText={saving ? $t('common.status.saving') : $t('plans.ideas.save')}
    primaryButtonDisabled={saving || !draft.title.trim()}
    secondaryButtonText={$t('common.action.cancel')}
    on:click:button--secondary={() => (draft = null)}
    on:close={() => (draft = null)}
    on:submit={() => save()}
  >
    <div class="plan-form">
      {#if editError}<InlineNotification
          lowContrast
          hideCloseButton
          kind="error"
          title={$t('plans.ideas.errors.failed')}
          subtitle={$t(editError)}
        />{/if}
      <fieldset class="plan-form-section">
        <legend>{$t('plans.ideas.section.idea')}</legend>
        <div class="plan-form-grid">
          <div class={draft.created ? 'span-8' : 'span-5'}>
            <TextInput labelText={$t('plans.ideas.titleLabel')} bind:value={draft.title} />
          </div>
          {#if !draft.created}<div class="span-3">
              <TextInput
                labelText={$t('plans.ideas.id')}
                placeholder={slug(draft.title)}
                bind:value={draft.id}
              />
            </div>{/if}
          <div class="span-4">
            <Select labelText={$t('plans.ideas.column.priority')} bind:selected={draft.priority}
              ><SelectItem value="high" text={$t('plans.ideas.priority.high')} /><SelectItem
                value="medium"
                text={$t('plans.ideas.priority.medium')}
              /><SelectItem value="low" text={$t('plans.ideas.priority.low')} /></Select
            >
          </div>
          <div class="span-12">
            <TextArea
              labelText={$t('lineage.panel.hypothesis')}
              rows={3}
              bind:value={draft.hypothesis}
            />
          </div>
          <div class="span-12">
            <TextArea
              labelText={$t('plans.ideas.evidence')}
              helperText={$t('plans.ideas.evidenceHelp')}
              rows={3}
              bind:value={draft.evidence}
            />
          </div>
        </div>
      </fieldset>
      <fieldset class="plan-form-section">
        <legend>{$t('plans.ideas.section.first')}</legend>
        <div class="plan-form-grid">
          <div class="span-12">
            <TextArea
              labelText={$t('plans.ideas.prerequisites')}
              rows={2}
              bind:value={draft.prerequisites}
            />
          </div>
          <div class="span-12">
            <Choice
              {...choice}
              labelText={$t('plans.ideas.waitsOn')}
              helperText={$t('plans.ideas.waitsOnHelp')}
              selectionClearedText={$t('common.combobox.selectionCleared')}
              filterResultsText={(count) => resultCount(count, $t)}
              translateWithId={(id) =>
                $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
              items={linkItems}
              selectedId={linkPick}
              on:select={(event) => addLink(String(event.detail.selectedId))}
            />
          </div>
          {#if draft.waits_on.length}<ul class="span-12 idea-link-list">
              {#each draft.waits_on as item, index (item.kind + ':' + item.id)}<li>
                  <Tag size="sm" type="cool-gray">{$t(kindLabels[item.kind])}</Tag>
                  {@render linkChip(item)}
                  <Button
                    kind="ghost"
                    size="small"
                    icon={Close}
                    iconDescription={$t('plans.ideas.removeLink')}
                    tooltipAlignment="end"
                    on:click={() =>
                      (draft!.waits_on = draft!.waits_on.filter((_, at) => at !== index))}
                  />
                </li>{/each}
            </ul>{/if}
        </div>
      </fieldset>
      {#if draft.created}<div class="plan-form-actions">
          {#if draft.status === 'dropped'}<Button
              kind="ghost"
              size="small"
              on:click={() => save('open')}>{$t('plans.ideas.reopen')}</Button
            >{:else}<Button kind="ghost" size="small" on:click={() => save('dropped')}
              >{$t('plans.ideas.drop')}</Button
            >{/if}
          <Button kind="danger-ghost" size="small" on:click={remove}
            >{$t('plans.ideas.delete')}</Button
          >
        </div>{/if}
    </div>
  </Modal>{/if}
