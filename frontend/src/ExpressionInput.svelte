<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from 'carbon-components-svelte';
  import { Add, WarningAltFilled } from 'carbon-icons-svelte';
  import {
    scanExpression,
    expressionFunctions,
    expressionConstants,
    type ExpressionErrorCode,
    type ExpressionErrorParams,
  } from '../../backend/src/expressions';
  import { matchScore, highlightRanges } from './search';
  import { imeKeys } from './ime';
  import { t } from './i18n';
  let {
    id,
    labelText,
    value = $bindable(''),
    metrics,
    plotted = [],
    loading = false,
    invalid = false,
    invalidText = '',
    errorCode,
    errorParams = {},
    placeholder = '',
    errorVisible = $bindable<boolean>(),
  }: {
    id: string;
    labelText: string;
    value?: string;
    metrics: string[];
    plotted?: string[];
    loading?: boolean;
    invalid?: boolean;
    invalidText?: string;
    errorCode?: ExpressionErrorCode;
    errorParams?: ExpressionErrorParams;
    placeholder?: string;
    errorVisible?: boolean;
  } = $props();
  let input = $state<HTMLTextAreaElement | null>(null),
    mirror = $state<HTMLDivElement | null>(null),
    list = $state<HTMLUListElement | null>(null),
    caret = $state(0),
    active = $state(0),
    dismissed = $state(true),
    forced = $state(false),
    composing = $state(false),
    touched = $state(false),
    idle = $state(false),
    announcement = $state('');
  const tokens = $derived(scanExpression(value));
  const metricSet = $derived(new Set(metrics));
  const missing = $derived(
    loading
      ? []
      : [
          ...new Set(
            tokens
              .filter((token) => token.type === 'ref' && !metricSet.has(token.name!))
              .map((token) => token.name!),
          ),
        ],
  );
  const context = $derived.by(() => {
    const before = value.slice(0, caret),
      start = before.lastIndexOf('${');
    if (start >= 0 && !before.slice(start).includes('}'))
      return { kind: 'metric', start, query: before.slice(start + 2) };
    const math = /Math\.([A-Za-z0-9_]*)$/.exec(before);
    if (math && !forced) return { kind: 'math', start: caret - math[0].length, query: math[1] };
    return forced ? { kind: 'metric', start: caret, query: '' } : null;
  });
  const matches = $derived.by(() => {
    if (!context) return [];
    const candidates =
      context.kind === 'math'
        ? [...Object.keys(expressionFunctions), ...expressionConstants]
        : metrics.filter((metric) => !metric.includes('}'));
    const scored = candidates
      .map((name) => ({ name, score: matchScore(context.query, name) }))
      .filter((item) => item.score >= 0);
    const ordinary = scored.some((item) => item.score < 4);
    return scored
      .filter((item) => !ordinary || item.score < 4)
      .sort(
        (a, b) =>
          a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name),
      )
      .slice(0, 50)
      .map((item) => item.name);
  });
  const open = $derived(!dismissed && !composing && context !== null);
  const stillTyping = new Set([
    'EXPRESSION_INCOMPLETE',
    'EXPRESSION_UNTERMINATED_REFERENCE',
    'EXPRESSION_EMPTY_REFERENCE',
    'EXPRESSION_EMPTY',
    'EXPRESSION_NO_METRIC',
  ]);
  const showError = $derived(
    invalid &&
      !open &&
      !composing &&
      (touched || idle || (!!errorCode && !stillTyping.has(errorCode))),
  );
  const errorStart = $derived(
    errorCode === 'EXPRESSION_INCOMPLETE'
      ? value.length
      : Math.max(0, Number(errorParams.position || 1) - 1),
  );
  const errorEnd = $derived(
    errorStart +
      (['EXPRESSION_UNEXPECTED', 'EXPRESSION_UNKNOWN_NAME', 'EXPRESSION_ARGUMENTS'].includes(
        errorCode || '',
      )
        ? String(errorParams.token || ' ').length
        : 1),
  );
  // Split only for the displayed error; the tolerant scan itself runs only when the value changes.
  const fragments = $derived(
    tokens.flatMap((token) => {
      const edges = [
        token.start,
        token.end,
        ...(showError
          ? [errorStart, errorEnd].filter((at) => at > token.start && at < token.end)
          : []),
      ].sort((a, b) => a - b);
      return edges.slice(0, -1).map((start, i) => ({
        ...token,
        start,
        end: edges[i + 1],
        text: value.slice(start, edges[i + 1]),
      }));
    }),
  );
  $effect(() => {
    errorVisible = showError;
  });
  $effect(() => {
    value;
    idle = false;
    const timer = setTimeout(() => {
      idle = true;
    }, 800);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    matches;
    active = 0;
  });
  $effect(() => {
    const text = open
      ? loading
        ? $t('metrics.loading')
        : $t(matches.length ? 'charts.expressions.matches' : 'charts.expressions.noMatches', {
            count: matches.length,
          })
      : '';
    const timer = setTimeout(() => {
      announcement = text;
    }, 300);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    if (open) {
      active;
      void tick().then(() =>
        list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }),
      );
    }
  });
  function track() {
    caret = input?.selectionStart ?? value.length;
    dismissed = false;
    forced = false;
  }
  function insertMetric() {
    caret = input?.selectionStart ?? value.length;
    forced = true;
    dismissed = false;
    input?.focus();
  }
  function resize() {
    if (!input) return;
    input.style.height = '0px';
    const style = getComputedStyle(input);
    input.style.height =
      Math.min(
        parseFloat(style.maxHeight),
        Math.max(parseFloat(style.minHeight), input.scrollHeight + 1),
      ) + 'px';
    if (mirror) {
      // Match the text area, excluding a scrollbar when the four-line cap is reached.
      mirror.style.width = input.clientWidth + 'px';
      mirror.scrollTop = input.scrollTop;
    }
  }
  $effect(() => {
    value;
    void tick().then(resize);
  });
  function measure(node: HTMLElement) {
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
  async function choose(name: string) {
    if (!context || composing) return;
    const { start, kind } = context;
    let end = caret,
      inserted: string,
      position: number;
    if (kind === 'math') {
      end = caret + /^[A-Za-z0-9_]*/.exec(value.slice(caret))![0].length;
      const fn = Object.hasOwn(expressionFunctions, name);
      inserted = 'Math.' + name + (fn ? '()' : '');
      position = start + inserted.length - (fn ? 1 : 0);
    } else {
      const close = value.indexOf('}', caret);
      if (value.slice(start, start + 2) === '${' && close >= 0) end = close + 1;
      inserted = '${' + name + '}';
      position = start + inserted.length;
    }
    value = value.slice(0, start) + inserted + value.slice(end);
    caret = position;
    dismissed = true;
    forced = false;
    await tick();
    input?.focus();
    input?.setSelectionRange(position, position);
  }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.ctrlKey && event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      insertMetric();
      return;
    }
    if (open) {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const delta =
          event.key === 'ArrowDown'
            ? 1
            : event.key === 'ArrowUp'
              ? -1
              : event.key === 'PageDown'
                ? 8
                : -8;
        if (matches.length)
          active = (((active + delta) % matches.length) + matches.length) % matches.length;
      } else if ((event.key === 'Enter' || event.key === 'Tab') && matches.length) {
        event.preventDefault();
        event.stopPropagation();
        void choose(matches[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissed = true;
        forced = false;
      }
    }
    if (event.key === 'Enter') event.preventDefault();
  }
  function parts(name: string) {
    const ranges = highlightRanges(context?.query || '', name),
      slash = name.lastIndexOf('/');
    const boundaries = [...new Set([0, name.length, slash + 1, ...ranges.flat()])].sort(
      (a, b) => a - b,
    );
    return boundaries.slice(0, -1).map((start, i) => ({
      text: name.slice(start, boundaries[i + 1]),
      prefix: start <= slash,
      strong: ranges.some(([a, b]) => start >= a && start < b),
    }));
  }
