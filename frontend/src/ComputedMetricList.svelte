<script module lang="ts">
  import type { Message } from './i18n';
  import type { ExpressionErrorCode, ExpressionErrorParams } from '../../backend/src/expressions';
  export type ComputedRow = { id: number; name: string; expression: string };
  export type ComputedCheck = {
    name: string;
    suggestion: string;
    nameError?: Message;
    expressionError?: Message;
    errorCode?: ExpressionErrorCode;
    errorParams?: ExpressionErrorParams;
  };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { Button, TextInput, OverflowMenu, OverflowMenuItem } from 'carbon-components-svelte';
  import { Add, TrashCan } from 'carbon-icons-svelte';
  import { expressionFunctions, expressionConstants } from '../../backend/src/expressions';
  import ExpressionInput from './ExpressionInput.svelte';
  import { t } from './i18n';
  let {
    rows = $bindable(),
    checks,
    metrics,
    capacity,
    plotted,
    loading,
    nextId,
  }: {
    rows: ComputedRow[];
    checks: ComputedCheck[];
    metrics: string[];
    capacity: number;
    plotted: string[];
    loading: boolean;
    nextId: () => number;
  } = $props();
  let syntax = $state(false),
    allFunctions = $state(false),
    announcement = $state(''),
    visibleErrors = $state<Record<number, boolean>>({}),
    addButton = $state<HTMLButtonElement | null>(null);
  const example = $derived.by(() => {
    const selected = plotted.filter((name) => !name.includes('}')),
      available = metrics.filter((name) => !name.includes('}'));
    const names = selected.length >= 2 ? selected : available;
    return names.length >= 2 ? '${' + names[0] + '} / ${' + names[1] + '}' : '${loss} * 100';
  });
  const hiddenErrors = $derived(
    checks.filter(
      (check, index) => check.expressionError && !visibleErrors[rows[index].id] && !check.nameError,
    ).length,
  );
  async function focusExpression(id: number) {
    await tick();
    const field = document.getElementById('computed-expression-' + id);
    field?.focus();
    field?.scrollIntoView({ block: 'nearest' });
  }
  function add(expression = '') {
    if (capacity <= 0) return;
    const id = nextId();
    rows = [...rows, { id, name: '', expression }];
    void focusExpression(id);
  }
  async function remove(index: number) {
    const row = rows[index],
      name = checks[index].name;
    rows = rows.filter((item) => item.id !== row.id);
    delete visibleErrors[row.id];
    announcement = $t('charts.expressions.removed', { name });
    const target = rows[index] || rows[index - 1];
    if (target) await focusExpression(target.id);
    else {
      await tick();
      addButton?.focus();
    }
  }
  async function move(index: number, delta: number) {
    const row = rows[index],
      name = checks[index].name,
      next = index + delta;
    if (next < 0 || next >= rows.length) return;
    const updated = [...rows];
    updated.splice(next, 0, ...updated.splice(index, 1));
    rows = updated;
    announcement = $t('charts.expressions.moved', { name, position: next + 1 });
    await tick();
    document.getElementById('computed-menu-' + row.id)?.focus();
  }
  function duplicate(index: number) {
    if (capacity <= 0) return;
    const row = rows[index],
      id = nextId();
    let name = '';
    if (row.name.trim()) {
      const taken = new Set([...plotted, ...checks.map((check) => check.name)]);
      let suffix = 2;
      do {
        const ending = ` (${suffix++})`;
        name = row.name.trim().slice(0, 200 - ending.length) + ending;
      } while (taken.has(name));
    }
    rows = [
      ...rows.slice(0, index + 1),
      { id, name, expression: row.expression },
      ...rows.slice(index + 1),
    ];
    void focusExpression(id);
  }
</script>

