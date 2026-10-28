<script lang="ts">
  import { filterChoice, fieldLabel, statusLabel, resultCount } from './ui';
  import { t, type Message, type MessageKey } from './i18n';
  import { apiMessage } from './api';

  import ContextPopover from './ContextPopover.svelte';
  import {
    ComboBox,
    TextInput,
    Select,
    SelectItem,
    Button,
    InlineNotification,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  const conditions: [string, MessageKey][] = [
    ['eq', 'runs.filter.operators.eq'],
    ['ne', 'runs.filter.operators.ne'],
    ['gt', 'runs.filter.operators.gt'],
    ['gte', 'runs.filter.operators.gte'],
    ['lt', 'runs.filter.operators.lt'],
    ['lte', 'runs.filter.operators.lte'],
    ['contains', 'runs.filter.operators.contains'],
    ['exists', 'runs.filter.operators.exists'],
  ];
  function operators(field: string) {
    const allowed =
      field === 'state'
        ? ['eq', 'ne', 'exists']
        : field === 'tags'
          ? ['contains', 'exists']
          : ['name', 'display_name', 'group_name', 'job_type'].includes(field)
            ? ['eq', 'ne', 'contains', 'exists']
            : conditions.map(([id]) => id);
    return conditions.filter(([id]) => allowed.includes(id));
  }
  function dateInput(value: string) {
    const date = new Date(Number(value) * 1000);
    return value && Number.isFinite(date.getTime())
      ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : '';
  }
  type Rule = { field: string; operator: string; value: string };
  let {
    open = $bindable(false),
    filters,
    anchor,
    fields,
    mode,
    onApply,
    loadValues,
  }: {
    open: boolean;
    filters: Rule[];
    anchor: HTMLElement | null;
    fields: string[];
    mode: string;
    onApply: (rules: Rule[], mode: string) => void;
    loadValues: (field: string) => Promise<string[]>;
  } = $props();
  let rules = $state<Rule[]>([]),
    draftMode = $state('and'),
    wasOpen = false;
  let suggestions = $state<Record<string, string[]>>({}),
    valueError = $state<Message>('');
  let queryFields = $derived(
    open
      ? [
          ...new Set(
            rules
              .map((rule) => rule.field)
              .filter(
                (field) => field && field !== 'state' && !['created', 'updated','started','finished'].includes(field),
              ),
          ),
        ].join('\n')
      : '',
  );
  $effect(() => {
    const fields = queryFields.split('\n').filter(Boolean);
    let current = true;
    for (const field of fields)
      void loadValues(field)
        .then((values) => {
          if (current) suggestions = { ...suggestions, [field]: values };
        })
        .catch((error) => {
          if (current) valueError = apiMessage(error);
        });
    return () => {
      current = false;
    };
  });
  $effect(() => {
    if (open && !wasOpen) {
      rules = filters.length
        ? JSON.parse(JSON.stringify(filters))
        : [{ field: '', operator: 'eq', value: '' }];
      draftMode = mode;
    }
    wasOpen = open;
  });
</script>

{#if open && anchor}<ContextPopover
    {anchor}
    title={$t('runs.filter.title')}
    width={520}
    onClose={() => (open = false)}
  >
    {#if valueError}<InlineNotification
        kind="error"
        title={$t(valueError)}
        on:close={() => (valueError = '')}
      />{/if}
    {#if rules.length > 1}<Select labelText={$t('runs.filter.match')} bind:selected={draftMode}
        ><SelectItem value="and" text={$t('runs.filter.all')} /><SelectItem
          value="or"
          text={$t('runs.filter.any')}
        /></Select
      >
    {/if}
    {#each rules as rule, i}<div class="filter-rule">
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
          labelText={$t('runs.filter.field')}
          items={fields
            .filter((id) => !id.startsWith('config._') && !id.startsWith('summary._'))
            .map((id) => ({ id, text: fieldLabel(id, $t) }))}
          selectedId={rule.field}
          on:clear={() => {
            rule.field = '';
            rule.value = '';
          }}
          clearFilterOnOpen
          on:select={(event) => {
            const next = String(event.detail.selectedId || '');
            if (next !== rule.field) rule.value = '';
            rule.field = next;
            if (!operators(rule.field).some(([id]) => id === rule.operator))
              rule.operator = operators(rule.field)[0][0];
          }}
        /><Select labelText={$t('runs.filter.condition')} bind:selected={rule.operator}
          >{#each operators(rule.field) as [id, label]}<SelectItem
              value={id}
              text={$t(label)}
            />{/each}</Select
        >
        {#if rule.field === 'state'}<Select
            labelText={$t('runs.filter.value')}
            bind:selected={rule.value}
            disabled={rule.operator === 'exists'}
            ><SelectItem
              value=""
              text={$t('runs.filter.chooseState')}
            />{#each ['running', 'finished', 'failed', 'crashed', 'killed'] as state}<SelectItem
                value={state}
                text={statusLabel(state, $t)}
              />{/each}</Select
          >
        {:else if ['created', 'updated','started','finished'].includes(rule.field)}<TextInput
            labelText={$t('runs.filter.dateTime')}
            type="datetime-local"
            value={dateInput(rule.value)}
            disabled={rule.operator === 'exists'}
            on:input={(event) =>
              (rule.value = event.detail
                ? String(new Date(String(event.detail)).getTime() / 1000)
                : '')}
          />
        {:else}<ComboBox
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
            labelText={$t('runs.filter.value')}
            placeholder={$t('runs.filter.valuePlaceholder')}
            items={(suggestions[rule.field] || []).map((id) => ({ id, text: id }))}
            on:select={(event) => (rule.value = String(event.detail.selectedId || ''))}
            bind:value={rule.value}
            disabled={rule.operator === 'exists'}
          />{/if}<Button
          kind="ghost"
          size="small"
          icon={Close}
          hideTooltip title={$t('runs.filter.removeCondition')} iconDescription={$t('runs.filter.removeCondition')}
          portalTooltip
          tooltipAlignment="end"
          tooltipPosition="left"
          on:click={() => (rules = rules.filter((_, index) => index !== i))}
        />
      </div>{/each}
    <Button
      kind="tertiary"
      size="small"
      icon={Add}
      disabled={rules.length >= 20}
      on:click={() => (rules = [...rules, { field: '', operator: 'eq', value: '' }])}
      >{$t('runs.filter.addCondition')}</Button
    >
    <div class="popover-footer">
      <Button
        kind="ghost"
        size="small"
        on:click={() => {
          rules = [];
          onApply([], 'and');
          open = false;
        }}>{$t('runs.filter.clear')}</Button
      ><Button
        size="small"
        disabled={rules.some((rule) => !rule.field) ||
          (JSON.stringify(rules) === JSON.stringify(filters) && draftMode === mode)}
        on:click={() => {
          onApply(
            rules.filter((r) => r.field.trim()),
            draftMode,
          );
          open = false;
        }}>{$t('runs.filter.apply')}</Button
      >
    </div>
  </ContextPopover>{/if}