</script>

<div class="bx--form-item bx--text-input-wrapper expression-input" use:measure>
  <label for={id} class="bx--label">{labelText}</label>
  <div class="expression-field" data-invalid={showError || undefined}>
    <div class="expression-mirror" bind:this={mirror} aria-hidden="true">
      {#each fragments as token}<span
          class={'token-' + token.type}
          class:is-unlogged={token.type === 'ref' && missing.includes(token.name!)}
          class:is-error={showError && token.start < errorEnd && token.end > errorStart}
          >{token.text}</span
        >{/each}{#if showError && errorStart >= value.length}<span class="end-error"></span>{/if}
    </div>
    <textarea
      bind:this={input}
      {id}
      bind:value
      rows="1"
      {placeholder}
      class="bx--text-input"
      class:bx--text-input--invalid={showError}
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      autocapitalize="off"
      {...{ autocorrect: 'off' }}
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={id + '-options'}
      aria-activedescendant={open && matches.length ? id + '-option-' + active : undefined}
      aria-invalid={showError || undefined}
      aria-describedby={[showError ? id + '-error' : '', missing.length ? id + '-warning' : '']
        .filter(Boolean)
        .join(' ') || undefined}
      use:imeKeys={{}}
      oninput={track}
      onclick={track}
      onselect={() => {
        if (input && caret !== input.selectionStart) track();
      }}
      onkeyup={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) track();
      }}
      onkeydown={keydown}
      onblur={() => {
        dismissed = true;
        touched = true;
      }}
      oncompositionstart={() => {
        composing = true;
      }}
      oncompositionend={() => {
        composing = false;
        track();
      }}
      onscroll={() => {
        if (mirror && input) mirror.scrollTop = input.scrollTop;
      }}
      onpaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain').replace(/[\r\n]+/g, ' ') || '';
        const start = input!.selectionStart,
          end = input!.selectionEnd;
        value = value.slice(0, start) + text + value.slice(end);
        caret = start + text.length;
        void tick().then(() => {
          input?.setSelectionRange(caret, caret);
          track();
        });
      }}></textarea>
    <Button
      class="expression-insert"
      kind="ghost"
      size="field"
      icon={Add}
      iconDescription={$t('charts.expressions.insertMetric')}
      tooltipPosition="left"
      on:mousedown={(event) => event.preventDefault()}
      on:click={insertMetric}
    />
  </div>
  <ul
    class="expression-options"
    bind:this={list}
    role="listbox"
    id={id + '-options'}
    aria-label={labelText}
    hidden={!open}
  >
    {#each open ? matches : [] as name, index (name)}<li
        id={id + '-option-' + index}
        role="option"
        aria-selected={index === active}
        class:active={index === active}
        onpointerdown={(event) => {
          event.preventDefault();
          void choose(name);
        }}
        onpointermove={() => (active = index)}
      >
        <span
          >{#if context?.kind === 'math'}Math.{/if}{#each parts(name) as part}<span
              class:metric-prefix={part.prefix}
              >{#if part.strong}<strong>{part.text}</strong>{:else}{part.text}{/if}</span
            >{/each}{#if context?.kind === 'math' && Object.hasOwn(expressionFunctions, name)}<span
              class="metric-prefix"
              >{expressionFunctions[name].max === 1
                ? '(x)'
                : expressionFunctions[name].max === 2
                  ? '(a, b)'
                  : '(a, b, …)'}</span
            >{/if}</span
        >
        {#if context?.kind === 'metric' && plotted.includes(name)}<span
            class="bx--label plotted"
            aria-hidden="true">{$t('charts.expressions.plotted')}</span
          >{/if}
      </li>{/each}
  </ul>
  {#if open && !matches.length}<p class="bx--form__helper-text">
      {$t(loading ? 'metrics.loading' : 'charts.expressions.noMatches')}
    </p>{/if}
  {#if showError}<div class="bx--form-requirement" id={id + '-error'}>{invalidText}</div>{/if}
  {#if missing.length}<div class="expression-warning bx--form__helper-text" id={id + '-warning'}>
      <WarningAltFilled size={16} /><span
        >{$t('charts.expressions.unlogged', { names: missing.join(', ') })}</span
      >
    </div>{/if}
  <span class="bx--assistive-text" role="status" aria-live="polite">{announcement}</span>
</div>

<style>
  .expression-input {
    position: relative;
    min-width: 0;
    width: 100%;
  }
  .expression-field {
    position: relative;
    width: 100%;
    background: var(--cds-field-02);
  }
  .expression-mirror,
  .expression-input .expression-field textarea.bx--text-input {
    margin: 0;
    width: 100%;
    padding: 10px 3rem 9px 1rem;
    font-family: var(--cds-code-02-font-family, 'IBM Plex Mono', monospace);
    font-size: 14px;
    line-height: 20px;
    letter-spacing: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
    border: 0;
    border-bottom: 1px solid transparent;
    box-sizing: border-box;
  }
  .expression-input .expression-field textarea.bx--text-input {
    position: relative;
    display: block;
    min-height: 40px;
    max-height: 100px;
    resize: none;
    color: transparent;
    caret-color: var(--cds-text-01);
    background: transparent;
    overflow-y: auto;
  }
  textarea::selection {
    background: var(--cds-highlight);
    color: var(--cds-text-01);
  }
  textarea::placeholder {
    color: var(--cds-text-03);
  }
  .expression-mirror {
    position: absolute;
    inset: 0;
    height: 100%;
    overflow: hidden;
    pointer-events: none;
    color: var(--cds-text-01);
  }
  .expression-field :global(.expression-insert) {
    position: absolute;
    right: 0;
    top: 0;
  }
  .token-ref,
  .token-ref-open {
    background: var(--cds-highlight);
    border-radius: 2px;
  }
  .token-ref-open {
    opacity: 0.6;
  }
  .token-math {
    color: var(--cds-text-02);
  }
  .is-unlogged {
    text-decoration: underline dotted var(--cds-support-warning);
    text-underline-offset: 3px;
  }
  .is-error {
    text-decoration: underline wavy var(--cds-support-error) 2px;
    text-underline-offset: 3px;
  }
  .end-error {
    display: inline-block;
    width: 0;
    position: relative;
  }
  .end-error::after {
    content: '';
    position: absolute;
    width: 0.6em;
    border-bottom: 2px solid var(--cds-support-error);
    bottom: -3px;
  }
  .expression-options {
    z-index: 9100;
    position: relative;
    width: 100%;
    max-height: min(16rem, 40vh);
    overflow-y: auto;
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--cds-field-01, var(--cds-ui-01));
    box-shadow: 0 2px 6px rgb(0 0 0 / 30%);
  }
  .expression-options[hidden] {
    display: none;
  }
  .expression-options li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.6875rem 1rem;
    font-size: 0.875rem;
    line-height: 1.125rem;
    color: var(--cds-text-01);
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .expression-options li.active {
    background: var(--cds-hover-ui);
  }
  .metric-prefix {
    color: var(--cds-text-02);
  }
  .plotted {
    flex: none;
    margin: 0;
  }
  .bx--form-requirement {
    display: block;
    max-height: none;
    overflow: visible;
    color: var(--cds-text-error);
    overflow-wrap: anywhere;
  }
  .expression-warning {
    display: flex;
    gap: 0.5rem;
    color: var(--cds-text-02);
  }
  .expression-warning > span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .expression-warning :global(svg) {
    color: var(--cds-support-warning);
    flex: none;
  }
  @media (max-width: 671px) {
    .expression-field :global(.expression-insert) {
      min-width: 48px;
      height: 48px;
    }
    .expression-mirror,
    .expression-input .expression-field textarea.bx--text-input {
      padding-top: 14px;
      padding-bottom: 13px;
    }
    .expression-input .expression-field textarea.bx--text-input {
      min-height: 48px;
      max-height: 108px;
    }
  }
</style>