<section class="computed-metrics" aria-label={$t('charts.expressions.title')}>
  <div class="computed-metrics-heading">
    <span class="bx--label">{$t('charts.expressions.title')}</span><Button
      kind="ghost"
      size="small"
      aria-expanded={syntax}
      on:click={() => (syntax = !syntax)}>{$t('charts.expressions.syntax.toggle')}</Button
    >
  </div>
  {#if syntax}<div class="computed-syntax">
      <dl>
        <dt>{$t('charts.expressions.syntax.metric')}</dt>
        <dd><code>{'${metric/name}'}</code></dd>
        <dt>{$t('charts.expressions.syntax.operators')}</dt>
        <dd>
          <code>+ - * / % ** &lt; &lt;= &gt; &gt;= == != === !== &amp;&amp; || ! a ? b : c</code
          ><span>{$t('charts.expressions.syntax.comparisons')}</span>
        </dd>
        <dt>{$t('charts.expressions.syntax.functions')}</dt>
        <dd>
          <code>Math.log, Math.sqrt, Math.max, …</code><Button
            kind="ghost"
            size="small"
            aria-expanded={allFunctions}
            on:click={() => (allFunctions = !allFunctions)}
            >{$t('charts.expressions.syntax.allFunctions')}</Button
          >{#if allFunctions}<code
              >{[...Object.keys(expressionFunctions), ...expressionConstants]
                .map((name) => 'Math.' + name)
                .join(', ')}</code
            >{/if}
        </dd>
      </dl>
      <p class="bx--form__helper-text">{$t('charts.expressions.syntax.skipped')}</p>
    </div>{/if}
  {#if !rows.length}<div class="computed-empty">
      <p class="bx--form__helper-text">{$t('charts.expressions.empty')}</p>
      <code>{example}</code>
    </div>{/if}
  <ol class="computed-metrics-list" aria-label={$t('charts.expressions.title')}>
    {#each rows as row, index (row.id)}<li
        class="computed-metric"
        role="group"
        aria-labelledby={'computed-label-' + row.id}
      >
        <span class="bx--assistive-text" id={'computed-label-' + row.id}
          >{$t('charts.expressions.rowLabel', { index: index + 1, name: checks[index].name })}</span
        >
        <ExpressionInput
          id={'computed-expression-' + row.id}
          labelText={$t('charts.expressions.expression')}
          placeholder={example}
          {metrics}
          {plotted}
          {loading}
          bind:value={row.expression}
          invalid={!!checks[index].expressionError}
          invalidText={$t(checks[index].expressionError)}
          errorCode={checks[index].errorCode}
          errorParams={checks[index].errorParams}
          bind:errorVisible={visibleErrors[row.id]}
        />
        <div class="computed-name-actions">
          <TextInput
            labelText={$t('charts.expressions.name')}
            placeholder={checks[index].suggestion}
            bind:value={row.name}
            maxlength={200}
            invalid={!!checks[index].nameError}
            invalidText={$t(checks[index].nameError)}
          />
          <OverflowMenu
            id={'computed-menu-' + row.id}
            aria-label={$t('charts.expressions.actions', { name: checks[index].name })}
            iconDescription={$t('charts.expressions.actions', { name: checks[index].name })}
            flipped
          >
            <OverflowMenuItem
              text={$t('charts.expressions.moveToFirst', { name: checks[index].name })}
              disabled={index === 0}
              on:click={() => move(index, -index)}
            />
            <OverflowMenuItem
              text={$t('charts.expressions.moveEarlier', { name: checks[index].name })}
              disabled={index === 0}
              on:click={() => move(index, -1)}
            />
            <OverflowMenuItem
              text={$t('charts.expressions.moveLater', { name: checks[index].name })}
              disabled={index === rows.length - 1}
              on:click={() => move(index, 1)}
            />
            <OverflowMenuItem
              text={$t('charts.expressions.moveToLast', { name: checks[index].name })}
              disabled={index === rows.length - 1}
              on:click={() => move(index, rows.length - 1 - index)}
            />
            <OverflowMenuItem
              text={$t('charts.expressions.duplicate', { name: checks[index].name })}
              disabled={capacity <= 0}
              on:click={() => duplicate(index)}
            />
          </OverflowMenu>
          <Button
            kind="ghost"
            size="field"
            icon={TrashCan}
            iconDescription={$t('charts.expressions.remove', { name: checks[index].name })}
            tooltipPosition="left"
            on:click={() => remove(index)}
          />
        </div>
      </li>{/each}
  </ol>
  <div class="computed-add">
    <Button
      bind:ref={addButton}
      kind="ghost"
      size="small"
      icon={Add}
      disabled={capacity <= 0}
      aria-describedby={capacity <= 0 ? 'computed-budget' : undefined}
      on:click={() => add()}>{$t('charts.expressions.add')}</Button
    >
    {#if !rows.length && plotted.length >= 2}<Button
        kind="ghost"
        size="small"
        disabled={capacity <= 0}
        aria-describedby={capacity <= 0 ? 'computed-budget' : undefined}
        on:click={() => add(example)}>{$t('charts.expressions.useExample')}</Button
      >{/if}
  </div>
  {#if capacity <= 0}<p class="bx--form__helper-text" id="computed-budget">
      {$t('charts.expressions.budgetFull')}
    </p>{/if}
  {#if hiddenErrors}<p class="bx--form__helper-text" role="status">
      {$t('charts.expressions.fixToSave', { count: hiddenErrors })}
    </p>{/if}
  <span class="bx--assistive-text" role="status">{announcement}</span>
</section>
